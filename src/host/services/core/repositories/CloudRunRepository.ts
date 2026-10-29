// ============================================================================
// CloudRunRepository — 云端 run 账本持久行与准入事务（ADR-087 S1–S3）
// ============================================================================
// 同步 SQLite only（SessionDelegationRepository 形状）。时间戳一律是参数，
// 本层禁裸取当前时间（repositories grep 门）；真钟默认在 CloudRunLedger。
// 迁移合法性不在这一层：账本服务先按合同迁移表判，再用 from_state 做 CAS
// 落库，行更新与迁移记录写进同一个事务。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { CloudRunState, CloudRunTrigger } from '../../../../shared/contract/cloudRun';

type SQLiteRow = Record<string, unknown>;

export interface CloudRunRecord {
  runId: string;
  accountId: string;
  sessionId: string;
  trigger: CloudRunTrigger;
  state: CloudRunState;
  workspaceId: string;
  workspaceStatus: string;
  retentionNoticeAt: number | null;
  exportAvailable: boolean | null;
  enqueuedSeq: number | null;
  requestJson: string | null;
  clientMessageId: string | null;
  executionRunId: string | null;
  cancelRequestedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CloudRunTransitionRecord {
  seq: number;
  runId: string;
  fromState: CloudRunState;
  toState: CloudRunState;
  at: number;
}

interface InsertCloudRunInput {
  runId: string;
  accountId: string;
  sessionId: string;
  trigger: CloudRunTrigger;
  workspaceId: string;
  state?: CloudRunState;
  enqueuedSeq?: number;
  requestJson?: string;
  clientMessageId?: string;
  now: number;
}

interface AdmitCloudRunInput extends InsertCloudRunInput {
  maxInFlight: number;
}

interface ApplyCloudRunTransitionInput {
  runId: string;
  fromState: CloudRunState;
  toState: CloudRunState;
  now: number;
}

function rowToRecord(row: SQLiteRow): CloudRunRecord {
  return {
    runId: String(row.run_id),
    accountId: String(row.account_id),
    sessionId: String(row.session_id),
    trigger: row.trigger as CloudRunTrigger,
    state: row.state as CloudRunState,
    workspaceId: String(row.workspace_id),
    workspaceStatus: String(row.workspace_status ?? 'active'),
    retentionNoticeAt: row.retention_notice_at == null ? null : Number(row.retention_notice_at),
    exportAvailable: row.export_available == null ? null : Boolean(row.export_available),
    enqueuedSeq: row.enqueued_seq == null ? null : Number(row.enqueued_seq),
    requestJson: row.request_json == null ? null : String(row.request_json),
    clientMessageId: row.client_message_id == null ? null : String(row.client_message_id),
    executionRunId: row.execution_run_id == null ? null : String(row.execution_run_id),
    cancelRequestedAt: row.cancel_requested_at == null ? null : Number(row.cancel_requested_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToTransition(row: SQLiteRow): CloudRunTransitionRecord {
  return {
    seq: Number(row.seq),
    runId: String(row.run_id),
    fromState: row.from_state as CloudRunState,
    toState: row.to_state as CloudRunState,
    at: Number(row.at),
  };
}

export class CloudRunRepository {
  constructor(private db: BetterSqlite3.Database) {}

  insertRun(input: InsertCloudRunInput): CloudRunRecord {
    this.db.prepare(
      `INSERT INTO cloud_runs (
        run_id, account_id, session_id, "trigger", state, workspace_id,
        enqueued_seq, request_json, client_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId,
      input.accountId,
      input.sessionId,
      input.trigger,
      input.state ?? 'queued',
      input.workspaceId,
      input.enqueuedSeq ?? null,
      input.requestJson ?? null,
      input.clientMessageId ?? null,
      input.now,
      input.now,
    );
    const created = this.getRun(input.runId);
    if (!created) throw new Error('cloud run insert did not persist');
    return created;
  }

  admitRun(input: AdmitCloudRunInput): { record: CloudRunRecord; duplicate: boolean } {
    const admit = this.db.transaction((): { record: CloudRunRecord; duplicate: boolean } => {
      if (input.clientMessageId) {
        const existing = this.db.prepare(
          `SELECT * FROM cloud_runs
           WHERE account_id = ? AND session_id = ? AND client_message_id = ?`,
        ).get(input.accountId, input.sessionId, input.clientMessageId) as SQLiteRow | undefined;
        if (existing) return { record: rowToRecord(existing), duplicate: true };
      }
      const inFlight = this.countInFlight(input.accountId);
      const sessionConflict = this.db.prepare(
        `SELECT 1 FROM cloud_runs
         WHERE account_id = ? AND session_id = ?
           AND state IN ('queued', 'running', 'waiting-approval', 'waiting-reconnect')
         LIMIT 1`,
      ).get(input.accountId, input.sessionId);
      const state: CloudRunState = inFlight < input.maxInFlight && !sessionConflict ? 'running' : 'queued';
      const sequence = this.db.prepare(
        'SELECT COALESCE(MAX(enqueued_seq), 0) + 1 AS next_seq FROM cloud_runs WHERE account_id = ?',
      ).get(input.accountId) as SQLiteRow;
      const record = this.insertRun({
        ...input,
        state,
        enqueuedSeq: Number(sequence.next_seq),
      });
      return { record, duplicate: false };
    });
    return admit.immediate();
  }

  getRun(runId: string): CloudRunRecord | null {
    const row = this.db.prepare('SELECT * FROM cloud_runs WHERE run_id = ?').get(runId) as SQLiteRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getRunForAccount(runId: string, accountId: string): CloudRunRecord | null {
    const row = this.db.prepare('SELECT * FROM cloud_runs WHERE run_id = ? AND account_id = ?').get(
      runId,
      accountId,
    ) as SQLiteRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getQueuePosition(record: CloudRunRecord): { queuePosition: number; ahead: number } | null {
    if (record.state !== 'queued' || record.enqueuedSeq === null) return null;
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total FROM cloud_runs
       WHERE account_id = ? AND state = 'queued' AND enqueued_seq < ?`,
    ).get(record.accountId, record.enqueuedSeq) as SQLiteRow;
    const ahead = Number(row.total ?? 0);
    return { queuePosition: ahead + 1, ahead };
  }

  countInFlight(accountId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total FROM cloud_runs
       WHERE account_id = ? AND state IN ('running', 'waiting-approval', 'waiting-reconnect')`,
    ).get(accountId) as SQLiteRow;
    return Number(row.total ?? 0);
  }

  listInFlightRuns(): CloudRunRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM cloud_runs
       WHERE state IN ('running', 'waiting-approval', 'waiting-reconnect')
       ORDER BY created_at ASC, run_id ASC`,
    ).all() as SQLiteRow[];
    return rows.map(rowToRecord);
  }

  listQueuedAccountIds(): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT account_id FROM cloud_runs
       WHERE state = 'queued' AND request_json IS NOT NULL AND enqueued_seq IS NOT NULL`,
    ).all() as SQLiteRow[];
    return rows.map((row) => String(row.account_id));
  }

  bindExecutionRunId(runId: string, executionRunId: string, now: number): CloudRunRecord {
    this.db.prepare(
      'UPDATE cloud_runs SET execution_run_id = ?, updated_at = ? WHERE run_id = ? AND execution_run_id IS NULL',
    ).run(executionRunId, now, runId);
    const updated = this.getRun(runId);
    if (updated?.executionRunId !== executionRunId) {
      throw new Error(`Cloud run ${runId} already has a different execution run id`);
    }
    return updated;
  }

  requestCancel(runId: string, now: number): CloudRunRecord {
    this.db.prepare(
      `UPDATE cloud_runs SET cancel_requested_at = ?, updated_at = ?
       WHERE run_id = ? AND cancel_requested_at IS NULL`,
    ).run(now, now, runId);
    const updated = this.getRun(runId);
    if (!updated) throw new Error(`Unknown cloud run: ${runId}`);
    return updated;
  }

  promoteNext(accountId: string, maxInFlight: number, now: number): {
    record: CloudRunRecord;
    transition: CloudRunTransitionRecord;
  } | null {
    const promote = this.db.transaction((): {
      record: CloudRunRecord;
      transition: CloudRunTransitionRecord;
    } | null => {
      if (this.countInFlight(accountId) >= maxInFlight) return null;
      const candidates = this.db.prepare(
        `SELECT * FROM cloud_runs
         WHERE account_id = ? AND state = 'queued'
           AND request_json IS NOT NULL AND enqueued_seq IS NOT NULL
         ORDER BY enqueued_seq ASC`,
      ).all(accountId) as SQLiteRow[];
      for (const row of candidates) {
        const candidate = rowToRecord(row);
        const sessionConflict = this.db.prepare(
          `SELECT 1 FROM cloud_runs
           WHERE account_id = ? AND session_id = ? AND run_id != ?
             AND state IN ('queued', 'running', 'waiting-approval', 'waiting-reconnect')
           LIMIT 1`,
        ).get(accountId, candidate.sessionId, candidate.runId);
        if (sessionConflict) continue;
        const transition = this.applyTransitionInTransaction({
          runId: candidate.runId,
          fromState: 'queued',
          toState: 'running',
          now,
        });
        const record = this.getRun(candidate.runId);
        if (!record) throw new Error(`Cloud run ${candidate.runId} disappeared during promotion`);
        return { record, transition };
      }
      return null;
    });
    return promote.immediate();
  }

  countRuns(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM cloud_runs').get() as SQLiteRow;
    return Number(row.total ?? 0);
  }

  /** 行更新 + 迁移记录同事务；from_state 不匹配（并发改写）即抛错回滚。 */
  applyTransition(input: ApplyCloudRunTransitionInput): CloudRunTransitionRecord {
    return this.db.transaction(() => this.applyTransitionInTransaction(input))();
  }

  private applyTransitionInTransaction(input: ApplyCloudRunTransitionInput): CloudRunTransitionRecord {
    const result = this.db
      .prepare('UPDATE cloud_runs SET state = ?, updated_at = ? WHERE run_id = ? AND state = ?')
      .run(input.toState, input.now, input.runId, input.fromState);
    if (result.changes !== 1) {
      throw new Error(
        `Cloud run ${input.runId} transition ${input.fromState} -> ${input.toState} did not apply; state moved concurrently`,
      );
    }
    const inserted = this.db
      .prepare('INSERT INTO cloud_run_transitions (run_id, from_state, to_state, at) VALUES (?, ?, ?, ?)')
      .run(input.runId, input.fromState, input.toState, input.now);
    return {
      seq: Number(inserted.lastInsertRowid),
      runId: input.runId,
      fromState: input.fromState,
      toState: input.toState,
      at: input.now,
    };
  }

  /** seq 全序；afterSeq 供重启后补读增量（ADR-087 失败模式：重启续听）。 */
  listTransitions(afterSeq = 0): CloudRunTransitionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM cloud_run_transitions WHERE seq > ? ORDER BY seq ASC')
      .all(afterSeq) as SQLiteRow[];
    return rows.map(rowToTransition);
  }
}
