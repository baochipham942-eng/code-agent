// ============================================================================
// SwarmLedgerRepository — Swarm 协同事件账本（ADR-022 §四第三期 3b · ADR-023 D2）
// ============================================================================
//
// append-only：让 append-only 事件流当 Swarm 轨迹的「真理源」，把可变 rollup 表
// (swarm_runs / swarm_run_agents) 降级为可从本账确定性重建的读优化缓存。
// 事件 kind：run_started / agent_snapshot（末值覆盖）/ run_closed。
// 不变量：只 INSERT / SELECT，不提供任何 UPDATE / DELETE 方法（账本不可篡改）。
// 时间戳：recordedAt 由调用方传入（仓储层禁止裸 Date.now()）。
// 与 swarm_run_events 不同：本表不丢尾、不截断 rollup 关键字段、无 FK 依赖 rollup 表。

import type BetterSqlite3 from 'better-sqlite3';
import type { SwarmLedgerAppendInput, SwarmLedgerEvent } from '../../../../shared/contract/swarmLedger';

type SQLiteRow = Record<string, unknown>;

function parsePayload(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function rowToEvent(row: SQLiteRow): SwarmLedgerEvent {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    sessionId: (row.session_id as string | null) ?? null,
    seq: Number(row.seq),
    kind: String(row.event_kind) as SwarmLedgerEvent['kind'],
    agentId: (row.agent_id as string | null) ?? null,
    payload: parsePayload(row.payload_json),
    recordedAt: Number(row.recorded_at),
  };
}

export class SwarmLedgerRepository {
  constructor(private db: BetterSqlite3.Database) {}

  /** 追加一条协同事件（append-only）。 */
  append(input: SwarmLedgerAppendInput): void {
    this.db.prepare(`
      INSERT INTO swarm_run_ledger
        (run_id, session_id, seq, event_kind, agent_id, payload_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.sessionId ?? null,
      input.seq,
      input.kind,
      input.agentId ?? null,
      JSON.stringify(input.payload ?? {}),
      input.recordedAt,
    );
  }

  /** 某 run 的全部事件（按 seq 升序，供投影回放重建 rollup）。 */
  getByRun(runId: string): SwarmLedgerEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM swarm_run_ledger WHERE run_id = ? ORDER BY seq ASC, id ASC
    `).all(runId) as SQLiteRow[];
    return rows.map(rowToEvent);
  }

  /** 有账记录的 run id 列表（可按 session 过滤；按最近 recorded_at 倒序）。 */
  listRunIds(sessionId?: string, limit = 200): string[] {
    const rows = sessionId
      ? this.db.prepare(`
          SELECT run_id, MAX(recorded_at) AS last_at FROM swarm_run_ledger
          WHERE session_id = ? GROUP BY run_id ORDER BY last_at DESC LIMIT ?
        `).all(sessionId, limit) as SQLiteRow[]
      : this.db.prepare(`
          SELECT run_id, MAX(recorded_at) AS last_at FROM swarm_run_ledger
          GROUP BY run_id ORDER BY last_at DESC LIMIT ?
        `).all(limit) as SQLiteRow[];
    return rows.map((r) => String(r.run_id));
  }

  /** 账本总条数 */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM swarm_run_ledger`).get() as { c?: number };
    return Number(row?.c ?? 0);
  }
}
