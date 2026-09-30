// ============================================================================
// SessionDelegationRepository — delegation links (ADR-072 D5)
// ============================================================================
// Synchronous SQLite only. Does not open a transaction: a later ticket commits
// this row and the queued_inputs row in one outer transaction.
// status is the chain, not the target run. completed / failed / cancelled are
// not stored; those are read off durable_runs by target_run_id.
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';

type SQLiteRow = Record<string, unknown>;

const SESSION_DELEGATION_STATUSES = [
  'active',
  'superseded',
  'stopped',
  'aborted',
  'terminal_observed',
] as const;

export type SessionDelegationStatus = (typeof SESSION_DELEGATION_STATUSES)[number];

export type SessionDelegationDisposition = 'delegate_existing' | 'create_new';

export type SessionDelegationAbortReason = 'delivery_failed' | 'retracted_by_user';

export interface SessionDelegationRecord {
  delegationId: string;
  originSessionId: string;
  originTurnId: string;
  disposition: SessionDelegationDisposition;
  targetSessionId: string;
  targetMessageId: string | null;
  targetQueuedInputId: string | null;
  targetRunId: string | null;
  submissionKey: string;
  actionFingerprint: string;
  status: SessionDelegationStatus;
  supersedesDelegationId: string | null;
  createdAt: number;
  resolvedAt: number | null;
  resolutionJson: string | null;
}

export interface InsertSessionDelegationInput {
  delegationId: string;
  originSessionId: string;
  originTurnId: string;
  disposition: SessionDelegationDisposition;
  targetSessionId: string;
  targetMessageId?: string | null;
  targetQueuedInputId?: string | null;
  submissionKey: string;
  actionFingerprint: string;
  supersedesDelegationId?: string | null;
  createdAt: number;
}

export type InsertSessionDelegationResult =
  | { kind: 'created'; record: SessionDelegationRecord }
  | { kind: 'reused'; record: SessionDelegationRecord }
  | { kind: 'idempotency_conflict'; record: SessionDelegationRecord };

const ABORT_REASONS = new Set<SessionDelegationAbortReason>(['delivery_failed', 'retracted_by_user']);

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function rowToRecord(row: SQLiteRow): SessionDelegationRecord {
  return {
    delegationId: String(row.delegation_id),
    originSessionId: String(row.origin_session_id),
    originTurnId: String(row.origin_turn_id),
    disposition: row.disposition as SessionDelegationDisposition,
    targetSessionId: String(row.target_session_id),
    targetMessageId: nullableString(row.target_message_id),
    targetQueuedInputId: nullableString(row.target_queued_input_id),
    targetRunId: nullableString(row.target_run_id),
    submissionKey: String(row.submission_key),
    actionFingerprint: String(row.action_fingerprint),
    status: row.status as SessionDelegationStatus,
    supersedesDelegationId: nullableString(row.supersedes_delegation_id),
    createdAt: Number(row.created_at),
    resolvedAt: nullableNumber(row.resolved_at),
    resolutionJson: nullableString(row.resolution_json),
  };
}

function isSubmissionKeyConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  const uniqueCode = candidate.code === 'SQLITE_CONSTRAINT_UNIQUE' || candidate.code === 'SQLITE_CONSTRAINT';
  return uniqueCode && message.includes('session_delegations.submission_key');
}

function abortResolutionJson(reason: SessionDelegationAbortReason): string {
  return JSON.stringify({ reason });
}

function finiteTimestamp(now: number): boolean {
  return Number.isFinite(now);
}

export class SessionDelegationRepository {
  constructor(private db: BetterSqlite3.Database) {}

  insertOrGet(input: InsertSessionDelegationInput): InsertSessionDelegationResult {
    const existing = this.getBySubmissionKey(input.submissionKey);
    if (existing) {
      return {
        kind: existing.actionFingerprint === input.actionFingerprint ? 'reused' : 'idempotency_conflict',
        record: existing,
      };
    }

    try {
      this.db.prepare(
        `INSERT INTO session_delegations (
          delegation_id, origin_session_id, origin_turn_id, disposition,
          target_session_id, target_message_id, target_queued_input_id, target_run_id,
          submission_key, action_fingerprint, status, supersedes_delegation_id,
          created_at, resolved_at, resolution_json
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, NULL,
          ?, ?, 'active', ?,
          ?, NULL, NULL
        )`,
      ).run(
        input.delegationId,
        input.originSessionId,
        input.originTurnId,
        input.disposition,
        input.targetSessionId,
        input.targetMessageId ?? null,
        input.targetQueuedInputId ?? null,
        input.submissionKey,
        input.actionFingerprint,
        input.supersedesDelegationId ?? null,
        input.createdAt,
      );
    } catch (error) {
      if (!isSubmissionKeyConflict(error)) throw error;
      const raced = this.getBySubmissionKey(input.submissionKey);
      if (!raced) throw error;
      return {
        kind: raced.actionFingerprint === input.actionFingerprint ? 'reused' : 'idempotency_conflict',
        record: raced,
      };
    }

    const created = this.get(input.delegationId);
    if (!created) {
      throw new Error('session delegation insert did not persist');
    }
    return { kind: 'created', record: created };
  }

  get(delegationId: string): SessionDelegationRecord | null {
    return this.one(
      `SELECT * FROM session_delegations WHERE delegation_id = ?`,
      delegationId,
    );
  }

  getBySubmissionKey(submissionKey: string): SessionDelegationRecord | null {
    return this.one(
      `SELECT * FROM session_delegations WHERE submission_key = ?`,
      submissionKey,
    );
  }

