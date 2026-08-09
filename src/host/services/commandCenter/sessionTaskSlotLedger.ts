import {
  SESSION_TASK_CONCURRENCY,
  SESSION_TASK_LANE_LIMIT,
} from '../../../shared/constants/voice';

type SessionTaskSlotStatus = 'queued' | 'running' | 'settled';
type SessionTaskTerminalStatus = 'completed' | 'failed' | 'cancelled';

export interface SessionTaskSlotInput {
  workItemId: string;
  sessionId: string;
  laneKey: string;
  submissionKey: string;
}

export interface SessionTaskSlot extends SessionTaskSlotInput {
  status: SessionTaskSlotStatus;
  attempt: number;
  terminalStatus?: SessionTaskTerminalStatus;
}

export type SessionTaskAdmission =
  | { outcome: 'started'; slot: SessionTaskSlot }
  | { outcome: 'queued'; slot: SessionTaskSlot; reason: 'lane_busy' | 'capacity' }
  | { outcome: 'reused'; slot: SessionTaskSlot }
  | { outcome: 'requires_choice'; reason: 'capacity'; activeIds: string[] };

/** Global pool shared by text and realtime-voice command centers. */
export class SessionTaskConcurrencyPool {
  private readonly runningIds = new Set<string>();

  constructor(readonly globalLimit = SESSION_TASK_CONCURRENCY.global) {}

  hasCapacity(): boolean {
    return this.runningIds.size < this.globalLimit;
  }

  acquire(workItemId: string): boolean {
    if (this.runningIds.has(workItemId)) return true;
    if (!this.hasCapacity()) return false;
    this.runningIds.add(workItemId);
    return true;
  }

  release(workItemId: string): void {
    this.runningIds.delete(workItemId);
  }

  runningCount(): number {
    return this.runningIds.size;
  }
}

export class SessionTaskSlotLedger {
  private readonly slots = new Map<string, SessionTaskSlot>();
  private readonly workItemIdBySubmissionKey = new Map<string, string>();
  private readonly attemptsBySubmissionKey = new Map<string, number>();
  private readonly queue: string[] = [];

  constructor(
    readonly sessionId: string,
    private readonly pool: SessionTaskConcurrencyPool,
    private readonly perSessionLimit = SESSION_TASK_CONCURRENCY.perSession,
    private readonly laneLimit = SESSION_TASK_LANE_LIMIT,
  ) {}

  admit(input: SessionTaskSlotInput, options: { queueWhenFull?: boolean } = {}): SessionTaskAdmission {
    const reusedId = this.workItemIdBySubmissionKey.get(input.submissionKey);
    const reused = reusedId ? this.slots.get(reusedId) : undefined;
    if (reused && !this.canRetry(reused)) return { outcome: 'reused', slot: { ...reused } };

    const slot: SessionTaskSlot = {
      ...input,
      status: 'queued',
      attempt: (this.attemptsBySubmissionKey.get(input.submissionKey) ?? 0) + 1,
    };

    if (this.runningInLane(slot.laneKey) >= this.laneLimit) {
      this.track(slot);
      this.queue.push(slot.workItemId);
      return { outcome: 'queued', slot: { ...slot }, reason: 'lane_busy' };
    }

    if (!this.hasSessionCapacity() || !this.pool.hasCapacity()) {
      if (options.queueWhenFull) {
        this.track(slot);
        this.queue.push(slot.workItemId);
        return { outcome: 'queued', slot: { ...slot }, reason: 'capacity' };
      }
      return {
        outcome: 'requires_choice',
        reason: 'capacity',
        activeIds: this.running().map((active) => active.workItemId),
      };
    }

    this.track(slot);
    this.start(slot);
    return { outcome: 'started', slot: { ...slot } };
  }

  // terminalStatus 刻意**没有默认值**：这个账本用终态决定同一 submissionKey 还能不能重试，
  // 默认成 'completed' 就等于「没传参数就当成功」——失败会被记成成功、且从此不可重试，
  // 正是这条改动要消灭的那种谎。设成必填让 tsc 逼每个调用点表态。
  settle(workItemId: string, terminalStatus: SessionTaskTerminalStatus): SessionTaskSlot[] {
    const slot = this.slots.get(workItemId);
    if (!slot || slot.status === 'settled') return [];
    if (slot.status === 'running') this.pool.release(workItemId);
    slot.status = 'settled';
    slot.terminalStatus = terminalStatus;
    const queuedIndex = this.queue.indexOf(workItemId);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    return this.drainStartable();
  }

  get(workItemId: string): SessionTaskSlot | undefined {
    const slot = this.slots.get(workItemId);
    return slot ? { ...slot } : undefined;
  }

  running(): SessionTaskSlot[] {
    return [...this.slots.values()]
      .filter((slot) => slot.status === 'running')
      .map((slot) => ({ ...slot }));
  }

  queued(): SessionTaskSlot[] {
    return this.queue
      .map((workItemId) => this.slots.get(workItemId))
      .filter((slot): slot is SessionTaskSlot => Boolean(slot))
      .map((slot) => ({ ...slot }));
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      if (slot.status === 'running') this.pool.release(slot.workItemId);
      slot.status = 'settled';
    }
    this.queue.length = 0;
  }

  private hasSessionCapacity(): boolean {
    return this.running().length < this.perSessionLimit;
  }

  private runningInLane(laneKey: string): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.status === 'running' && slot.laneKey === laneKey) count += 1;
    }
    return count;
  }

  private start(slot: SessionTaskSlot): void {
    if (!this.pool.acquire(slot.workItemId)) return;
    slot.status = 'running';
  }

  private track(slot: SessionTaskSlot): void {
    this.slots.set(slot.workItemId, slot);
    this.workItemIdBySubmissionKey.set(slot.submissionKey, slot.workItemId);
    this.attemptsBySubmissionKey.set(slot.submissionKey, slot.attempt);
  }

  private canRetry(slot: SessionTaskSlot): boolean {
    return slot.status === 'settled'
      && (slot.terminalStatus === 'failed' || slot.terminalStatus === 'cancelled');
  }

  private drainStartable(): SessionTaskSlot[] {
    const started: SessionTaskSlot[] = [];
    for (let index = 0; index < this.queue.length;) {
      if (!this.hasSessionCapacity() || !this.pool.hasCapacity()) break;
      const workItemId = this.queue[index];
      const slot = this.slots.get(workItemId);
      if (slot?.status !== 'queued') {
        this.queue.splice(index, 1);
        continue;
      }
      if (this.runningInLane(slot.laneKey) >= this.laneLimit) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      this.start(slot);
      started.push({ ...slot });
    }
    return started;
  }
}

let globalPool: SessionTaskConcurrencyPool | null = null;

export function getSessionTaskConcurrencyPool(): SessionTaskConcurrencyPool {
  if (!globalPool) globalPool = new SessionTaskConcurrencyPool();
  return globalPool;
}

export function resetSessionTaskConcurrencyPoolForTest(): void {
  globalPool = null;
}
