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
  position: number;
  pausedReason: string | null;
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
    position: Number(row.position) || 0,
    pausedReason: typeof row.paused_reason === 'string' ? row.paused_reason : null,
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
          id, session_id, envelope_json, status, retry_count, position,
          paused_reason, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'queued', 0,
          COALESCE((SELECT MAX(position) + 1 FROM queued_inputs WHERE session_id = ?), 0),
          NULL, ?, ?
        )`,
      )
      .run(input.id, input.sessionId, envelopeJson, input.sessionId, now, now);
  }

  listBySession(sessionId: string, status?: QueuedInputStatus): QueuedInputRecord[] {
    const rows = status
      ? this.db
          .prepare(
            `SELECT * FROM queued_inputs
             WHERE session_id = ? AND status = ?
             ORDER BY position ASC, created_at ASC, id ASC`,
          )
          .all(sessionId, status)
      : this.db
          .prepare(
            `SELECT * FROM queued_inputs
             WHERE session_id = ?
             ORDER BY position ASC, created_at ASC, id ASC`,
          )
          .all(sessionId);

    return (rows as SQLiteRow[]).map(rowToRecord);
  }

  listSessionsWithQueuedInputs(): string[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, MIN(position) AS first_position, MIN(created_at) AS first_created
         FROM queued_inputs
         WHERE status = 'queued' AND paused_reason IS NULL
         GROUP BY session_id
         ORDER BY first_position ASC, first_created ASC, session_id ASC`,
      )
      .all() as { session_id: string }[];
    return rows.map((row) => row.session_id);
  }

  getNextDispatchable(sessionId: string): QueuedInputRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM queued_inputs
       WHERE session_id = ? AND status = 'queued' AND paused_reason IS NULL
       ORDER BY position ASC, created_at ASC, id ASC
       LIMIT 1`,
    ).get(sessionId) as SQLiteRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  markSending(id: string, now?: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE queued_inputs
         SET status = 'sending', paused_reason = NULL, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now ?? Date.now(), id);
    return result.changes === 1;
  }

  markSendingForRetry(id: string, now?: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE queued_inputs
         SET status = 'sending', paused_reason = NULL, updated_at = ?
         WHERE id = ? AND status = 'failed' AND paused_reason IS NOT NULL`,
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

  markFailed(id: string, now?: number, pausedReason = 'send_failed'): boolean {
    const result = this.db
      .prepare(
        `UPDATE queued_inputs
         SET status = 'failed', paused_reason = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'sending')`,
      )
      .run(pausedReason, now ?? Date.now(), id);
    return result.changes === 1;
  }

  requeueAfterFailure(id: string, now?: number): { retryCount: number } | null {
    const row = this.db
      .prepare(
        `UPDATE queued_inputs
         SET status = 'queued', retry_count = retry_count + 1,
             paused_reason = NULL, updated_at = ?
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
         WHERE id = ? AND status IN ('queued', 'failed')`,
      )
      .run(now ?? Date.now(), id);
    return result.changes === 1;
  }

  updateEnvelope(id: string, envelopeJson: string, now?: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE queued_inputs
         SET envelope_json = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(envelopeJson, now ?? Date.now(), id);
    return result.changes === 1;
  }

  reorder(sessionId: string, orderedIds: string[], now?: number): boolean {
    const reorderTransaction = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT id FROM queued_inputs
         WHERE session_id = ? AND status IN ('queued', 'failed')`,
      ).all(sessionId) as Array<{ id: string }>;
      if (rows.length !== orderedIds.length) return false;
      const currentIds = new Set(rows.map((row) => row.id));
      if (currentIds.size !== orderedIds.length || orderedIds.some((id) => !currentIds.has(id))) {
        return false;
      }
      const update = this.db.prepare(
        `UPDATE queued_inputs SET position = ?, updated_at = ?
         WHERE id = ? AND session_id = ? AND status IN ('queued', 'failed')`,
      );
      const timestamp = now ?? Date.now();
      orderedIds.forEach((id, position) => update.run(position, timestamp, id, sessionId));
      return true;
    });
    return reorderTransaction();
  }

  recoverSendingOrphans(now?: number): number {
    const result = this.db.prepare(
      `UPDATE queued_inputs
       SET status = 'queued', paused_reason = 'restart', updated_at = ?
       WHERE status = 'sending'`,
    ).run(now ?? Date.now());
    return result.changes;
  }

  requeueRedirectedInput(id: string, now?: number): boolean {
    const result = this.db.prepare(
      `UPDATE queued_inputs
       SET status = 'queued', paused_reason = NULL, updated_at = ?
       WHERE id = ? AND status = 'sending'`,
    ).run(now ?? Date.now(), id);
    return result.changes === 1;
  }

  getById(id: string): QueuedInputRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM queued_inputs WHERE id = ?`)
      .get(id) as SQLiteRow | undefined;
    return row ? rowToRecord(row) : null;
  }
}
