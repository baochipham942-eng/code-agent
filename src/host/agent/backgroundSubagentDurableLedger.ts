// ============================================================================
// 后台单子代理 durable 账本 — N-BGSPAWN-DURABLE(RQ-101) / ADR-025 B1 + ADR-037
//
// backgroundSubagentRegistry 原本是纯进程内内存：App 崩溃 / 更新重启后，在跑的
// 后台子代理连同已花成本一起蒸发，父会话也不知道。本模块给 spawn/adopt 两条
// 路径补 durable 事实源（抄 N-LOOP-DURABLE 刀1 的「启动收口」语义，不做断点
// 续跑——A2 不在本卡范围）：
//
//   1. spawn 时：run_id = agent_id（持久随机 id），engine_kind='subagent_single'
//      落 durable_runs 行 + 一条 dispatched 的 child_run pending operation
//     （幂等键由 kernel 按 runId+kind+logicalOperationId 派生，跨进程稳定）。
//      子代理实际执行前先等落账完成——不落账就不花钱；durable 模式账本一直不
//      就绪则 fail-closed（与 DurableRunKernel 的拒绝执行哲学一致）。
//   2. 完成时：checkpoint 把 launch operation 收成 succeeded/failed/abandoned，
//      再 terminal 成 completed/failed/cancelled（completed 的 envelope 断言
//      不允许未决 operation，所以必须先 checkpoint）。
//   3. 进程重启：残留 running 的行被 recoverOnStartup 认领后由
//      createBackgroundSubagentRecoveryHandler 收口成 failed/interrupted_by_restart
//      并向父会话投影中断事实（见 durableRecoveryHandlers.ts）。
//
// 运行期间按租约 1/3 间隔 heartbeat，否则 sweeper 会在租约到期后把还在跑的
// 子代理认领走并误收成 interrupted。同一计时器顺带把节流后的进度快照写进
// engineCursor（N-BGSPAWN-REPORT-COST）：被杀死的进程仍能报出已花成本和最后
// 进度。heartbeat 被 fence（owner 易主）后停止写账本——之后的 terminal 必然被
// fence，留给收口路径处理。进度 checkpoint 失败只记日志，不停心跳、不打断子代理。
// finalize 一开始就把 live run 标成 finalizing：心跳仍可续租，但 flushProgress
// 必须跳过。否则进度 checkpoint 会插在收口 checkpoint 和 terminal 之间，用
// dispatched 的 launch operation 盖掉已经 succeeded 的那笔，terminal(completed)
// 被 assertRunEnvelope 拒绝，正常完成的子代理下次重启被误报成 interrupted。
//
// 开关语义：assembleDurableRun 在 durable 激活且 kernel 配置成功后 arm（配置在
// configureDurableKernel 里完成，assemble 全程同步）；legacy 模式或初始化失败时
// 两者都不发生，registry 走纯内存，行为与改造前一致。
// ============================================================================

import type { PendingOperation, RunOwnerLease } from '../../shared/contract/durableRun';
import { SERVICE_TIMEOUTS } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import {
  DurableRunPersistenceUnavailableError,
  type RunKernelAdapter,
} from '../runtime/durableRunKernel';
import type { SubagentCompletionKind } from './subagentCompletionNotification';

const logger = createLogger('BackgroundSubagentDurableLedger');

export const BACKGROUND_SUBAGENT_INTERRUPTED_REASON = 'interrupted_by_restart';

const BACKGROUND_EXECUTION_OPERATION_ID = 'background-execution';
const PROGRESS_TEXT_LIMIT = 300;
const PROGRESS_FLUSH_MIN_INTERVAL_MS = 5_000;

export interface BackgroundSubagentCursorMetadata {
  schemaVersion: 1;
  kind: 'background_subagent_single';
  title?: string;
  role?: string;
  treeId?: string;
  completionKind?: SubagentCompletionKind;
  startedAt: number;
  cost?: number;
  tokensUsed?: number;
  iterations?: number;
  toolCalls?: number;
  /** 最近一条助手正文或工具步标签，最长 300 字。 */
  lastProgress?: string;
}

export interface BackgroundSubagentProgressSnapshot {
  cost?: number;
  tokensUsed?: number;
  iterations?: number;
  toolCalls?: number;
  lastProgress?: string;
}

