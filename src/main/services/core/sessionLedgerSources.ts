// ============================================================================
// Session Ledger 数据源读取 helpers（ADR-022 §四第三期 3a）
//
// 从 databaseService 抽出的两个 SQL 重的只读取数函数（成本 / Swarm run），
// 供 getSessionLedger 拼装「一本账」。纯只读、fail-safe（失败返回空），不写库。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { SwarmRunListItem } from '../../../shared/contract/swarmTrace';
import { EMPTY_LEDGER_COST, type SessionLedgerCost } from '../../../shared/contract/sessionLedger';

/** 某会话的成本汇总（来自 telemetry_sessions）。fail-safe，失败返回空成本。 */
export function readSessionCost(db: BetterSqlite3.Database | null, sessionId: string): SessionLedgerCost {
  if (!db) return EMPTY_LEDGER_COST;
  try {
    const row = db.prepare(`
      SELECT estimated_cost, total_input_tokens, total_output_tokens
      FROM telemetry_sessions WHERE id = ?
    `).get(sessionId) as
      { estimated_cost?: number; total_input_tokens?: number; total_output_tokens?: number } | undefined;
    if (!row) return EMPTY_LEDGER_COST;
    return {
      estimatedCost: Number(row.estimated_cost ?? 0),
      tokensIn: Number(row.total_input_tokens ?? 0),
      tokensOut: Number(row.total_output_tokens ?? 0),
    };
  } catch {
    return EMPTY_LEDGER_COST;
  }
}

/**
 * 某会话的 Swarm run（协同 lane 源）。**按 session_id 直接查 swarm_runs**，
 * 不走 listRuns 的全局最近 N 截断——否则某 session 的 run 若不在全局最近 N 内会被静默漏掉（MED-1）。
 * fail-safe，失败返回空。
 */
export function readSwarmRunsForSession(
  db: BetterSqlite3.Database | null,
  sessionId: string,
  limit = 200,
): SwarmRunListItem[] {
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT id, session_id, status, coordinator, started_at, ended_at,
             total_agents, completed_count, failed_count, total_cost_usd,
             total_tokens_in, total_tokens_out, trigger
      FROM swarm_runs WHERE session_id = ?
      ORDER BY started_at ASC, id ASC LIMIT ?
    `).all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((r): SwarmRunListItem => {
      const startedAt = Number(r.started_at);
      const endedAt = r.ended_at == null ? null : Number(r.ended_at);
      return {
        id: String(r.id),
        sessionId: (r.session_id as string | null) ?? null,
        status: String(r.status) as SwarmRunListItem['status'],
        coordinator: String(r.coordinator) as SwarmRunListItem['coordinator'],
        startedAt,
        endedAt,
        durationMs: endedAt == null ? null : endedAt - startedAt,
        totalAgents: Number(r.total_agents ?? 0),
        completedCount: Number(r.completed_count ?? 0),
        failedCount: Number(r.failed_count ?? 0),
        totalCostUsd: Number(r.total_cost_usd ?? 0),
        totalTokensIn: Number(r.total_tokens_in ?? 0),
        totalTokensOut: Number(r.total_tokens_out ?? 0),
        trigger: String(r.trigger) as SwarmRunListItem['trigger'],
      };
    });
  } catch {
    return [];
  }
}
