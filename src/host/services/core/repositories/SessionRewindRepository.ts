import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

import type { Message } from '../../../../shared/contract';
import type { ConversationBoundary } from '../../../../shared/contract/conversationBranch';
import { activeMessageWhere, rowToMessage } from './sessionRepositoryParsers';
import type { ConversationBranchRepository } from './ConversationBranchRepository';

type SQLiteRow = Record<string, unknown>;

export interface PromptRewindRecordInput {
  idempotencyKey?: string;
  checkpointMessageId?: string | null;
  filesRestored?: number;
  filesDeleted?: number;
  errors?: string[];
  createdAt?: number;
  /**
   * Exact authenticated owner boundary. `null` explicitly means a local /
   * anonymous session; `undefined` is rejected so callers cannot silently
   * bypass the owner check.
   */
  ownerUserId?: string | null;
}

export interface PromptRewindResult {
  rewindId: string;
  anchorMessage: Message;
  hiddenMessageIds: string[];
  hiddenMessageCount: number;
  activeMessages: Message[];
}

export interface PromptRewindRestoreResult {
  rewindId: string;
  restoredMessageCount: number;
  activeMessages: Message[];
}

const FORBIDDEN_SESSION_STATES = new Set([
  'running',
  'paused',
  'queued',
  'cancelling',
]);

const ACTIVE_DURABLE_RUN_STATES = new Set([
  'created',
  'running',
  'waiting',
  'paused',
  'recovering',
]);

function sqliteTableExists(db: BetterSqlite3.Database, tableName: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName) as { found?: number } | undefined;
  return row?.found === 1;
}