export interface BackgroundSubagentDurableBeginInput {
  /** 持久 agent_id，同时作为 durable run_id。 */
  agentId: string;
  sessionId: string;
  /** 父 turn 的 run id（envelope.parentRunId，只做血缘记录，不占活跃根 run 唯一位）。 */
  parentRunId?: string;
  title?: string;
  role?: string;
  treeId?: string;
  completionKind?: SubagentCompletionKind;
  startedAt: number;
}

export interface BackgroundSubagentDurableFinalizeInput {
  outcome: 'completed' | 'failed' | 'cancelled';
  reason?: string;
  cost?: number;
  tokensUsed?: number;
  iterations?: number;
  finishedAt: number;
}

export function readBackgroundSubagentCursorMetadata(
  cursor: unknown,
): BackgroundSubagentCursorMetadata | null {
  if (!cursor || typeof cursor !== 'object') return null;
  const candidate = cursor as Partial<BackgroundSubagentCursorMetadata>;
  if (candidate.schemaVersion !== 1 || candidate.kind !== 'background_subagent_single') return null;
  if (typeof candidate.startedAt !== 'number') return null;
  const completionKind = candidate.completionKind === 'user_visible'
    || candidate.completionKind === 'internal'
    || candidate.completionKind === 'shell'
    ? candidate.completionKind
    : undefined;
  const lastProgress = typeof candidate.lastProgress === 'string'
    ? clipProgressText(candidate.lastProgress)
    : undefined;
  const cost = finiteNumber(candidate.cost);
  const tokensUsed = finiteNumber(candidate.tokensUsed);
  const iterations = finiteNumber(candidate.iterations);
  const toolCalls = finiteNumber(candidate.toolCalls);
  return {
    schemaVersion: 1,
    kind: 'background_subagent_single',
    startedAt: candidate.startedAt,
    ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
    ...(typeof candidate.role === 'string' ? { role: candidate.role } : {}),
    ...(typeof candidate.treeId === 'string' ? { treeId: candidate.treeId } : {}),
    ...(completionKind ? { completionKind } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(lastProgress ? { lastProgress } : {}),
  };
}

interface LiveRun {
  owner: RunOwnerLease;
  attempt: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  metadata: BackgroundSubagentCursorMetadata;
  pendingOperation: PendingOperation;
  pendingSnapshot?: BackgroundSubagentProgressSnapshot;
  lastFlushedFingerprint?: string;
  lastFlushAt?: number;
  /** finalize 已开始。进度 flush 必须跳过；心跳续租不受影响。 */
  finalizing: boolean;
}

export class BackgroundSubagentDurableLedger {
  private readonly liveRuns = new Map<string, LiveRun>();
  private readonly queuedSnapshots = new Map<string, BackgroundSubagentProgressSnapshot>();

  constructor(private readonly kernel: RunKernelAdapter) {}

  /** 落 running 行 + dispatched launch operation。resolve 即「落账完成，可以开始花钱」。 */
  async begin(input: BackgroundSubagentDurableBeginInput): Promise<void> {
    const now = Date.now();
    const launchOperation = {
      ...this.kernel.prepareOperation({
        runId: input.agentId,
        operationId: BACKGROUND_EXECUTION_OPERATION_ID,
        logicalOperationId: `background-subagent:${input.agentId}`,
        attempt: 1,
        kind: 'child_run',
        sideEffect: true,
        canDeduplicate: false,
        now,
      }),
      status: 'dispatched' as const,
    };
    const metadata: BackgroundSubagentCursorMetadata = {
      schemaVersion: 1,
      kind: 'background_subagent_single',
      ...(input.title ? { title: input.title } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.treeId ? { treeId: input.treeId } : {}),
      ...(input.completionKind ? { completionKind: input.completionKind } : {}),
      startedAt: input.startedAt,
    };
    const created = await this.kernel.createRun({
      runId: input.agentId,
      sessionId: input.sessionId,
      engine: { kind: 'subagent_single' },
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      now,
      initialEngineCursor: metadata,
      initialPendingOperations: [launchOperation],
    });
    this.track(input.agentId, created.owner, created.attempt.attempt, now, metadata, launchOperation);
  }

  /**
   * 记下运行中的花费和进度。只改内存；同一条 heartbeat 计时器再节流写 checkpoint。
   * 没有 live run 时先排队，begin/track 接上后并入。从不抛错。
   */
  noteProgress(agentId: string, snapshot: BackgroundSubagentProgressSnapshot): void {
    const normalized = normalizeProgressSnapshot(snapshot);
    if (!normalized) return;
    const live = this.liveRuns.get(agentId);
    if (!live) {
      this.queuedSnapshots.set(agentId, mergeProgressSnapshot(this.queuedSnapshots.get(agentId), normalized));
      const liveNow = this.liveRuns.get(agentId);
      if (!liveNow) return;
      const queued = this.queuedSnapshots.get(agentId);
      this.queuedSnapshots.delete(agentId);
      if (queued) liveNow.pendingSnapshot = mergeProgressSnapshot(liveNow.pendingSnapshot, queued);
      return;
    }
    live.pendingSnapshot = mergeProgressSnapshot(live.pendingSnapshot, normalized);
  }

  /**
   * 收成终态：先 checkpoint 把 launch operation 收掉（completed 断言要求无未决
   * operation），再 terminal。进入本方法后立刻标 finalizing，心跳可以续租，
   * 但不得再刷进度。heartbeat 已被 fence 的 run 直接放弃写——写了也会被 owner
   * epoch 挡住，交给启动/sweeper 收口。
   */
  async finalize(agentId: string, input: BackgroundSubagentDurableFinalizeInput): Promise<void> {
    const live = this.liveRuns.get(agentId);
    if (!live) return;
    live.finalizing = true;
    const now = input.finishedAt;
    const operationStatus: PendingOperation['status'] = input.outcome === 'completed'
      ? 'succeeded'
      : input.outcome === 'cancelled' ? 'abandoned' : 'failed';
    const resolvedOperation = {
      ...this.kernel.prepareOperation({
        runId: agentId,
        operationId: BACKGROUND_EXECUTION_OPERATION_ID,
        logicalOperationId: `background-subagent:${agentId}`,
        attempt: live.attempt,
        kind: 'child_run',
        sideEffect: true,
        canDeduplicate: false,
        now,
      }),
      status: operationStatus,
      updatedAt: now,
    };
    const outcomePayload = {
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.cost !== undefined ? { cost: input.cost } : {}),
      ...(input.tokensUsed !== undefined ? { tokensUsed: input.tokensUsed } : {}),
      ...(input.iterations !== undefined ? { iterations: input.iterations } : {}),
    };
    await this.kernel.checkpoint({
      runId: agentId,
      attempt: live.attempt,
      owner: live.owner,
      now,
      status: 'running',
      state: {
        schemaVersion: 1,
        kind: 'background_subagent_single',
        finishedAt: now,
        ...outcomePayload,
      },
      pendingOperations: [resolvedOperation],
      events: [{ type: 'background_subagent_outcome', payload: outcomePayload, recordedAt: now }],
    });
    await this.kernel.terminal({
      runId: agentId,
      attempt: live.attempt,
      owner: live.owner,
      now,
      status: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
      event: {
        type: `background_subagent_${input.outcome}`,
        payload: outcomePayload,
        recordedAt: now,
      },
    });
    this.untrack(agentId);
  }

  private track(
    agentId: string,
    owner: RunOwnerLease,
    attempt: number,
    now: number,
    metadata: BackgroundSubagentCursorMetadata,
    pendingOperation: PendingOperation,
  ): void {
    this.untrack(agentId);
    const live: LiveRun = { owner, attempt, metadata, pendingOperation, finalizing: false };
    this.liveRuns.set(agentId, live);
    const queued = this.queuedSnapshots.get(agentId);
    if (queued) {
      this.queuedSnapshots.delete(agentId);
      live.pendingSnapshot = mergeProgressSnapshot(live.pendingSnapshot, queued);
    }
    const intervalMs = Math.max(250, Math.floor((owner.leaseExpiresAt - now) / 3));
    let chain: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      const run = chain.then(() => this.heartbeatAndMaybeFlush(agentId));
      chain = run.catch((error: unknown) => {
        logger.warn(`background subagent durable heartbeat loop failed for ${agentId}:`, error);
      });
      return run;
    }, intervalMs);
    timer.unref?.();
    live.heartbeatTimer = timer;
  }

  private async heartbeatAndMaybeFlush(agentId: string): Promise<void> {
    const live = this.liveRuns.get(agentId);
    if (!live) return;
    try {
      live.owner = await this.kernel.heartbeat(agentId, live.owner, Date.now());
    } catch (error: unknown) {
      // 被 fence（owner 易主）或持久层故障：停止续租，租约到期后由 sweeper 收口。
      logger.warn(`background subagent durable heartbeat stopped for ${agentId}:`, error);
      this.untrack(agentId);
      return;
    }
    if (this.liveRuns.get(agentId) !== live) return;
    await this.flushProgress(agentId, live);
  }

  private async flushProgress(agentId: string, live: LiveRun): Promise<void> {
    // 收口 checkpoint 与 terminal 之间如果再写进度，会把 launch operation 写回
    // dispatched，terminal(completed) 随即失败，行留在 running。
    if (live.finalizing) return;
    const snapshot = live.pendingSnapshot;
    if (!snapshot) return;
    const fingerprint = progressFingerprint(snapshot);
    if (fingerprint === live.lastFlushedFingerprint) return;
    const now = Date.now();
    if (live.lastFlushAt !== undefined && now - live.lastFlushAt < PROGRESS_FLUSH_MIN_INTERVAL_MS) return;
    const metadata = mergeCursorMetadata(live.metadata, snapshot);
    try {
      await this.kernel.checkpoint({
        runId: agentId,
        attempt: live.attempt,
        owner: live.owner,
        now,
        status: 'running',
        state: metadata,
        engineCursor: metadata,
        pendingOperations: [live.pendingOperation],
        events: [{
          type: 'background_subagent_progress',
          payload: progressEventPayload(snapshot),
          recordedAt: now,
        }],
      });
    } catch (error: unknown) {
      // fence 或磁盘故障只跳过这一笔。不停心跳，也不把失败抛给子代理。
      logger.warn(`background subagent durable progress checkpoint failed for ${agentId}:`, error);
      return;
    }
    if (this.liveRuns.get(agentId) !== live || live.finalizing) return;
    live.metadata = metadata;
    live.lastFlushedFingerprint = fingerprint;
    live.lastFlushAt = now;
  }

  private untrack(agentId: string): void {
    const live = this.liveRuns.get(agentId);
    if (!live) return;
    clearInterval(live.heartbeatTimer);
    this.liveRuns.delete(agentId);
  }
}

