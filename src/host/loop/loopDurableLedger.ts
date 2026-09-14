// ============================================================================
// Loop durable 账本 — N-LOOP-DURABLE-K2 刀2-b / RQ-125
//
// LoopController 仍是内存执行器。本模块给 /loop 补 durable 事实源（照抄
// BackgroundSubagentDurableLedger 的 begin/finalize/track/arm+configure+waitFor
// 形态）。刀2-c：恢复后 `adopt()` 把认领到的 owner/attempt 接回 liveRuns，心跳
// 与每轮 checkpoint 继续由本账本驱动。
//
//   1. start 时：run_id = loop id（loop_<uuid>），engine_kind='loop'，
//      parent_run_id 必须带（前台 run 血缘，不占活跃根唯一位）。落账完成才允许
//      进 runLoop——不落账不花钱。parentRunId 取不到 → fail-closed，不降级。
//   2. 每轮双 checkpoint：dispatch 前 operation dispatched + phase=dispatching；
//      reply 处理完 operation succeeded + turn/nextRunAt/phase=sleeping。
//   3. 终态：先 checkpoint 收掉未决 operation，再 terminal。
//   4. 心跳按租约 1/3 间隔。落账 fail-closed：checkpoint 失败（fence 或本地
//      持久化故障）即停写停心跳并向上抛，LoopController 收到后立刻收口 failed，
//      不许吞了继续跑未记录轮次——落账失败即不花钱。
//
// 开关：assembleDurableRun 在 durable 激活时 arm，configureDurableKernel 时
// configure；legacy 永不 arm。
// ============================================================================

import type { PendingOperation, RunOwnerLease } from '../../shared/contract/durableRun';
import { LOOP_DURABLE_PARENT_MISSING_CODE } from '../../shared/contract/loop';
import { SERVICE_TIMEOUTS } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import {
  DurableRunPersistenceUnavailableError,
  type RunKernelAdapter,
} from '../runtime/durableRunKernel';

const logger = createLogger('LoopDurableLedger');

export const LOOP_INTERRUPTED_REASON = 'interrupted_by_restart';
export { LOOP_DURABLE_PARENT_MISSING_CODE };

export class LoopDurableStartError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LoopDurableStartError';
    this.code = code;
  }
}

const LOOP_DURABLE_LEDGER_LOST_CODE = 'LOOP_DURABLE_LEDGER_LOST';

/** durable loop 的账本已失联（fence 或持久化故障后 untrack）：拒绝再跑未记录轮次。 */
export class LoopDurableLedgerLostError extends Error {
  readonly code = LOOP_DURABLE_LEDGER_LOST_CODE;

  constructor(loopId: string) {
    super(`Durable ledger lost for ${loopId}; refusing to spend untracked loop turns`);
    this.name = 'LoopDurableLedgerLostError';
  }
}

interface LoopDurableConfigSnapshot {
  prompt: string;
  intervalMs?: number;
  maxTurns: number;
  until?: string;
  handoffPrompt?: string;
}

export interface LoopEngineCursor {
  schemaVersion: 1;
  kind: 'loop';
  config: LoopDurableConfigSnapshot;
  turn: number;
  lastTurnAt?: number;
  nextRunAt?: number;
  phase: 'dispatching' | 'awaiting_reply' | 'sleeping';
}

export interface LoopDurableBeginInput {
  loopId: string;
  sessionId: string;
  /** 前台 run id。必填：缺了会占活跃根唯一位，顶死普通对话 turn。 */
  parentRunId: string;
  config: LoopDurableConfigSnapshot;
  startedAt: number;
}

export interface LoopDurableTurnInput {
  turn: number;
  cursor: LoopEngineCursor;
  now?: number;
  done?: boolean;
  waitMs?: number;
}

export interface LoopDurableFinalizeInput {
  outcome: 'completed' | 'failed' | 'cancelled';
  reason?: string;
  turn: number;
  cursor: LoopEngineCursor;
  finishedAt: number;
}

/** 恢复认领后把新 owner/attempt 接回账本，heartbeat / checkpoint / finalize 才能继续写。 */
export interface LoopAdoptLedgerContext {
  owner: RunOwnerLease;
  attempt: number;
}

export function readLoopEngineCursor(cursor: unknown): LoopEngineCursor | null {
  if (!cursor || typeof cursor !== 'object') return null;
  const candidate = cursor as Partial<LoopEngineCursor>;
  if (candidate.schemaVersion !== 1 || candidate.kind !== 'loop') return null;
  if (typeof candidate.turn !== 'number' || !candidate.config || typeof candidate.config.prompt !== 'string') {
    return null;
  }
  if (candidate.phase !== 'dispatching' && candidate.phase !== 'awaiting_reply' && candidate.phase !== 'sleeping') {
    return null;
  }
  return candidate as LoopEngineCursor;
}

