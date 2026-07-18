// ============================================================================
// QueuedInputRepository — queued next-turn input durable ledger (ADR-044 D1)
// ============================================================================
//
// id is the eventual user message's clientMessageId. Re-enqueueing the same id
// is idempotent and must never overwrite an input that has already advanced.
// Every lifecycle transition is guarded in SQL so concurrent drain/retract
// attempts cannot both claim the same row.
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';

type SQLiteRow = Record<string, unknown>;

export type QueuedInputStatus =
  | 'queued'
  | 'sending'
  | 'consumed'
  | 'retracted'
  | 'failed';

export interface QueuedInputRecord {
  id: string;
  sessionId: string;
  envelopeJson: string;
  status: QueuedInputStatus;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
}

interface EnqueueQueuedInputBase {
  id: string;
  sessionId: string;
  now?: number;
}

export type EnqueueQueuedInputInput = EnqueueQueuedInputBase & (
  | { envelope: unknown; envelopeJson?: never }
  | { envelopeJson: string; envelope?: never }
);

function rowToRecord(row: SQLiteRow): QueuedInputRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    envelopeJson: String(row.envelope_json ?? 'null'),
    status: row.status as QueuedInputStatus,
    retryCount: Number(row.retry_count) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export class QueuedInputRepository {
  constructor(private db: BetterSqlite3.Database) {}

  enqueue(input: EnqueueQueuedInputInput): void {
    let envelopeJson: string;
    if (typeof input.envelopeJson === 'string') {
      envelopeJson = input.envelopeJson;
    } else {
      try {
        envelopeJson = JSON.stringify(input.envelope ?? null);
      } catch {
        envelopeJson = 'null';
      }
    }

    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO queued_inputs (
          id, session_id, envelope_json, status, retry_count, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
      )
      .run(input.id, input.sessionId, envelopeJson, now, now);
  }

  listBySession(sessionId: string, status?: QueuedInputStatus): QueuedInputRecord[] {
    const rows = status
      ? this.db
          .prepare(
            `SELECT * FROM queued_inputs
             WHERE session_id = ? AND status = ?
             ORDER BY created_at ASC`,
          )
          .all(sessionId, status)
      : this.db
          .prepare(
            `SELECT * FROM queued_inputs
             WHERE session_id = ?
             ORDER BY created_at ASC`,
          )
          .all(sessionId);

    return (rows as SQLiteRow[]).map(rowToRecord);
  }

  markSending(id: string, now?: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE queued_inputs
         SET status = 'sending', updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now ?? Date.now(), id);
    return result.changes === 1;
  }

  markConsumed(id: string, now?: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE queued_inputs
         SET status = 'consumed', updated_at = ?
         WHERE id = ? AND status = 'sending'`,
      )
      .run(now ?? Date.now(), id);
    return result.changes === 1;
  }

  markFailed(id: string, now?: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE queued_inputs
         SET status = 'failed', updated_at = ?
         WHERE id = ? AND status IN ('queued', 'sending')`,
      )
      .run(now ?? Date.now(), id);
    return result.changes === 1;
  }

  requeueAfterFailure(id: string, now?: number): { retryCount: number } | null {
    const row = this.db
      .prepare(
        `UPDATE queued_inputs
         SET status = 'queued', retry_count = retry_count + 1, updated_at = ?
         WHERE id = ? AND status = 'sending'
         RETURNING retry_count`,
      )
      .get(now ?? Date.now(), id) as SQLiteRow | undefined;

    return row ? { retryCount: Number(row.retry_count) || 0 } : null;
  }

  retract(id: string, now?: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE queued_inputs
         SET status = 'retracted', updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now ?? Date.now(), id);
    return result.changes === 1;
  }

  getById(id: string): QueuedInputRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM queued_inputs WHERE id = ?`)
      .get(id) as SQLiteRow | undefined;
    return row ? rowToRecord(row) : null;
  }
}