let configured: BackgroundSubagentDurableLedger | null = null;
let armed = false;
let configureWaiters: Array<(ledger: BackgroundSubagentDurableLedger | null) => void> = [];

/**
 * durable 模式入口（assembleDurableRun）在 kernel configure 成功后 arm：此后 spawn
 * 走账本落行而不是纯内存。assemble 是同步的，arm 与 configure 之间没有窗口；初始化
 * 失败的路径根本不会走到 arm，进程维持 legacy 纯内存（spawn 行为与改造前一致）。
 */
export function armBackgroundSubagentDurableLedger(): void {
  armed = true;
}

export const configureBackgroundSubagentDurableLedger = Object.assign(
  function configureBackgroundSubagentDurableLedger(
    ledger: BackgroundSubagentDurableLedger | null,
  ): void {
    configured = ledger;
    const waiters = configureWaiters;
    configureWaiters = [];
    for (const resolve of waiters) resolve(ledger);
  },
  {
    /** 测试用：回到未 arm、未 configure 的初始态。挂在既有导出上，不作为新 export（knip 棘轮不认新死导出，见 #1727 同款写法）。 */
    resetForTest(): void {
      configured = null;
      armed = false;
      const waiters = configureWaiters;
      configureWaiters = [];
      for (const resolve of waiters) resolve(null);
    },
  },
);