function loopTurnOperationId(turn: number): string {
  return `loop-turn-${turn}`;
}

interface LiveRun {
  owner: RunOwnerLease;
  attempt: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

export class LoopDurableLedger {
  private readonly liveRuns = new Map<string, LiveRun>();

  constructor(private readonly kernel: RunKernelAdapter) {}

  /** 落 running 行。resolve 即「落账完成，可以开始花钱」。 */
  async begin(input: LoopDurableBeginInput): Promise<void> {
    const now = Date.now();
    const cursor: LoopEngineCursor = {
      schemaVersion: 1,
      kind: 'loop',
      config: input.config,
      turn: 0,
      phase: 'sleeping',
    };
    const created = await this.kernel.createRun({
      runId: input.loopId,
      sessionId: input.sessionId,
      engine: { kind: 'loop' },
      parentRunId: input.parentRunId,
      now,
      initialEngineCursor: cursor,
      initialPendingOperations: [],
    });
    this.track(input.loopId, created.owner, created.attempt.attempt, now);
  }

  async turnDispatched(loopId: string, input: LoopDurableTurnInput): Promise<void> {
    const live = this.liveRuns.get(loopId);
    if (!live) throw new LoopDurableLedgerLostError(loopId);
    const now = input.now ?? Date.now();
    const operation = {
      ...this.kernel.prepareOperation({
        runId: loopId,
        operationId: loopTurnOperationId(input.turn),
        logicalOperationId: loopTurnOperationId(input.turn),
        attempt: live.attempt,
        kind: 'model_call',
        sideEffect: true,
        canDeduplicate: false,
        now,
      }),
      status: 'dispatched' as const,
    };
    try {
      await this.kernel.checkpoint({
        runId: loopId,
        attempt: live.attempt,
        owner: live.owner,
        now,
        status: 'running',
        state: input.cursor,
        engineCursor: input.cursor,
        pendingOperations: [operation],
        events: [{
          type: 'loop_turn_dispatched',
          payload: { turn: input.turn },
          recordedAt: now,
        }],
      });
    } catch (error) {
      // fence（owner 易主，另一方在续跑）或本地持久化故障：立刻停写停心跳，
      // 错误上抛给 LoopController 收口终止——不许吞了继续产生未记录轮次。
      this.untrack(loopId);
      throw error;
    }
  }

  async turnCompleted(loopId: string, input: LoopDurableTurnInput): Promise<void> {
    const live = this.liveRuns.get(loopId);
    if (!live) throw new LoopDurableLedgerLostError(loopId);
    const now = input.now ?? Date.now();
    const operation = {
      ...this.kernel.prepareOperation({
        runId: loopId,
        operationId: loopTurnOperationId(input.turn),
        logicalOperationId: loopTurnOperationId(input.turn),
        attempt: live.attempt,
        kind: 'model_call',
        sideEffect: true,
        canDeduplicate: false,
        now,
      }),
      status: 'succeeded' as const,
      updatedAt: now,
    };
    try {
      await this.kernel.checkpoint({
        runId: loopId,
        attempt: live.attempt,
        owner: live.owner,
        now,
        status: 'running',
        state: input.cursor,
        engineCursor: input.cursor,
        pendingOperations: [operation],
        events: [{
          type: 'loop_turn_completed',
          payload: {
            turn: input.turn,
            ...(input.done !== undefined ? { done: input.done } : {}),
            ...(input.waitMs !== undefined ? { waitMs: input.waitMs } : {}),
          },
          recordedAt: now,
        }],
      });
    } catch (error) {
      this.untrack(loopId);
      throw error;
    }
  }

