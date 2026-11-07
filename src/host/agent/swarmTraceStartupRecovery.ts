// ============================================================================
// SwarmTraceStartupRecovery — 启动收口上一进程遗留的 running swarm run
// ----------------------------------------------------------------------------
// swarm run 的驱动（spawnGuard/parallelCoordinator/后台 registry）全部活在宿主
// 进程内；kill/退出后账本里的 run 与成员永远停在 running，重启后成员条继续谎报
// 「N 个代理工作中」（N-STALE-AGENT-CHIP-AFTER-QUIT A）。与 loop 启动收口
// （loopStartupRecovery）同一判据：startedAt 早于本进程启动 = 写它的人已死，
// 只收口、不恢复续跑——把非终态成员与 run 本身收成 cancelled，rollup 与账本
// 双写（与 swarmTraceWriter.onCancelled 同构，账本 seq 续接不重排）。
// ============================================================================

import type {
  AppendEventInput,
  CloseRunInput,
  SwarmRunDetail,
  SwarmRunListItem,
  SwarmTraceRepo,
  UpsertAgentInput,
} from '../../shared/contract/swarmTrace';
import type { SwarmLedgerAppendInput, SwarmLedgerEvent } from '../../shared/contract/swarmLedger';
import { SWARM_TRACE } from '../../shared/constants/storage';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SwarmTraceStartupRecovery');

/** 与进程内收口一致的收尾文案；failureCategory 沿用 interrupted_by_restart 口径。 */
const INTERRUPTED_ERROR = 'interrupted by app restart';
const INTERRUPTED_FAILURE_CATEGORY = 'interrupted_by_restart';
/** 非终态成员（pending/ready/running）在收口时的落点。 */
const OPEN_AGENT_STATUSES: ReadonlySet<SwarmRunDetail['agents'][number]['status']> = new Set([
  'pending',
  'ready',
  'running',
]);

export interface SwarmTraceStartupRecoveryDeps {
  now: number;
  /** 本进程启动时刻；startedAt 早于它的 running run 才收口。 */
  bootMs: number;
  listRuns(): SwarmRunListItem[];
  getRunDetail(runId: string): SwarmRunDetail | null;
  upsertAgent(input: UpsertAgentInput): void;
  closeRun(input: CloseRunInput): void;
  appendLedger(input: SwarmLedgerAppendInput): void;
  ledgerEvents(runId: string): SwarmLedgerEvent[];
  appendEvent?(input: AppendEventInput): void;
}

interface SwarmTraceStartupRecoveryResult {
  runsClosed: number;
  agentsCancelled: number;
}

