import {
  SESSION_TASK_CONCURRENCY,
  SESSION_TASK_LANE_LIMIT,
} from '../../../shared/constants/voice';

export type VoiceTaskSlotStatus = 'queued' | 'running' | 'settled';

export interface VoiceTaskSlotInput {
  workItemId: string;
  sessionId: string;
  laneKey: string;
  submissionKey: string;
}

export interface VoiceTaskSlot extends VoiceTaskSlotInput {
  status: VoiceTaskSlotStatus;
}

export type VoiceTaskAdmission =
  | { outcome: 'started'; slot: VoiceTaskSlot }
  | { outcome: 'queued'; slot: VoiceTaskSlot; reason: 'lane_busy' | 'capacity' }
  | { outcome: 'reused'; slot: VoiceTaskSlot }
  | { outcome: 'requires_choice'; reason: 'capacity'; activeIds: string[] };

/**
 * 跨会话共享的全局槽池。语音当前虽是单通话互斥，仍把 global 做成真实共享计数，
 * 避免以后放开多通话时每个账本都误以为自己还能再开四个。
 */
export class VoiceTaskConcurrencyPool {
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

export class VoiceTaskSlotLedger {
  private readonly slots = new Map<string, VoiceTaskSlot>();
  private readonly workItemIdBySubmissionKey = new Map<string, string>();
  private readonly queue: string[] = [];

  constructor(
    readonly sessionId: string,
    private readonly pool: VoiceTaskConcurrencyPool,
    private readonly perSessionLimit = SESSION_TASK_CONCURRENCY.perSession,
    private readonly laneLimit = SESSION_TASK_LANE_LIMIT,
  ) {}

  admit(input: VoiceTaskSlotInput, options: { queueWhenFull?: boolean } = {}): VoiceTaskAdmission {
    const reusedId = this.workItemIdBySubmissionKey.get(input.submissionKey);
    const reused = reusedId ? this.slots.get(reusedId) : undefined;
    if (reused) return { outcome: 'reused', slot: { ...reused } };

    const slot: VoiceTaskSlot = { ...input, status: 'queued' };
    this.slots.set(slot.workItemId, slot);
    this.workItemIdBySubmissionKey.set(slot.submissionKey, slot.workItemId);

    if (this.runningInLane(slot.laneKey) >= this.laneLimit) {
      this.queue.push(slot.workItemId);
      return { outcome: 'queued', slot: { ...slot }, reason: 'lane_busy' };
    }

    if (!this.hasSessionCapacity() || !this.pool.hasCapacity()) {
      if (options.queueWhenFull) {
        this.queue.push(slot.workItemId);
        return { outcome: 'queued', slot: { ...slot }, reason: 'capacity' };
      }
      this.slots.delete(slot.workItemId);
      this.workItemIdBySubmissionKey.delete(slot.submissionKey);
      return {
        outcome: 'requires_choice',
        reason: 'capacity',
        activeIds: this.running().map((active) => active.workItemId),
      };
    }

    this.start(slot);
    return { outcome: 'started', slot: { ...slot } };
  }

  settle(workItemId: string): VoiceTaskSlot[] {
    const slot = this.slots.get(workItemId);
    if (!slot || slot.status === 'settled') return [];
    if (slot.status === 'running') this.pool.release(workItemId);
    slot.status = 'settled';
    const queuedIndex = this.queue.indexOf(workItemId);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    return this.drainStartable();
  }

  get(workItemId: string): VoiceTaskSlot | undefined {
    const slot = this.slots.get(workItemId);
    return slot ? { ...slot } : undefined;
  }

  running(): VoiceTaskSlot[] {
    return [...this.slots.values()]
      .filter((slot) => slot.status === 'running')
      .map((slot) => ({ ...slot }));
  }

  queued(): VoiceTaskSlot[] {
    return this.queue
      .map((workItemId) => this.slots.get(workItemId))
      .filter((slot): slot is VoiceTaskSlot => Boolean(slot))
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

  private start(slot: VoiceTaskSlot): void {
    if (!this.pool.acquire(slot.workItemId)) return;
    slot.status = 'running';
  }

  private drainStartable(): VoiceTaskSlot[] {
    const started: VoiceTaskSlot[] = [];
    for (let index = 0; index < this.queue.length;) {
      if (!this.hasSessionCapacity() || !this.pool.hasCapacity()) break;
      const workItemId = this.queue[index];
      const slot = this.slots.get(workItemId);
      if (!slot || slot.status !== 'queued') {
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

let globalPool: VoiceTaskConcurrencyPool | null = null;

export function getVoiceTaskConcurrencyPool(): VoiceTaskConcurrencyPool {
  if (!globalPool) globalPool = new VoiceTaskConcurrencyPool();
  return globalPool;
}

export function resetVoiceTaskConcurrencyPoolForTest(): void {
  globalPool = null;
}
