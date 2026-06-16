// ============================================================================
// PermissionDecisionRepository — 权限决策链事件账本（ADR-022 第一期）
// ============================================================================
//
// append-only：把每一次权限 allow/deny/ask 决策持久化（原来只在内存环形缓冲、重启即丢）。
// 不变量：只 INSERT / SELECT，不提供任何 UPDATE / DELETE 方法（账本不可篡改）。
// 时间戳：recordedAt 由调用方传入（仓储层禁止裸 Date.now()）。

import type BetterSqlite3 from 'better-sqlite3';
import type { DecisionTrace } from '../../../../shared/contract/decisionTrace';

type SQLiteRow = Record<string, unknown>;

/** 落库一条权限决策所需的输入 */
export interface PermissionDecisionInput {
  sessionId?: string;
  toolName: string;
  summary: string;
  /** 归一化后的最终结果：allow | deny | ask */
  finalOutcome: string;
  /** 细粒度结果：auto-approve | ask-denied | policy-deny | hook-blocked ... */
  historyOutcome: string;
  reason: string;
  durationMs: number;
  /** 决策发生时间戳（毫秒），由调用方传入 */
  recordedAt: number;
  /** 多层决策 trace（可选） */
  trace?: DecisionTrace;
}

/** 从库里读回的一条权限决策 */
export interface PermissionDecisionRecord {
  id: number;
  sessionId: string | null;
  toolName: string;
  summary: string | null;
  finalOutcome: string;
  historyOutcome: string;
  reason: string;
  durationMs: number;
  recordedAt: number;
  trace: DecisionTrace | null;
}

function rowToRecord(row: SQLiteRow): PermissionDecisionRecord {
  let trace: DecisionTrace | null = null;
  const rawTrace = row.trace_json;
  if (typeof rawTrace === 'string' && rawTrace.length > 0) {
    try {
      trace = JSON.parse(rawTrace) as DecisionTrace;
    } catch {
      trace = null;
    }
  }
  return {
    id: Number(row.id),
    sessionId: (row.session_id as string | null) ?? null,
    toolName: String(row.tool_name),
    summary: (row.summary as string | null) ?? null,
    finalOutcome: String(row.final_outcome),
    historyOutcome: String(row.history_outcome),
    reason: String(row.reason),
    durationMs: Number(row.duration_ms),
    recordedAt: Number(row.recorded_at),
    trace,
  };
}

export class PermissionDecisionRepository {
  constructor(private db: BetterSqlite3.Database) {}

  /** 追加一条权限决策（append-only） */
  append(input: PermissionDecisionInput): void {
    this.db.prepare(`
      INSERT INTO permission_decisions
        (session_id, tool_name, summary, final_outcome, history_outcome, reason, duration_ms, recorded_at, trace_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId ?? null,
      input.toolName,
      input.summary ?? null,
      input.finalOutcome,
      input.historyOutcome,
      input.reason,
      input.durationMs,
      input.recordedAt,
      input.trace ? JSON.stringify(input.trace) : null,
    );
  }

  /** 最近 N 条（按时间倒序） */
  getRecent(limit = 50): PermissionDecisionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM permission_decisions ORDER BY recorded_at DESC, id DESC LIMIT ?
    `).all(limit) as SQLiteRow[];
    return rows.map(rowToRecord);
  }

  /** 指定 session 的最近 N 条（按时间倒序） */
  getBySession(sessionId: string, limit = 50): PermissionDecisionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM permission_decisions WHERE session_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?
    `).all(sessionId, limit) as SQLiteRow[];
    return rows.map(rowToRecord);
  }

  /** 账本总条数 */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM permission_decisions`).get() as { c?: number };
    return Number(row?.c ?? 0);
  }
}
