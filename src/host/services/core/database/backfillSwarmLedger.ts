// ============================================================================
// backfillSwarmLedger（ADR-022 §四第四期 · ADR-024 Q3=B1「默认跳过 + opt-in backfill」）
//
// 存量老 run（有 rollup、无 ledger）→ 从现存 rollup **反向重建** ledger 事件序列
// （run_started + 每 agent 末值 agent_snapshot + run_closed）。
//
// 纪律：
//   - 幂等：已有任意 ledger 行的 run 跳过（already-ledgered）；运行中(running)跳过；无 rollup 跳过。
//   - 可回滚：每个 run 的写入在 deps.transaction 内原子提交，中途出错整笔回滚、不留脏数据。
//   - 向后兼容：默认不在开机/不随 Dream 跑（仅 opt-in 触发）；不迁移的老 run 仍靠读路径回退 rollup。
//   - 局限（已知）：parallelPeak 由 rebuildRunDetail 从末值快照重算，可能与 rollup 原值有 ±N 偏差
//     （reconcile 对 parallelPeak 有容忍度）——这是「从有损缓存反向重建」的固有近似，非 bug。
// ============================================================================

import type { SwarmRunDetail } from '../../../../shared/contract/swarmTrace';
import type { SwarmLedgerAppendInput } from '../../../../shared/contract/swarmLedger';

export interface SwarmLedgerBackfillDeps {
  /** 所有 rollup run 的 id（生产由 swarmTraceRepo.listRuns 映射）。 */
  listRunIds(): string[];
  getStoredRunDetail(runId: string): SwarmRunDetail | null;
  /** 该 run 是否已有 ledger（幂等前置检查）。 */
  hasLedger(runId: string): boolean;
  /** 追加一条 ledger 事件（抛错版，用于触发事务回滚）。 */
  appendLedger(input: SwarmLedgerAppendInput): void;
  /** 把 fn 包进一个 DB 事务执行（出错回滚并重抛）。 */
  transaction(fn: () => void): void;
  /** 注入时间戳（缺历史戳时兜底）。 */
  now: number;
}

export interface SwarmLedgerBackfillResult {
  backfilled: string[];
  skipped: { runId: string; note: string }[];
  errors: { runId: string; error: string }[];
}

export function backfillSwarmLedger(deps: SwarmLedgerBackfillDeps): SwarmLedgerBackfillResult {
  const backfilled: string[] = [];
  const skipped: { runId: string; note: string }[] = [];
  const errors: { runId: string; error: string }[] = [];

  let runIds: string[];
  try {
    runIds = deps.listRunIds();
  } catch (e) {
    return { backfilled, skipped, errors: [{ runId: '*', error: String(e) }] };
  }

  for (const runId of runIds) {
    try {
      if (deps.hasLedger(runId)) { skipped.push({ runId, note: 'already-ledgered' }); continue; }
      const detail = deps.getStoredRunDetail(runId);
      if (!detail) { skipped.push({ runId, note: 'no-rollup' }); continue; }
      if (detail.run.status === 'running') { skipped.push({ runId, note: 'in-progress' }); continue; }

      const run = detail.run;
      const closedAt = run.endedAt ?? (run.startedAt || deps.now);
      deps.transaction(() => {
        let seq = 0;
        deps.appendLedger({
          runId, sessionId: run.sessionId, seq, kind: 'run_started', agentId: null,
          payload: { coordinator: run.coordinator, startedAt: run.startedAt, totalAgents: run.totalAgents, trigger: run.trigger },
          recordedAt: run.startedAt || deps.now,
        });
        seq += 1;
        for (const a of detail.agents) {
          deps.appendLedger({
            runId, sessionId: run.sessionId, seq, kind: 'agent_snapshot', agentId: a.agentId,
            payload: {
              agentId: a.agentId, name: a.name, role: a.role, status: a.status,
              startTime: a.startTime, endTime: a.endTime, durationMs: a.durationMs,
              tokensIn: a.tokensIn, tokensOut: a.tokensOut, toolCalls: a.toolCalls, costUsd: a.costUsd,
              error: a.error, failureCategory: a.failureCategory, filesChanged: a.filesChanged,
            },
            recordedAt: a.endTime ?? closedAt,
          });
          seq += 1;
        }
        deps.appendLedger({
          runId, sessionId: run.sessionId, seq, kind: 'run_closed', agentId: null,
          payload: {
            status: run.status, endedAt: closedAt, completedCount: run.completedCount, failedCount: run.failedCount,
            parallelPeak: run.parallelPeak, totalTokensIn: run.totalTokensIn, totalTokensOut: run.totalTokensOut,
            totalToolCalls: run.totalToolCalls, totalCostUsd: run.totalCostUsd,
            errorSummary: run.errorSummary, aggregation: run.aggregation, tags: run.tags,
          },
          recordedAt: closedAt,
        });
      });
      backfilled.push(runId);
    } catch (e) {
      errors.push({ runId, error: String(e) });
    }
  }

  return { backfilled, skipped, errors };
}