  /**
   * 收成终态：先 checkpoint 把当轮未决 operation 收掉（completed 断言要求无未决
   * operation），再 terminal。heartbeat 已被 fence 的 run 直接放弃写。
   */
  async finalize(loopId: string, input: LoopDurableFinalizeInput): Promise<void> {
    const live = this.liveRuns.get(loopId);
    if (!live) return;
    const now = input.finishedAt;
    const operationStatus: PendingOperation['status'] = input.outcome === 'completed'
      ? 'succeeded'
      : input.outcome === 'cancelled' ? 'abandoned' : 'failed';
    const pendingOperations = input.turn > 0
      ? [{
        ...this.kernel.prepareOperation({
          runId: loopId,
          operationId: loopTurnOperationId(input.turn),
          logicalOperationId: loopTurnOperationId(input.turn),
          attempt: live.attempt,
          kind: 'model_call' as const,
          sideEffect: true,
          canDeduplicate: false,
          now,
        }),
        status: operationStatus,
        updatedAt: now,
      }]
      : [];
    const outcomePayload = {
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
      turn: input.turn,
    };
    try {
      await this.kernel.checkpoint({
        runId: loopId,
        attempt: live.attempt,
        owner: live.owner,
        now,
        status: 'running',
        state: input.cursor,
        engineCursor: input.cursor,
        pendingOperations,
        events: [{ type: 'loop_terminal', payload: outcomePayload, recordedAt: now }],
      });
      await this.kernel.terminal({
        runId: loopId,
        attempt: live.attempt,
        owner: live.owner,
        now,
        status: input.outcome,
        ...(input.reason ? { reason: input.reason } : {}),
        event: {
          type: `loop_${input.outcome}`,
          payload: outcomePayload,
          recordedAt: now,
        },
      });
    } catch (error) {
      logger.warn(`loop durable finalize stopped for ${loopId}:`, error);
    }
    this.untrack(loopId);
  }

  isTracked(loopId: string): boolean {
    return this.liveRuns.has(loopId);
  }

  /** 恢复续跑：用认领后的 lease 接回心跳，不 createRun。 */
  adopt(loopId: string, ctx: LoopAdoptLedgerContext, now = Date.now()): void {
    this.track(loopId, ctx.owner, ctx.attempt, now);
  }

  dispose(): void {
    for (const loopId of [...this.liveRuns.keys()]) this.untrack(loopId);
  }

  private track(loopId: string, owner: RunOwnerLease, attempt: number, now: number): void {
    this.untrack(loopId);
    const live: LiveRun = { owner, attempt };
    const intervalMs = Math.max(250, Math.floor((owner.leaseExpiresAt - now) / 3));
    const timer = setInterval(() => {
      void this.kernel.heartbeat(loopId, live.owner, Date.now()).then(
        (renewed) => {
          live.owner = renewed;
        },
        (error: unknown) => {
          logger.warn(`loop durable heartbeat stopped for ${loopId}:`, error);
          this.untrack(loopId);
        },
      );
    }, intervalMs);
    timer.unref?.();
    live.heartbeatTimer = timer;
    this.liveRuns.set(loopId, live);
  }

  private untrack(loopId: string): void {
    const live = this.liveRuns.get(loopId);
    if (!live) return;
    clearInterval(live.heartbeatTimer);
    this.liveRuns.delete(loopId);
  }
}

let configured: LoopDurableLedger | null = null;
let armed = false;
let configureWaiters: Array<(ledger: LoopDurableLedger | null) => void> = [];

export function armLoopDurableLedger(): void {
  armed = true;
}

export function configureLoopDurableLedger(ledger: LoopDurableLedger | null): void {
  configured = ledger;
  const waiters = configureWaiters;
  configureWaiters = [];
  for (const resolve of waiters) resolve(ledger);
}

export function getLoopDurableLedger(): LoopDurableLedger | null {
  return configured;
}

export function isLoopDurableArmed(): boolean {
  return armed;
}

/** 测试用 / legacy 组装：回到未 arm、未 configure 的初始态。 */
export function resetLoopDurableLedger(): void {
  configured?.dispose();
  configured = null;
  armed = false;
  const waiters = configureWaiters;
  configureWaiters = [];
  for (const resolve of waiters) resolve(null);
}

/**
 * armed 但 kernel 尚未就绪（冷启动窗口）时等 configure；超时仍没有账本则
 * fail-closed——durable 模式下宁可让这次 /loop 失败，也不让它落不进账本。
 */
export function waitForLoopDurableLedger(
  timeoutMs: number = SERVICE_TIMEOUTS.BOOTSTRAP,
): Promise<LoopDurableLedger> {
  if (configured) return Promise.resolve(configured);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      configureWaiters = configureWaiters.filter((waiter) => waiter !== onConfigured);
      reject(new DurableRunPersistenceUnavailableError());
    }, timeoutMs);
    timer.unref?.();
    const onConfigured = (ledger: LoopDurableLedger | null) => {
      clearTimeout(timer);
      if (ledger) resolve(ledger);
      else reject(new DurableRunPersistenceUnavailableError());
    };
    configureWaiters.push(onConfigured);
  });
}
