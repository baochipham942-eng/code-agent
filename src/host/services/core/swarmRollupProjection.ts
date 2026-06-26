// ============================================================================
// SwarmRollupProjection（ADR-022 §四第三期 3b · ADR-023 D2）
//
// 从 append-only 协同事件账本（swarm_run_ledger）按 seq 回放，**确定性重建** rollup
// (SwarmRunDetail = run + agents)。可变 rollup 表降级为可由本投影重建的读优化缓存。
//
// 重建口径：
//   - totals（tokensIn/out/toolCalls/costUsd）从 agent_snapshot 末值**独立累加**重算
//     —— 这是"账本是否捕获齐全"的真等价校验（漏一条 snapshot 即 totals 不符，被对账抓到）。
//   - run 级收尾字段（status/endedAt/completedCount/failedCount/errorSummary/aggregation/tags）
//     取 run_closed payload（= rollup 表所写）。
//   - parallelPeak 按"逐 snapshot 维护各 agent 状态、数 running 取峰值"重算。
//   - 每个 agentId 末值覆盖（后写 snapshot 覆盖前写）。
// 纯函数、零 DB。
// ============================================================================

import type {
  SwarmRunAgentRecord,
  SwarmRunCoordinator,
  SwarmRunDetail,
  SwarmRunRecord,
  SwarmRunStatus,
  SwarmRunTrigger,
} from '../../../shared/contract/swarmTrace';
import type { SwarmLedgerEvent } from '../../../shared/contract/swarmLedger';
import type { SwarmAggregation } from '../../../shared/contract/swarm';

function num(v: unknown, dflt = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function str(v: unknown, dflt = ''): string {
  return v == null ? dflt : String(v);
}

function toAgentRecord(runId: string, p: Record<string, unknown>): SwarmRunAgentRecord {
  return {
    runId,
    agentId: str(p.agentId),
    name: str(p.name),
    role: str(p.role),
    status: str(p.status, 'pending') as SwarmRunAgentRecord['status'],
    startTime: p.startTime == null ? null : num(p.startTime),
    endTime: p.endTime == null ? null : num(p.endTime),
    durationMs: p.durationMs == null ? null : num(p.durationMs),
    tokensIn: num(p.tokensIn),
    tokensOut: num(p.tokensOut),
    toolCalls: num(p.toolCalls),
    costUsd: num(p.costUsd),
    error: p.error == null ? null : str(p.error),
    failureCategory: p.failureCategory == null ? null : str(p.failureCategory),
    filesChanged: Array.isArray(p.filesChanged) ? p.filesChanged.map((f) => String(f)) : [],
  };
}

/**
 * 从某 run 的 ledger 事件（按 seq 升序）重建 SwarmRunDetail。
 * 事件不足以确定 run（无 run_started）时返回 null。events 字段留空（timeline 仍由 rollup 缓存提供）。
 */
export function rebuildRunDetail(events: SwarmLedgerEvent[]): SwarmRunDetail | null {
  if (!Array.isArray(events) || events.length === 0) return null;

  const sorted = [...events].sort((a, b) => (a.seq - b.seq) || (a.id - b.id));
  const runId = sorted[0].runId;
  const sessionId = sorted[0].sessionId;

  let started: Record<string, unknown> | null = null;
  let closed: Record<string, unknown> | null = null;
  // 末值覆盖：agentId → 最后一条 snapshot payload（保留出现顺序用于稳定排序）
  const agentLatest = new Map<string, Record<string, unknown>>();
  // parallelPeak 重算：逐 snapshot 维护状态，数 running 取峰值
  const agentStatus = new Map<string, string>();
  let parallelPeak = 0;

  for (const ev of sorted) {
    try {
      const p = ev.payload ?? {};
      if (ev.kind === 'run_started') {
        started = p;
      } else if (ev.kind === 'run_closed') {
        closed = p;
      } else if (ev.kind === 'agent_snapshot') {
        const agentId = ev.agentId ?? str(p.agentId);
        if (!agentId) continue;
        agentLatest.set(agentId, p);
        agentStatus.set(agentId, str(p.status, 'pending'));
        const running = Array.from(agentStatus.values()).filter((s) => s === 'running').length;
        if (running > parallelPeak) parallelPeak = running;
      }
    } catch {
      // 单条坏事件跳过，不毁整次重建
    }
  }

  if (!started) return null;

  const agents: SwarmRunAgentRecord[] = Array.from(agentLatest.values()).map((p) => toAgentRecord(runId, p));

  // totals 从 agent 末值独立累加（真等价校验）
  let totalTokensIn = 0, totalTokensOut = 0, totalToolCalls = 0, totalCostUsd = 0;
  for (const a of agents) {
    totalTokensIn += a.tokensIn;
    totalTokensOut += a.tokensOut;
    totalToolCalls += a.toolCalls;
    totalCostUsd += a.costUsd;
  }

  const run: SwarmRunRecord = {
    id: runId,
    sessionId,
    coordinator: str(started.coordinator, 'unknown') as SwarmRunCoordinator,
    status: (closed ? str(closed.status, 'completed') : 'running') as SwarmRunStatus,
    startedAt: num(started.startedAt),
    endedAt: closed ? num(closed.endedAt) : null,
    totalAgents: num(started.totalAgents),
    completedCount: closed ? num(closed.completedCount) : 0,
    failedCount: closed ? num(closed.failedCount) : 0,
    parallelPeak,
    totalTokensIn,
    totalTokensOut,
    totalToolCalls,
    totalCostUsd,
    trigger: str(started.trigger, 'unknown') as SwarmRunTrigger,
    errorSummary: closed?.errorSummary != null ? str(closed.errorSummary) : null,
    aggregation: (closed?.aggregation as SwarmAggregation | null) ?? null,
    tags: closed && Array.isArray(closed.tags) ? (closed.tags as unknown[]).map((t) => String(t)) : [],
  };

  return { run, agents, events: [] };
}