export class SessionRewindRepository {
  private readonly sessionsHaveProjectId: boolean;

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly conversationBranchRepo: ConversationBranchRepository | null,
  ) {
    this.sessionsHaveProjectId = (
      db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    ).some((column) => column.name === 'project_id');
  }

  applyPromptRewind(
    sessionId: string,
    userMessageId: string,
    record: PromptRewindRecordInput = {},
  ): PromptRewindResult {
    const now = record.createdAt ?? Date.now();
    const rewindId = `rewind_${now}_${uuidv4().slice(0, 8)}`;
    const idempotencyKey = record.idempotencyKey?.trim() || null;
    const requestDigest = createHash('sha256')
      .update(JSON.stringify({ sessionId, userMessageId }))
      .digest('hex');

    const applyFn = this.db.transaction(() => {
      this.assertMutationAllowed(sessionId, record.ownerUserId);
      if (idempotencyKey) {
        const existing = this.db.prepare(`
          SELECT *
          FROM session_rewinds
          WHERE session_id = ? AND idempotency_key = ?
          LIMIT 1
        `).get(sessionId, idempotencyKey) as SQLiteRow | undefined;
        if (existing) {
          if (String(existing.request_digest ?? '') !== requestDigest) {
            throw new Error(
              'IDEMPOTENCY_CONFLICT: the idempotency key was already used for another rewind',
            );
          }
          if (String(existing.status ?? 'completed') === 'restored') {
            throw new Error(
              'IDEMPOTENCY_CONFLICT: the rewind was already restored; use a new idempotency key',
            );
          }
          if (String(existing.status ?? 'completed') !== 'completed') {
            throw new Error(
              `IDEMPOTENCY_CONFLICT: the existing rewind is ${String(existing.status)}`,
            );
          }
          return this.readResult(existing);
        }
      }

      const anchorRow = this.db.prepare(`
        SELECT rowid AS __rowid, *
        FROM messages
        WHERE session_id = ?
          AND id = ?
          AND role = 'user'
          AND ${activeMessageWhere('messages')}
        LIMIT 1
      `).get(sessionId, userMessageId) as SQLiteRow | undefined;
      if (!anchorRow) {
        throw new Error(`Active user message not found: ${userMessageId}`);
      }

      const anchorMessage = rowToMessage(anchorRow);
      const anchorRowId = Number(anchorRow.__rowid || 0);
      const anchorTimestamp = Number(anchorRow.timestamp);
      const rowsToHide = this.db.prepare(`
        SELECT id
        FROM messages
        WHERE session_id = ?
          AND (
            timestamp > ?
            OR (timestamp = ? AND rowid >= ?)
          )
          AND ${activeMessageWhere('messages')}
        ORDER BY timestamp ASC, rowid ASC
      `).all(
        sessionId,
        anchorTimestamp,
        anchorTimestamp,
        anchorRowId,
      ) as Array<{ id: string }>;
      const hiddenMessageIds = rowsToHide.map((row) => String(row.id));
      this.hideProjectionSuffix(sessionId, hiddenMessageIds, rewindId, now);

      this.db.prepare(`
        INSERT INTO session_rewinds (
          id, session_id, anchor_message_id, anchor_prompt, anchor_timestamp,
          checkpoint_message_id, hidden_message_count, hidden_message_ids,
          files_restored, files_deleted, errors_json, idempotency_key,
          request_digest, status, restored_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', NULL, ?)
      `).run(
        rewindId,
        sessionId,
        userMessageId,
        anchorMessage.content,
        anchorMessage.timestamp,
        record.checkpointMessageId ?? null,
        hiddenMessageIds.length,
        JSON.stringify(hiddenMessageIds),
        record.filesRestored ?? 0,
        record.filesDeleted ?? 0,
        JSON.stringify(record.errors ?? []),
        idempotencyKey,
        requestDigest,
        now,
      );

      this.conversationBranchRepo?.recordRewind({
        sessionId,
        boundary: this.readBoundary(sessionId),
        anchorMessageId: userMessageId,
        hiddenMessageIds,
        rewindId,
        idempotencyKey: `session-rewind:${idempotencyKey ?? rewindId}`,
        createdAt: now,
      });
      this.db.prepare(
        'UPDATE sessions SET updated_at = ?, synced_at = NULL WHERE id = ?',
      ).run(now, sessionId);
      const persisted = this.db.prepare(
        'SELECT * FROM session_rewinds WHERE id = ?',
      ).get(rewindId) as SQLiteRow;
      return this.readResult(persisted);
    });
    return applyFn.immediate();
  }

  restorePromptRewind(
    sessionId: string,
    rewindId: string,
    restoredAt = Date.now(),
    ownerUserId?: string | null,
  ): PromptRewindRestoreResult {
    const restoreFn = this.db.transaction(() => {
      this.assertMutationAllowed(sessionId, ownerUserId);
      const rewind = this.db.prepare(`
        SELECT id, status
        FROM session_rewinds
        WHERE id = ? AND session_id = ?
        LIMIT 1
      `).get(rewindId, sessionId) as { id: string; status: string } | undefined;
      if (!rewind) throw new Error(`Rewind not found: ${rewindId}`);
      if (rewind.status === 'restored') {
        return { rewindId, restoredMessageCount: 0, activeMessages: this.getActiveMessages(sessionId) };
      }
      if (rewind.status !== 'completed') {
        throw new Error(`Rewind cannot be restored from status ${rewind.status}`);
      }

      const latestCompleted = this.db.prepare(`
        SELECT id
        FROM session_rewinds
        WHERE session_id = ? AND status = 'completed'
        ORDER BY rowid DESC
        LIMIT 1
      `).get(sessionId) as { id: string } | undefined;
      if (latestCompleted?.id !== rewindId) {
        throw new Error(
          `REWIND_RESTORE_ORDER: restore ${latestCompleted?.id ?? 'none'} before ${rewindId}`,
        );
      }

      this.conversationBranchRepo?.recordRewindRestore({
        sessionId,
        boundary: this.readBoundary(sessionId),
        rewindId,
        idempotencyKey: `session-rewind-restore:${rewindId}`,
        createdAt: restoredAt,
      });
      const result = this.db.prepare(`
        UPDATE messages
        SET visibility = 'active',
            hidden_by_rewind_id = NULL,
            hidden_at = NULL,
            synced_at = NULL
        WHERE session_id = ?
          AND hidden_by_rewind_id = ?
          AND visibility = 'rewound'
      `).run(sessionId, rewindId);
      this.db.prepare(`
        UPDATE session_rewinds
        SET status = 'restored', restored_at = ?
        WHERE id = ? AND session_id = ?
      `).run(restoredAt, rewindId, sessionId);
      this.db.prepare(
        'UPDATE sessions SET updated_at = ?, synced_at = NULL WHERE id = ?',
      ).run(restoredAt, sessionId);
      return {
        rewindId,
        restoredMessageCount: result.changes,
        activeMessages: this.getActiveMessages(sessionId),
      };
    });
    return restoreFn.immediate();
  }

  private assertMutationAllowed(
    sessionId: string,
    ownerUserId: string | null | undefined,
  ): void {
    if (
      ownerUserId === undefined
      || (typeof ownerUserId === 'string' && ownerUserId.trim().length === 0)
    ) {
      throw new Error('SESSION_ACCESS_DENIED: an explicit owner boundary is required');
    }
    const session = this.db.prepare(`
      SELECT status
      FROM sessions
      WHERE id = ?
        AND COALESCE(is_deleted, 0) = 0
        AND ((? IS NULL AND user_id IS NULL) OR user_id = ?)
      LIMIT 1
    `).get(sessionId, ownerUserId, ownerUserId) as { status?: string } | undefined;
    if (!session) {
      throw new Error('SESSION_ACCESS_DENIED: session not found or owner mismatch');
    }
    const status = String(session.status ?? 'idle');
    if (FORBIDDEN_SESSION_STATES.has(status)) {
      throw new Error(`SESSION_RUNNING: session is ${status}`);
    }
    if (sqliteTableExists(this.db, 'durable_runs')) {
      const activeRun = (this.db.prepare(`
        SELECT run_id, status
        FROM durable_runs
        WHERE session_id = ?
      `).all(sessionId) as Array<{ run_id: string; status: string }>)
        .find((run) => ACTIVE_DURABLE_RUN_STATES.has(String(run.status)));
      if (activeRun) {
        throw new Error(`SESSION_RUNNING: durable run ${activeRun.run_id} is ${activeRun.status}`);
      }
    }
  }

  private hideProjectionSuffix(
    sessionId: string,
    hiddenMessageIds: string[],
    rewindId: string,
    now: number,
  ): void {
    if (hiddenMessageIds.length === 0) return;
    const placeholders = hiddenMessageIds.map(() => '?').join(',');
    this.db.prepare(`
      UPDATE messages
      SET visibility = 'rewound',
          hidden_by_rewind_id = ?,
          hidden_at = ?,
          synced_at = NULL
      WHERE session_id = ?
        AND id IN (${placeholders})
    `).run(rewindId, now, sessionId, ...hiddenMessageIds);
    if (!sqliteTableExists(this.db, 'generative_ui_instances')) return;
    this.db.prepare(`
      UPDATE generative_ui_instances SET status = 'hidden', updated_at = ?
      WHERE session_id = ? AND source_message_id IN (${placeholders}) AND status = 'active'
    `).run(now, sessionId, ...hiddenMessageIds);
    this.db.prepare(`
      UPDATE execution_manifests
      SET status = 'invalidated', updated_at = ?, resolved_at = ?,
          invalidation_reason = 'SOURCE_REWOUND'
      WHERE session_id = ? AND instance_id IN (
        SELECT instance_id FROM generative_ui_instances
        WHERE session_id = ? AND source_message_id IN (${placeholders})
      ) AND status IN ('pending', 'approved', 'executing')
    `).run(now, now, sessionId, sessionId, ...hiddenMessageIds);
  }

  private readBoundary(sessionId: string): ConversationBoundary {
    const row = this.db.prepare(`
      SELECT user_id, ${this.sessionsHaveProjectId ? 'project_id' : 'NULL AS project_id'}
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(sessionId) as { user_id: string | null; project_id: string | null } | undefined;
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    return { ownerUserId: row.user_id, projectId: row.project_id };
  }

  private getActiveMessages(sessionId: string): Message[] {
    return (this.db.prepare(`
      SELECT *
      FROM messages
      WHERE session_id = ? AND ${activeMessageWhere('messages')}
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId) as SQLiteRow[]).map((row) => rowToMessage(row));
  }

  private getMessageById(
    sessionId: string,
    messageId: string,
    includeRewound = false,
  ): Message | null {
    const row = this.db.prepare(`
      SELECT *
      FROM messages
      WHERE session_id = ? AND id = ?
      ${includeRewound ? '' : `AND ${activeMessageWhere('messages')}`}
      LIMIT 1
    `).get(sessionId, messageId) as SQLiteRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  private readResult(row: SQLiteRow): PromptRewindResult {
    const sessionId = String(row.session_id);
    const anchorMessage = this.getMessageById(
      sessionId,
      String(row.anchor_message_id),
      true,
    );
    if (!anchorMessage) {
      throw new Error(`Rewind anchor is missing: ${String(row.anchor_message_id)}`);
    }
    let parsedHiddenMessageIds: unknown;
    try {
      parsedHiddenMessageIds = JSON.parse(String(row.hidden_message_ids ?? '[]')) as unknown;
    } catch {
      throw new Error(`Rewind audit is corrupt: ${String(row.id)}`);
    }
    const hiddenMessageIds = Array.isArray(parsedHiddenMessageIds)
      ? parsedHiddenMessageIds.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      rewindId: String(row.id),
      anchorMessage,
      hiddenMessageIds,
      hiddenMessageCount: Number(row.hidden_message_count ?? hiddenMessageIds.length),
      activeMessages: this.getActiveMessages(sessionId),
    };
  }
}