  /** Earliest row when several share a queued-input id. The normal case is one row. */
  getByTargetQueuedInputId(targetQueuedInputId: string): SessionDelegationRecord | null {
    return this.one(
      `SELECT * FROM session_delegations
       WHERE target_queued_input_id = ?
       ORDER BY created_at ASC, delegation_id ASC
       LIMIT 1`,
      targetQueuedInputId,
    );
  }

  listByTargetSession(
    targetSessionId: string,
    statuses?: readonly SessionDelegationStatus[],
  ): SessionDelegationRecord[] {
    const selected = statuses?.filter((status) => SESSION_DELEGATION_STATUSES.includes(status));
    if (selected?.length === 0) return [];
    const statusClause = selected
      ? ` AND status IN (${selected.map(() => '?').join(', ')})`
      : '';
    return this.many(
      `SELECT * FROM session_delegations
       WHERE target_session_id = ?${statusClause}
       ORDER BY created_at ASC, delegation_id ASC`,
      targetSessionId,
      ...(selected ?? []),
    );
  }

  listByOriginTurn(originSessionId: string, originTurnId: string): SessionDelegationRecord[] {
    return this.many(
      `SELECT * FROM session_delegations
       WHERE origin_session_id = ? AND origin_turn_id = ?
       ORDER BY created_at ASC, delegation_id ASC`,
      originSessionId,
      originTurnId,
    );
  }

  /** INV-4. Sets target_run_id once. A later call does not overwrite. */
  backfillTargetRunId(delegationId: string, runId: string): number {
    return this.changes(
      `UPDATE session_delegations
       SET target_run_id = ?
       WHERE delegation_id = ? AND status = 'active' AND target_run_id IS NULL`,
      runId,
      delegationId,
    );
  }

  /**
   * From active or stopped. Already terminal_observed is a no-op and keeps
   * the first resolved_at. superseded and aborted are not sources.
   */
  markTerminalObserved(delegationId: string, now: number): number {
    if (!finiteTimestamp(now)) return 0;
    return this.changes(
      `UPDATE session_delegations
       SET status = 'terminal_observed', resolved_at = ?
       WHERE delegation_id = ? AND status IN ('active', 'stopped')`,
      now,
      delegationId,
    );
  }

  markStopped(delegationId: string, resolution: unknown, now: number): number {
    if (!finiteTimestamp(now)) return 0;
    const resolutionJson = encodeResolution(resolution);
    if (resolutionJson === null) return 0;
    return this.changes(
      `UPDATE session_delegations
       SET status = 'stopped', resolution_json = ?, resolved_at = ?
       WHERE delegation_id = ? AND status = 'active'`,
      resolutionJson,
      now,
      delegationId,
    );
  }

  /**
   * stopped → active. Clears resolved_at and resolution_json because the row
   * is unresolved again. No updated_at column, so `now` is only a clock check.
   * target_run_id stays: this method does not receive a new run id.
   */
  markResumed(delegationId: string, now: number): number {
    if (!finiteTimestamp(now)) return 0;
    return this.changes(
      `UPDATE session_delegations
       SET status = 'active', resolved_at = NULL, resolution_json = NULL
       WHERE delegation_id = ? AND status = 'stopped'`,
      delegationId,
    );
  }

  markSuperseded(delegationId: string, now: number): number {
    if (!finiteTimestamp(now)) return 0;
    return this.changes(
      `UPDATE session_delegations
       SET status = 'superseded', resolved_at = ?
       WHERE delegation_id = ? AND status = 'active'`,
      now,
      delegationId,
    );
  }

  /**
   * active → aborted(reason). aborted(delivery_failed) may move to
   * retracted_by_user. The reverse, and any other source, changes nothing.
   */
  markAborted(delegationId: string, reason: SessionDelegationAbortReason, now: number): number {
    if (!finiteTimestamp(now) || !ABORT_REASONS.has(reason)) return 0;
    return this.changes(
      `UPDATE session_delegations
       SET status = 'aborted', resolution_json = ?, resolved_at = ?
       WHERE delegation_id = ?
         AND (
           status = 'active'
           OR (
             status = 'aborted'
             AND json_extract(resolution_json, '$.reason') = 'delivery_failed'
             AND ? = 'retracted_by_user'
           )
         )`,
      abortResolutionJson(reason),
      now,
      delegationId,
      reason,
    );
  }

  /**
   * INV-6. Only aborted(delivery_failed) returns to active, with the new run
   * id. retracted_by_user stays aborted.
   */
  reviveAfterResend(delegationId: string, newRunId: string, now: number): number {
    if (!finiteTimestamp(now)) return 0;
    return this.changes(
      `UPDATE session_delegations
       SET status = 'active',
           target_run_id = ?,
           resolved_at = NULL,
           resolution_json = NULL
       WHERE delegation_id = ?
         AND status = 'aborted'
         AND json_extract(resolution_json, '$.reason') = 'delivery_failed'`,
      newRunId,
      delegationId,
    );
  }

  private changes(sql: string, ...params: Array<string | number | null>): number {
    return this.db.prepare(sql).run(...params).changes;
  }

  private one(sql: string, ...params: Array<string | number | null>): SessionDelegationRecord | null {
    const row = this.db.prepare(sql).get(...params) as SQLiteRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  private many(sql: string, ...params: Array<string | number | null>): SessionDelegationRecord[] {
    const rows = this.db.prepare(sql).all(...params) as SQLiteRow[];
    return rows.map(rowToRecord);
  }
}

function encodeResolution(resolution: unknown): string | null {
  try {
    const encoded = JSON.stringify(resolution);
    return typeof encoded === 'string' ? encoded : null;
  } catch {
    return null;
  }
}
