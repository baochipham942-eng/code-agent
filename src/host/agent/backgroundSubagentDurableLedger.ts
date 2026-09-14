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
// 子代理认领走并误收成 interrupted。heartbeat 被 fence（owner 易主）后停止写
// 账本——之后的 terminal 必然被 fence，留给收口路径处理。
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

export interface BackgroundSubagentCursorMetadata {
  schemaVersion: 1;
  kind: 'background_subagent_single';
  title?: string;
  role?: string;
  treeId?: string;
  completionKind?: SubagentCompletionKind;
  startedAt: number;
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
  return candidate as BackgroundSubagentCursorMetadata;
}

interface LiveRun {
  owner: RunOwnerLease;
  attempt: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

export class BackgroundSubagentDurableLedger {
  private readonly liveRuns = new Map<string, LiveRun>();

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
    this.track(input.agentId, created.owner, created.attempt.attempt, now);
  }

  /**
   * 收成终态：先 checkpoint 把 launch operation 收掉（completed 断言要求无未决
   * operation），再 terminal。heartbeat 已被 fence 的 run 直接放弃写——写了也
   * 会被 owner epoch 挡住，交给启动/sweeper 收口。
   */
  async finalize(agentId: string, input: BackgroundSubagentDurableFinalizeInput): Promise<void> {
    const live = this.liveRuns.get(agentId);
    if (!live) return;
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

  private track(agentId: string, owner: RunOwnerLease, attempt: number, now: number): void {
    this.untrack(agentId);
    const live: LiveRun = { owner, attempt };
    const intervalMs = Math.max(250, Math.floor((owner.leaseExpiresAt - now) / 3));
    const timer = setInterval(() => {
      void this.kernel.heartbeat(agentId, live.owner, Date.now()).then(
        (renewed) => {
          live.owner = renewed;
        },
        (error: unknown) => {
          // 被 fence（owner 易主）或持久层故障：停止续租，租约到期后由 sweeper 收口。
          logger.warn(`background subagent durable heartbeat stopped for ${agentId}:`, error);
          this.untrack(agentId);
        },
      );
    }, intervalMs);
    timer.unref?.();
    live.heartbeatTimer = timer;
    this.liveRuns.set(agentId, live);
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