export function applySwarmTraceStartupRecovery(
  deps: SwarmTraceStartupRecoveryDeps,
): SwarmTraceStartupRecoveryResult {
  const result: SwarmTraceStartupRecoveryResult = { runsClosed: 0, agentsCancelled: 0 };

  for (const run of deps.listRuns()) {
    // 只收口上一进程遗留的 running：本进程启动后开的 run 可能正在跑（含恢复续跑）。
    if (run.status !== 'running' || run.startedAt >= deps.bootMs) continue;

    const detail = deps.getRunDetail(run.id);
    if (!detail) continue;

    const endedAt = deps.now;
    const openAgents = detail.agents.filter((agent) => OPEN_AGENT_STATUSES.has(agent.status));
    // 账本 seq 按回放顺序续接已有事件，不重排（回放取末值，append 在尾部即可）。
    const ledgerBaseSeq = deps.ledgerEvents(run.id).reduce((max, event) => Math.max(max, event.seq), -1) + 1;
    // timeline 事件 seq 同样续接存量，收口说明排在最后。
    const eventSeq = detail.events.reduce((max, event) => Math.max(max, event.seq), -1) + 1;

    openAgents.forEach((agent, index) => {
      const durationMs = agent.startTime == null ? null : Math.max(0, endedAt - agent.startTime);
      const settled = {
        ...agent,
        status: 'cancelled' as const,
        endTime: endedAt,
        durationMs,
        error: agent.error ?? INTERRUPTED_ERROR,
        failureCategory: agent.failureCategory ?? INTERRUPTED_FAILURE_CATEGORY,
      };
      const { runId: _runId, ...snapshot } = settled;
      deps.upsertAgent({
        runId: run.id,
        agentId: settled.agentId,
        name: settled.name,
        role: settled.role,
        status: settled.status,
        startTime: settled.startTime,
        endTime: settled.endTime,
        durationMs: settled.durationMs,
        tokensIn: settled.tokensIn,
        tokensOut: settled.tokensOut,
        toolCalls: settled.toolCalls,
        costUsd: settled.costUsd,
        error: settled.error,
        failureCategory: settled.failureCategory,
        filesChanged: settled.filesChanged,
        dispatchedTask: settled.dispatchedTask,
        dispatchedTaskTruncated: settled.dispatchedTaskTruncated,
        dispatchedTaskArchiveItemId: settled.dispatchedTaskArchiveItemId,
        finalOutput: settled.finalOutput,
        finalOutputTruncated: settled.finalOutputTruncated,
        finalOutputArchiveItemId: settled.finalOutputArchiveItemId,
      });
      deps.appendLedger({
        runId: run.id,
        sessionId: detail.run.sessionId,
        seq: ledgerBaseSeq + index,
        kind: 'agent_snapshot',
        agentId: settled.agentId,
        payload: snapshot,
        recordedAt: endedAt,
      });
    });

    const agentsAfter = detail.agents.map((agent) =>
      OPEN_AGENT_STATUSES.has(agent.status) ? 'cancelled' as const : agent.status);
    const close: CloseRunInput = {
      id: run.id,
      status: 'cancelled',
      endedAt,
      completedCount: agentsAfter.filter((status) => status === 'completed').length,
      failedCount: agentsAfter.filter((status) => status === 'failed').length,
      parallelPeak: detail.run.parallelPeak,
      totalTokensIn: detail.run.totalTokensIn,
      totalTokensOut: detail.run.totalTokensOut,
      totalToolCalls: detail.run.totalToolCalls,
      totalCostUsd: detail.run.totalCostUsd,
      errorSummary: detail.run.errorSummary ?? INTERRUPTED_ERROR,
      aggregation: null,
    };
    deps.closeRun(close);
    deps.appendLedger({
      runId: run.id,
      sessionId: detail.run.sessionId,
      seq: ledgerBaseSeq + openAgents.length,
      kind: 'run_closed',
      agentId: null,
      payload: {
        status: close.status,
        endedAt: close.endedAt,
        completedCount: close.completedCount,
        failedCount: close.failedCount,
        parallelPeak: close.parallelPeak,
        totalTokensIn: close.totalTokensIn,
        totalTokensOut: close.totalTokensOut,
        totalToolCalls: close.totalToolCalls,
        totalCostUsd: close.totalCostUsd,
        errorSummary: close.errorSummary,
        aggregation: close.aggregation,
        tags: [],
      },
      recordedAt: endedAt,
    });
    deps.appendEvent?.({
      runId: run.id,
      seq: eventSeq,
      timestamp: endedAt,
      eventType: 'swarm:cancelled',
      agentId: null,
      level: 'warn',
      title: 'cancelled (startup recovery)',
      summary: `应用重启后未发现存活进程，运行已收口为取消（${openAgents.length} 个未完成成员）`,
      payload: { recoveredBy: 'swarmTraceStartupRecovery', agentsCancelled: openAgents.length },
    });

    result.runsClosed += 1;
    result.agentsCancelled += openAgents.length;
    logger.info('Closed interrupted swarm run as cancelled', {
      runId: run.id,
      agentsCancelled: openAgents.length,
    });
  }

  return result;
}

/** 启动收口入口：接真 DB/仓。 */
function markInterruptedSwarmRuns(now = Date.now()): SwarmTraceStartupRecoveryResult {
  const db = getDatabase();
  const repo: SwarmTraceRepo = db.getSwarmTraceRepo();
  return applySwarmTraceStartupRecovery({
    now,
    bootMs: Date.now() - process.uptime() * 1000,
    listRuns: () => repo.listRuns(SWARM_TRACE.MAX_LIST_LIMIT),
    getRunDetail: (runId) => db.getSwarmRunDetailPreferLedger(runId),
    upsertAgent: (input) => repo.upsertAgent(input),
    closeRun: (input) => repo.closeRun(input),
    appendLedger: (input) => db.appendSwarmLedgerEvent(input),
    ledgerEvents: (runId) => db.getSwarmLedgerByRun(runId),
    appendEvent: (input) => repo.appendEvent(input),
  });
}

/** webServer 启动挂钩：自兜错误，绝不阻塞启动（与 loop 收口同一形态）。 */
export function runSwarmTraceStartupRecovery(): void {
  try {
    const closed = markInterruptedSwarmRuns();
    if (closed.runsClosed > 0) {
      logger.info(
        `Swarm trace startup recovery: ${closed.runsClosed} run(s) closed as cancelled, ${closed.agentsCancelled} agent(s) settled`,
      );
    }
  } catch (error) {
    logger.warn('Swarm trace startup recovery failed (non-blocking):', (error as Error).message);
  }
}