export function getBackgroundSubagentDurableLedger(): BackgroundSubagentDurableLedger | null {
  return configured;
}

export function isBackgroundSubagentDurableArmed(): boolean {
  return armed;
}

/**
 * armed 但 configure 尚未发生时等 configure（生产路径 assemble 同步完成 arm+configure，
 * 该等待主要留给测试与验收探针）；超时仍没有账本则 fail-closed——durable 模式下宁可
 * 让这次后台 spawn 失败，也不让它落不进账本。
 */
export function waitForBackgroundSubagentDurableLedger(
  timeoutMs: number = SERVICE_TIMEOUTS.BOOTSTRAP,
): Promise<BackgroundSubagentDurableLedger> {
  if (configured) return Promise.resolve(configured);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      configureWaiters = configureWaiters.filter((waiter) => waiter !== onConfigured);
      reject(new DurableRunPersistenceUnavailableError());
    }, timeoutMs);
    timer.unref?.();
    const onConfigured = (ledger: BackgroundSubagentDurableLedger | null) => {
      clearTimeout(timer);
      if (ledger) resolve(ledger);
      else reject(new DurableRunPersistenceUnavailableError());
    };
    configureWaiters.push(onConfigured);
  });
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clipProgressText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length <= PROGRESS_TEXT_LIMIT ? trimmed : trimmed.slice(0, PROGRESS_TEXT_LIMIT);
}

