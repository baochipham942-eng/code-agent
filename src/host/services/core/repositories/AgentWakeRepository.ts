// ============================================================================
// AgentWakeRepository — agent 自发挂起-续跑台账（self-wake）
// ============================================================================
// 只做同步 SQLite 读写，不做调度。到点判定与投递在 WakeService。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type {
  AgentWakeKind,
  AgentWakeRecord,
  AgentWakeStatus,
  CreateAgentWakeInput,
} from '../../../../shared/contract/agentWake';

type SQLiteRow = Record<string, unknown>;

function rowToRecord(row: SQLiteRow): AgentWakeRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    kind: row.kind as AgentWakeKind,
    dueAt: row.due_at == null ? null : Number(row.due_at),
    jobId: row.job_id == null ? null : String(row.job_id),
    eventName: row.event_name == null ? null : String(row.event_name),
    reason: String(row.reason ?? ''),
    status: row.status as AgentWakeStatus,
    createdAt: Number(row.created_at) || 0,
    firedAt: row.fired_at == null ? null : Number(row.fired_at),
  };
}

export class AgentWakeRepository {
  constructor(private db: BetterSqlite3.Database) {}

  insert(input: CreateAgentWakeInput): AgentWakeRecord {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agent_wakes (
          id, session_id, kind, due_at, job_id, event_name, reason, status, created_at, fired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.kind,
        input.dueAt ?? null,
        input.jobId ?? null,
        input.eventName ?? null,
        input.reason,
        input.createdAt,
      );
    return {
      id: input.id,
      sessionId: input.sessionId,
      kind: input.kind,
      dueAt: input.dueAt ?? null,
      jobId: input.jobId ?? null,
      eventName: input.eventName ?? null,
      reason: input.reason,
      status: 'pending',
      createdAt: input.createdAt,
      firedAt: null,
    };
  }

  /** 该会话累计挂过多少次醒来（含已 fire 的）——配额按累计算，防重试风暴里的反复重挂。 */
  countBySession(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM agent_wakes WHERE session_id = ? AND status != 'cancelled'`)
      .get(sessionId) as SQLiteRow | undefined;
    return Number(row?.n) || 0;
  }

  listPending(): AgentWakeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_wakes WHERE status = 'pending' ORDER BY created_at ASC`)
      .all() as SQLiteRow[];
    return rows.map(rowToRecord);
  }

  /** 到点的时间型醒来。重启后 now 会远大于 due_at，过期的也照样返回——迟到也要送到。 */
  listDueTimeWakes(now: number): AgentWakeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_wakes
         WHERE status = 'pending' AND kind = 'time' AND due_at IS NOT NULL AND due_at <= ?
         ORDER BY due_at ASC`,
      )
      .all(now) as SQLiteRow[];
    return rows.map(rowToRecord);
  }

  listPendingByTrigger(kind: Extract<AgentWakeKind, 'job' | 'event'>, key: string): AgentWakeRecord[] {
    const column = kind === 'job' ? 'job_id' : 'event_name';
    const rows = this.db
      .prepare(`SELECT * FROM agent_wakes WHERE status = 'pending' AND kind = ? AND ${column} = ?`)
      .all(kind, key) as SQLiteRow[];
    return rows.map(rowToRecord);
  }

  /**
   * 标记已投递。返回受影响行数——0 表示这条已经被别处 fire 过了，调用方据此做幂等，
   * 别重复投递续跑（同一个 wake 送两次 = 同一句话说两遍）。
   */
  markFired(id: string, firedAt: number): number {
    return this.db
      .prepare(`UPDATE agent_wakes SET status = 'fired', fired_at = ? WHERE id = ? AND status = 'pending'`)
      .run(firedAt, id).changes;
  }

  cancelBySession(sessionId: string): number {
    return this.db
      .prepare(`UPDATE agent_wakes SET status = 'cancelled' WHERE session_id = ? AND status = 'pending'`)
      .run(sessionId).changes;
  }

  get(id: string): AgentWakeRecord | null {
    const row = this.db.prepare(`SELECT * FROM agent_wakes WHERE id = ?`).get(id) as SQLiteRow | undefined;
    return row ? rowToRecord(row) : null;
  }
}