function normalizeProgressSnapshot(
  snapshot: BackgroundSubagentProgressSnapshot,
): BackgroundSubagentProgressSnapshot | null {
  const cost = finiteNumber(snapshot.cost);
  const tokensUsed = finiteNumber(snapshot.tokensUsed);
  const iterations = finiteNumber(snapshot.iterations);
  const toolCalls = finiteNumber(snapshot.toolCalls);
  const lastProgress = typeof snapshot.lastProgress === 'string' ? clipProgressText(snapshot.lastProgress) : '';
  const normalized: BackgroundSubagentProgressSnapshot = {
    ...(cost !== undefined ? { cost } : {}),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(lastProgress ? { lastProgress } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function mergeProgressSnapshot(
  current: BackgroundSubagentProgressSnapshot | undefined,
  next: BackgroundSubagentProgressSnapshot,
): BackgroundSubagentProgressSnapshot {
  return {
    ...(current?.cost !== undefined ? { cost: current.cost } : {}),
    ...(current?.tokensUsed !== undefined ? { tokensUsed: current.tokensUsed } : {}),
    ...(current?.iterations !== undefined ? { iterations: current.iterations } : {}),
    ...(current?.toolCalls !== undefined ? { toolCalls: current.toolCalls } : {}),
    ...(current?.lastProgress ? { lastProgress: current.lastProgress } : {}),
    ...(next.cost !== undefined ? { cost: next.cost } : {}),
    ...(next.tokensUsed !== undefined ? { tokensUsed: next.tokensUsed } : {}),
    ...(next.iterations !== undefined ? { iterations: next.iterations } : {}),
    ...(next.toolCalls !== undefined ? { toolCalls: next.toolCalls } : {}),
    ...(next.lastProgress ? { lastProgress: next.lastProgress } : {}),
  };
}

function mergeCursorMetadata(
  metadata: BackgroundSubagentCursorMetadata,
  snapshot: BackgroundSubagentProgressSnapshot,
): BackgroundSubagentCursorMetadata {
  return {
    ...metadata,
    schemaVersion: 1,
    kind: 'background_subagent_single',
    ...(snapshot.cost !== undefined ? { cost: snapshot.cost } : {}),
    ...(snapshot.tokensUsed !== undefined ? { tokensUsed: snapshot.tokensUsed } : {}),
    ...(snapshot.iterations !== undefined ? { iterations: snapshot.iterations } : {}),
    ...(snapshot.toolCalls !== undefined ? { toolCalls: snapshot.toolCalls } : {}),
    ...(snapshot.lastProgress ? { lastProgress: snapshot.lastProgress } : {}),
  };
}

function progressFingerprint(snapshot: BackgroundSubagentProgressSnapshot): string {
  return JSON.stringify({
    cost: snapshot.cost ?? null,
    tokensUsed: snapshot.tokensUsed ?? null,
    iterations: snapshot.iterations ?? null,
    toolCalls: snapshot.toolCalls ?? null,
    lastProgress: snapshot.lastProgress ?? null,
  });
}

function progressEventPayload(snapshot: BackgroundSubagentProgressSnapshot): Record<string, unknown> {
  return {
    ...(snapshot.cost !== undefined ? { cost: snapshot.cost } : {}),
    ...(snapshot.tokensUsed !== undefined ? { tokensUsed: snapshot.tokensUsed } : {}),
    ...(snapshot.iterations !== undefined ? { iterations: snapshot.iterations } : {}),
    ...(snapshot.toolCalls !== undefined ? { toolCalls: snapshot.toolCalls } : {}),
    ...(snapshot.lastProgress ? { lastProgress: snapshot.lastProgress } : {}),
  };
}
