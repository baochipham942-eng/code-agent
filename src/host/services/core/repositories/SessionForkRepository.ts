import { createHash, randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { Message } from '../../../../shared/contract/message';
import type { ExternalAgentEngineKind } from '../../../../shared/contract/agentEngine';

import {
  SessionForkError,
  type SessionForkContextDeliveryMode,
  type SessionForkLineageSummary,
  type SessionForkMessageMapping,
  type SessionForkWorkspaceMode,
} from '../../../../shared/contract/sessionFork';
import { rowToMessage } from './sessionRepositoryParsers';
import { ConversationBranchRepository } from './ConversationBranchRepository';

type SQLiteRow = Record<string, unknown>;

export interface CreateForkRepositoryInput {
  sourceSessionId: string;
  anchorAssistantMessageId: string;
  idempotencyKey: string;
  ownerUserId?: string | null;
  forkId: string;
  childSessionId: string;
  childTitle: string;
  workspaceMode: SessionForkWorkspaceMode;
  contextDeliveryMode: SessionForkContextDeliveryMode;
  childWorkingDirectory?: string;
  workspaceSnapshotId?: string;
  now?: number;
}

export interface CreateForkRepositoryResult {
  forkId: string;
  childSessionId: string;
  copiedMessageCount: number;
  sourcePrefixDigest: string;
  lineage: SessionForkLineageSummary;
  messageMappings: SessionForkMessageMapping[];
}

export interface SessionForkContextSource {
  lineage: SessionForkLineageSummary;
  sourcePrefixDigest: string;
  mappedActivePrefix: Array<{
    ordinal: number;
    sourceMessageId: string;
    childMessageId: string;
    message: Message;
  }>;
}

export type SessionForkContextHandoffState = 'pending' | 'dispatching' | 'consumed' | 'blocked';

export interface SessionForkContextHandoffRecord {
  forkId: string;
  engine: 'codex_cli' | 'claude_code';
  payloadDigest: string;
  state: SessionForkContextHandoffState;
  attemptId: string | null;
  preparedAt: number;
  dispatchStartedAt: number | null;
  consumedAt: number | null;
  error: Record<string, unknown> | null;
}

const FORBIDDEN_SOURCE_STATES = new Set(['running', 'queued', 'paused', 'cancelling']);
const ACTIVE_DURABLE_RUN_STATES = new Set([
  'created',
  'running',
  'waiting',
  'paused',
  'recovering',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sqliteTableExists(db: BetterSqlite3.Database, tableName: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName));
}

function forkPrefixProjection(row: SQLiteRow, sourceMessageId?: string): Record<string, unknown> {
  return {
    id: sourceMessageId ?? row.id,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
    tool_calls: row.tool_calls,
    tool_results: row.tool_results,
    attachments: row.attachments,
    content_parts: row.content_parts,
    metadata: row.metadata,
    is_meta: row.is_meta,
    compaction: row.compaction,
  };
}

function digestForkPrefix(rows: SQLiteRow[], sourceMessageIds?: string[]): string {
  return sha256(JSON.stringify(rows.map((row, index) => (
    forkPrefixProjection(row, sourceMessageIds?.[index])
  ))));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function sanitizeForkEngine(raw: unknown, cwd: string | null): string {
  const engine = parseJsonObject(raw);
  const kind = typeof engine.kind === 'string' ? engine.kind : 'native';
  const safe: Record<string, unknown> = {
    kind,
    permissionProfile: kind === 'native' ? 'default' : 'read_only',
    origin: 'manual',
  };
  if (typeof engine.model === 'string' && engine.model.trim()) safe.model = engine.model.trim();
  if (cwd) safe.cwd = cwd;
  return JSON.stringify(safe);
}

function isNonEmptyToolCallPayload(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value === 'null' || value === '[]') return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length > 0 : Boolean(parsed);
  } catch {
    return true;
  }
}

export class SessionForkRepository {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly conversationBranchRepo?: ConversationBranchRepository,
  ) {}

  createFork(input: CreateForkRepositoryInput): CreateForkRepositoryResult {
    const sourceSessionId = input.sourceSessionId.trim();
    const anchorMessageId = input.anchorAssistantMessageId.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!sourceSessionId) throw new SessionForkError('SESSION_NOT_FOUND', 'sourceSessionId is required');
    if (!anchorMessageId) throw new SessionForkError('INVALID_ANCHOR', 'anchorAssistantMessageId is required');
    if (!idempotencyKey) throw new SessionForkError('IDEMPOTENCY_CONFLICT', 'idempotencyKey is required');

    const requestDigest = sha256(JSON.stringify({
      sourceSessionId,
      anchorMessageId,
      workspaceMode: input.workspaceMode,
      contextDeliveryMode: input.contextDeliveryMode,
      childWorkingDirectory: input.childWorkingDirectory ?? null,
      workspaceSnapshotId: input.workspaceSnapshotId ?? null,
    }));

    const now = input.now ?? Date.now();

    const transaction = this.db.transaction(() => {
      const source = this.requireForkableSource(sourceSessionId, input.ownerUserId);
      const existing = this.db.prepare(`
        SELECT id, child_session_id, request_digest, source_prefix_digest
        FROM session_forks
        WHERE source_session_id = ? AND idempotency_key = ?
        LIMIT 1
      `).get(sourceSessionId, idempotencyKey) as {
        id: string;
        child_session_id: string;
        request_digest: string;
        source_prefix_digest: string;
      } | undefined;
      if (existing) {
        if (existing.request_digest !== requestDigest) {
          throw new SessionForkError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used for a different fork request',
          );
        }
        return this.readResult(existing.id, existing.child_session_id, existing.source_prefix_digest);
      }

      const anyAnchor = this.db.prepare(`
        SELECT rowid AS __rowid, *
        FROM messages
        WHERE session_id = ? AND id = ?
        LIMIT 1
      `).get(sourceSessionId, anchorMessageId) as SQLiteRow | undefined;
      if (!anyAnchor) {
        throw new SessionForkError(
          'INVALID_ANCHOR',
          `message ${anchorMessageId} was not found in the source session`,
        );
      }
      if (String(anyAnchor.visibility ?? 'active') !== 'active') {
        throw new SessionForkError('ANCHOR_REWOUND', `message ${anchorMessageId} is not active`);
      }
      if (
        anyAnchor.role !== 'assistant'
        || Boolean(anyAnchor.is_meta)
        || !String(anyAnchor.content ?? '').trim()
        || isNonEmptyToolCallPayload(anyAnchor.tool_calls)
      ) {
        throw new SessionForkError(
          'ANCHOR_NOT_COMPLETED_ASSISTANT',
          `message ${anchorMessageId} is not a completed assistant reply`,
        );
      }

      const anchorRowId = Number(anyAnchor.__rowid);
      const anchorTimestamp = Number(anyAnchor.timestamp);
      const prefixRows = this.db.prepare(`
        SELECT rowid AS __rowid, *
        FROM messages
        WHERE session_id = ?
          AND (
            timestamp < ?
            OR (timestamp = ? AND rowid <= ?)
          )
          AND COALESCE(visibility, 'active') = 'active'
        ORDER BY timestamp ASC, rowid ASC
      `).all(sourceSessionId, anchorTimestamp, anchorTimestamp, anchorRowId) as SQLiteRow[];
      if (prefixRows.length === 0 || String(prefixRows[prefixRows.length - 1].id) !== anchorMessageId) {
        throw new SessionForkError(
          'INVALID_ANCHOR',
          'the active prefix does not terminate at the requested anchor',
        );
      }
      const sourcePrefixDigest = digestForkPrefix(prefixRows);

      const parentFork = this.db.prepare(`
        SELECT id, root_session_id, depth
        FROM session_forks
        WHERE child_session_id = ? AND status = 'completed'
        LIMIT 1
      `).get(sourceSessionId) as { id: string; root_session_id: string; depth: number } | undefined;
      const rootSessionId = parentFork?.root_session_id ?? sourceSessionId;
      const depth = (parentFork?.depth ?? 0) + 1;
      const childWorkingDirectory = input.childWorkingDirectory ?? (
        typeof source.working_directory === 'string' ? source.working_directory : null
      );
      const lineageMetadata: SessionForkLineageSummary = {
        forkId: input.forkId,
        rootSessionId,
        parentSessionId: sourceSessionId,
        parentDeleted: false,
        childSessionId: input.childSessionId,
        sourceAnchorMessageId: anchorMessageId,
        anchorChildMessageId: '',
        depth,
        workspaceMode: input.workspaceMode,
        contextDeliveryMode: input.contextDeliveryMode,
        status: 'completed',
        syncState: 'local_only',
        createdAt: now,
      };

      this.db.prepare(`
        INSERT INTO sessions (
          id, user_id, title, model_provider, model_name, working_directory,
          session_type, origin, metadata, parent_session_id, source_run_id,
          agent_engine, memory_mode, suppressed_memory_entry_ids, read_only,
          retry_of_session_id, created_at, updated_at, workspace,
          workbench_provenance, status, last_token_usage, is_deleted, synced_at,
          git_branch, project_id
        )
        VALUES (?, ?, ?, ?, ?, ?, 'chat', ?, ?, ?, NULL, ?, ?, ?, 0, NULL, ?, ?,
                ?, ?, 'idle', NULL, 0, NULL, ?, ?)
      `).run(
        input.childSessionId,
        source.user_id ?? null,
        input.childTitle,
        source.model_provider,
        source.model_name,
        childWorkingDirectory,
        JSON.stringify({ kind: 'manual', metadata: { forkId: input.forkId } }),
        JSON.stringify({ forkLineage: lineageMetadata }),
        sourceSessionId,
        sanitizeForkEngine(source.agent_engine, childWorkingDirectory),
        source.memory_mode === 'off' ? 'off' : 'auto',
        typeof source.suppressed_memory_entry_ids === 'string' ? source.suppressed_memory_entry_ids : '[]',
        now,
        now,
        source.workspace ?? null,
        null,
        source.git_branch ?? null,
        source.project_id ?? null,
      );

      const mappings: SessionForkMessageMapping[] = [];
      for (let ordinal = 0; ordinal < prefixRows.length; ordinal++) {
        const sourceMessage = prefixRows[ordinal];
        const childMessageId = `msg_fork_${now}_${ordinal}_${randomUUID().slice(0, 8)}`;
        const sourceRowDigest = sha256(JSON.stringify(forkPrefixProjection(sourceMessage)));
        const sourceOrderKey = `${Number(sourceMessage.timestamp)}:${Number(sourceMessage.__rowid)}`;
        this.db.prepare(`
          INSERT INTO messages (
            id, session_id, role, content, timestamp, tool_calls, tool_results,
            attachments, thinking, effort_level, synced_at, content_parts, metadata,
            is_meta, compaction, visibility, hidden_by_rewind_id, hidden_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', NULL, NULL)
        `).run(
          childMessageId,
          input.childSessionId,
          sourceMessage.role,
          sourceMessage.content,
          sourceMessage.timestamp,
          sourceMessage.tool_calls ?? null,
          sourceMessage.tool_results ?? null,
          sourceMessage.attachments ?? null,
          sourceMessage.thinking ?? null,
          sourceMessage.effort_level ?? null,
          sourceMessage.content_parts ?? null,
          sourceMessage.metadata ?? null,
          sourceMessage.is_meta ?? 0,
          sourceMessage.compaction ?? null,
        );
        mappings.push({
          forkId: input.forkId,
          ordinal,
          sourceMessageId: String(sourceMessage.id),
          childMessageId,
          sourceTimestamp: Number(sourceMessage.timestamp),
          sourceOrderKey,
          sourceRowDigest,
        });
      }

      const anchorMapping = mappings[mappings.length - 1];
      lineageMetadata.anchorChildMessageId = anchorMapping.childMessageId;
      this.db.prepare(`
        UPDATE sessions SET metadata = ? WHERE id = ?
      `).run(JSON.stringify({ forkLineage: lineageMetadata }), input.childSessionId);

      this.db.prepare(`
        INSERT INTO session_forks (
          id, source_session_id, child_session_id, root_session_id, parent_fork_id,
          anchor_message_id, anchor_child_message_id, workspace_mode,
          context_delivery_mode, idempotency_key, request_digest,
          source_prefix_digest, status, depth, sync_state, workspace_snapshot_id,
          error_json, created_at, updated_at, committed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, 'local_only', ?, NULL, ?, ?, ?)
      `).run(
        input.forkId,
        sourceSessionId,
        input.childSessionId,
        rootSessionId,
        parentFork?.id ?? null,
        anchorMessageId,
        anchorMapping.childMessageId,
        input.workspaceMode,
        input.contextDeliveryMode,
        idempotencyKey,
        requestDigest,
        sourcePrefixDigest,
        depth,
        input.workspaceSnapshotId ?? null,
        now,
        now,
        now,
      );

      const insertMapping = this.db.prepare(`
        INSERT INTO session_fork_message_map (
          fork_id, ordinal, source_message_id, child_message_id,
          source_timestamp, source_order_key, source_row_digest
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const mapping of mappings) {
        insertMapping.run(
          mapping.forkId,
          mapping.ordinal,
          mapping.sourceMessageId,
          mapping.childMessageId,
          mapping.sourceTimestamp,
          mapping.sourceOrderKey,
          mapping.sourceRowDigest,
        );
      }

      this.conversationBranchRepo?.createForkBranch({
        sourceSessionId,
        childSessionId: input.childSessionId,
        sourceAnchorMessageId: anchorMessageId,
        childAnchorMessageId: anchorMapping.childMessageId,
        forkId: input.forkId,
        boundary: {
          ownerUserId: typeof source.user_id === 'string' ? source.user_id : null,
          projectId: typeof source.project_id === 'string' ? source.project_id : null,
        },
        messageAliases: mappings.map((mapping) => ({
          sourceMessageId: mapping.sourceMessageId,
          childMessageId: mapping.childMessageId,
        })),
        idempotencyKey: `session-fork:${idempotencyKey}`,
        createdAt: now,
      });
      return this.readResult(input.forkId, input.childSessionId, sourcePrefixDigest);
    });

    return transaction.immediate();
  }

  getLineage(sessionId: string, ownerUserId?: string | null): SessionForkLineageSummary | null {
    if (ownerUserId !== undefined) {
      const ownerPredicate = ownerUserId === null
        ? 'child.user_id IS NULL AND source.user_id IS NULL'
        : 'child.user_id = ? AND source.user_id = ?';
      const ownerParams = ownerUserId === null ? [] : [ownerUserId, ownerUserId];
      const row = this.db.prepare(`
        SELECT fork.*, source.is_deleted AS parent_is_deleted
        FROM session_forks AS fork
        JOIN sessions AS child ON child.id = fork.child_session_id
        JOIN sessions AS source ON source.id = fork.source_session_id
        WHERE fork.child_session_id = ?
          AND COALESCE(child.is_deleted, 0) = 0
          AND ${ownerPredicate}
        LIMIT 1
      `).get(sessionId, ...ownerParams) as SQLiteRow | undefined;
      return row ? this.rowToLineage(row) : null;
    }

    const row = this.db.prepare(`
      SELECT fork.*, source.is_deleted AS parent_is_deleted
      FROM session_forks AS fork
      JOIN sessions AS source ON source.id = fork.source_session_id
      WHERE fork.child_session_id = ?
      LIMIT 1
    `).get(sessionId) as SQLiteRow | undefined;
    return row ? this.rowToLineage(row) : null;
  }

  listChildren(sessionId: string, ownerUserId?: string | null): SessionForkLineageSummary[] {
    if (ownerUserId !== undefined) {
      const ownerPredicate = ownerUserId === null
        ? 'child.user_id IS NULL AND source.user_id IS NULL'
        : 'child.user_id = ? AND source.user_id = ?';
      const ownerParams = ownerUserId === null ? [] : [ownerUserId, ownerUserId];
      return (this.db.prepare(`
        SELECT fork.*, source.is_deleted AS parent_is_deleted
        FROM session_forks AS fork
        JOIN sessions AS child ON child.id = fork.child_session_id
        JOIN sessions AS source ON source.id = fork.source_session_id
        WHERE fork.source_session_id = ?
          AND fork.status = 'completed'
          AND COALESCE(child.is_deleted, 0) = 0
          AND COALESCE(source.is_deleted, 0) = 0
          AND ${ownerPredicate}
        ORDER BY fork.created_at ASC, fork.id ASC
      `).all(sessionId, ...ownerParams) as SQLiteRow[]).map((row) => this.rowToLineage(row));
    }

    return (this.db.prepare(`
      SELECT fork.*, source.is_deleted AS parent_is_deleted
      FROM session_forks AS fork
      JOIN sessions AS source ON source.id = fork.source_session_id
      WHERE fork.source_session_id = ? AND fork.status = 'completed'
      ORDER BY fork.created_at ASC, fork.id ASC
    `).all(sessionId) as SQLiteRow[]).map((row) => this.rowToLineage(row));
  }

  getContextSource(childSessionId: string): SessionForkContextSource | null {
    const fork = this.db.prepare(`
      SELECT *
      FROM session_forks
      WHERE child_session_id = ? AND status = 'completed'
      LIMIT 1
    `).get(childSessionId) as SQLiteRow | undefined;
    if (!fork) return null;

    const mappings = this.db.prepare(`
      SELECT *
      FROM session_fork_message_map
      WHERE fork_id = ?
      ORDER BY ordinal ASC
    `).all(String(fork.id)) as SQLiteRow[];
    const sourceRows = this.db.prepare(`
      SELECT source.rowid AS __rowid, source.id, source.timestamp
      FROM session_fork_message_map AS map
      JOIN messages AS source
        ON source.id = map.source_message_id
       AND source.session_id = ?
      WHERE map.fork_id = ?
      ORDER BY map.ordinal ASC
    `).all(String(fork.source_session_id), String(fork.id)) as SQLiteRow[];
    const childRows = this.db.prepare(`
      SELECT child.rowid AS __rowid, child.*
      FROM session_fork_message_map AS map
      JOIN messages AS child
        ON child.id = map.child_message_id
       AND child.session_id = ?
      WHERE map.fork_id = ?
      ORDER BY map.ordinal ASC
    `).all(childSessionId, String(fork.id)) as SQLiteRow[];
    const rejectIncompletePrefix = (): never => {
      throw new SessionForkError(
        'CONTEXT_HANDOFF_REJECTED',
        `fork ${String(fork.id)} does not have a complete active mapped prefix`,
      );
    };

    if (
      mappings.length === 0
      || sourceRows.length !== mappings.length
      || childRows.length !== mappings.length
      || new Set(mappings.map((row) => String(row.source_message_id))).size !== mappings.length
      || new Set(mappings.map((row) => String(row.child_message_id))).size !== mappings.length
    ) {
      rejectIncompletePrefix();
    }

    for (let index = 0; index < mappings.length; index++) {
      const mapping = mappings[index];
      const sourceRow = sourceRows[index];
      const childRow = childRows[index];
      if (
        Number(mapping.ordinal) !== index
        || String(mapping.source_message_id) !== String(sourceRow.id)
        || String(mapping.child_message_id) !== String(childRow.id)
        || Number(mapping.source_timestamp) !== Number(sourceRow.timestamp)
        || String(mapping.source_order_key) !== `${Number(sourceRow.timestamp)}:${Number(sourceRow.__rowid)}`
        || String(childRow.visibility ?? 'active') !== 'active'
        || Boolean(childRow.is_meta)
      ) {
        rejectIncompletePrefix();
      }
    }

    const lastMapping = mappings[mappings.length - 1];
    const firstMapping = mappings[0];
    if (
      Number(firstMapping.ordinal) !== 0
      || String(lastMapping.source_message_id) !== String(fork.anchor_message_id)
      || String(lastMapping.child_message_id) !== String(fork.anchor_child_message_id)
      || String(sourceRows[sourceRows.length - 1].id) !== String(fork.anchor_message_id)
      || String(childRows[childRows.length - 1].id) !== String(fork.anchor_child_message_id)
    ) {
      rejectIncompletePrefix();
    }

    const persistedDigest = String(fork.source_prefix_digest);
    const childDigest = digestForkPrefix(
      childRows,
      mappings.map((mapping) => String(mapping.source_message_id)),
    );
    if (persistedDigest !== childDigest) {
      rejectIncompletePrefix();
    }

    return {
      lineage: this.rowToLineage(fork),
      sourcePrefixDigest: persistedDigest,
      mappedActivePrefix: childRows.map((row, index) => ({
        ordinal: Number(mappings[index].ordinal),
        sourceMessageId: String(mappings[index].source_message_id),
        childMessageId: String(mappings[index].child_message_id),
        message: rowToMessage(row),
      })),
    };
  }

  prepareContextHandoff(
    forkId: string,
    engine: ExternalAgentEngineKind,
    payloadDigest: string,
    preparedAt = Date.now(),
  ): SessionForkContextHandoffRecord {
    if (engine !== 'codex_cli' && engine !== 'claude_code') {
      throw new SessionForkError('CONTEXT_HANDOFF_REJECTED', `${engine} has no verified context handoff`);
    }
    const existing = this.getContextHandoff(forkId);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest || existing.engine !== engine) {
        throw new SessionForkError(
          'CONTEXT_HANDOFF_REJECTED',
          'fork context handoff payload conflicts with the persisted attempt',
        );
      }
      if (existing.state !== 'pending') {
        throw new SessionForkError(
          'CONTEXT_HANDOFF_REJECTED',
          `fork context handoff is ${existing.state}; automatic replay is blocked`,
        );
      }
      return existing;
    }

    const fork = this.db.prepare(`
      SELECT context_delivery_mode FROM session_forks WHERE id = ? AND status = 'completed'
    `).get(forkId) as { context_delivery_mode: string } | undefined;
    if (fork?.context_delivery_mode !== 'validated_context_handoff') {
      throw new SessionForkError(
        'CONTEXT_HANDOFF_REJECTED',
        `fork ${forkId} is not eligible for validated context handoff`,
      );
    }
    this.db.prepare(`
      INSERT INTO session_fork_context_handoffs (
        fork_id, engine, payload_digest, state, attempt_id,
        prepared_at, dispatch_started_at, consumed_at, error_json
      ) VALUES (?, ?, ?, 'pending', NULL, ?, NULL, NULL, NULL)
    `).run(forkId, engine, payloadDigest, preparedAt);
    return this.requireContextHandoff(forkId);
  }

  markContextHandoffDispatching(
    forkId: string,
    payloadDigest: string,
    attemptId: string,
    startedAt = Date.now(),
  ): SessionForkContextHandoffRecord {
    const existing = this.requireContextHandoff(forkId);
    if (
      existing.state === 'dispatching'
      && existing.payloadDigest === payloadDigest
      && existing.attemptId === attemptId
    ) {
      return existing;
    }
    const result = this.db.prepare(`
      UPDATE session_fork_context_handoffs
      SET state = 'dispatching', attempt_id = ?, dispatch_started_at = ?, error_json = NULL
      WHERE fork_id = ? AND payload_digest = ? AND state = 'pending'
    `).run(attemptId, startedAt, forkId, payloadDigest);
    if (result.changes !== 1) {
      throw new SessionForkError(
        'CONTEXT_HANDOFF_REJECTED',
        `fork context handoff cannot start from ${existing.state}`,
      );
    }
    return this.requireContextHandoff(forkId);
  }

  markContextHandoffConsumed(
    forkId: string,
    payloadDigest: string,
    attemptId: string,
    consumedAt = Date.now(),
  ): SessionForkContextHandoffRecord {
    const existing = this.requireContextHandoff(forkId);
    if (
      existing.state === 'consumed'
      && existing.payloadDigest === payloadDigest
      && existing.attemptId === attemptId
    ) {
      return existing;
    }
    const result = this.db.prepare(`
      UPDATE session_fork_context_handoffs
      SET state = 'consumed', consumed_at = ?
      WHERE fork_id = ? AND payload_digest = ? AND attempt_id = ? AND state = 'dispatching'
    `).run(consumedAt, forkId, payloadDigest, attemptId);
    if (result.changes !== 1) {
      throw new SessionForkError(
        'CONTEXT_HANDOFF_REJECTED',
        `fork context handoff cannot complete from ${existing.state}`,
      );
    }
    return this.requireContextHandoff(forkId);
  }

  getContextHandoff(forkId: string): SessionForkContextHandoffRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM session_fork_context_handoffs WHERE fork_id = ? LIMIT 1
    `).get(forkId) as SQLiteRow | undefined;
    return row ? this.rowToContextHandoff(row) : null;
  }

  recoverInterruptedContextHandoffs(recoveredAt = Date.now()): number {
    const result = this.db.prepare(`
      UPDATE session_fork_context_handoffs
      SET state = 'blocked',
          error_json = ?
      WHERE state = 'dispatching'
    `).run(JSON.stringify({ code: 'INTERRUPTED_DISPATCH', recoveredAt }));
    return result.changes;
  }

  private readResult(
    forkId: string,
    childSessionId: string,
    sourcePrefixDigest: string,
  ): CreateForkRepositoryResult {
    const fork = this.db.prepare('SELECT * FROM session_forks WHERE id = ?').get(forkId) as SQLiteRow | undefined;
    if (!fork) throw new SessionForkError('FORK_OPERATION_FAILED', `fork ${forkId} was not persisted`);
    const mappings = (this.db.prepare(`
      SELECT *
      FROM session_fork_message_map
      WHERE fork_id = ?
      ORDER BY ordinal ASC
    `).all(forkId) as SQLiteRow[]).map((row) => this.rowToMapping(row));
    return {
      forkId,
      childSessionId,
      copiedMessageCount: mappings.length,
      sourcePrefixDigest,
      lineage: this.rowToLineage(fork),
      messageMappings: mappings,
    };
  }

  private requireForkableSource(
    sourceSessionId: string,
    ownerUserId?: string | null,
  ): SQLiteRow {
    const ownerPredicate = ownerUserId === undefined
      ? ''
      : ownerUserId === null
        ? ' AND user_id IS NULL'
        : ' AND user_id = ?';
    const ownerParams = typeof ownerUserId === 'string' ? [ownerUserId] : [];
    const source = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE id = ?
        AND COALESCE(is_deleted, 0) = 0
        ${ownerPredicate}
      LIMIT 1
    `).get(sourceSessionId, ...ownerParams) as SQLiteRow | undefined;
    if (!source) {
      throw new SessionForkError('SESSION_NOT_FOUND', `source session ${sourceSessionId} was not found`);
    }
    if (FORBIDDEN_SOURCE_STATES.has(String(source.status ?? 'idle'))) {
      throw new SessionForkError('SESSION_RUNNING', `source session is ${String(source.status)}`);
    }
    if (sqliteTableExists(this.db, 'durable_runs')) {
      const activeRun = (this.db.prepare(`
        SELECT run_id, status
        FROM durable_runs
        WHERE session_id = ?
      `).all(sourceSessionId) as Array<{ run_id: string; status: string }>)
        .find((run) => ACTIVE_DURABLE_RUN_STATES.has(String(run.status)));
      if (activeRun) {
        throw new SessionForkError(
          'SESSION_RUNNING',
          `source durable run ${activeRun.run_id} is ${activeRun.status}`,
        );
      }
    }
    return source;
  }

  private rowToLineage(row: SQLiteRow): SessionForkLineageSummary {
    return {
      forkId: String(row.id),
      rootSessionId: String(row.root_session_id),
      parentSessionId: String(row.source_session_id),
      parentDeleted: Number(row.parent_is_deleted ?? 0) !== 0,
      childSessionId: String(row.child_session_id),
      sourceAnchorMessageId: String(row.anchor_message_id),
      anchorChildMessageId: String(row.anchor_child_message_id),
      depth: Number(row.depth),
      workspaceMode: row.workspace_mode as SessionForkWorkspaceMode,
      contextDeliveryMode: row.context_delivery_mode as SessionForkContextDeliveryMode,
      status: row.status as SessionForkLineageSummary['status'],
      syncState: row.sync_state as SessionForkLineageSummary['syncState'],
      createdAt: Number(row.created_at),
    };
  }

  private rowToMapping(row: SQLiteRow): SessionForkMessageMapping {
    return {
      forkId: String(row.fork_id),
      ordinal: Number(row.ordinal),
      sourceMessageId: String(row.source_message_id),
      childMessageId: String(row.child_message_id),
      sourceTimestamp: Number(row.source_timestamp),
      sourceOrderKey: String(row.source_order_key),
      sourceRowDigest: String(row.source_row_digest),
    };
  }

  private requireContextHandoff(forkId: string): SessionForkContextHandoffRecord {
    const record = this.getContextHandoff(forkId);
    if (!record) {
      throw new SessionForkError('CONTEXT_HANDOFF_REJECTED', `fork context handoff ${forkId} was not prepared`);
    }
    return record;
  }

  private rowToContextHandoff(row: SQLiteRow): SessionForkContextHandoffRecord {
    return {
      forkId: String(row.fork_id),
      engine: row.engine as SessionForkContextHandoffRecord['engine'],
      payloadDigest: String(row.payload_digest),
      state: row.state as SessionForkContextHandoffState,
      attemptId: typeof row.attempt_id === 'string' ? row.attempt_id : null,
      preparedAt: Number(row.prepared_at),
      dispatchStartedAt: row.dispatch_started_at == null ? null : Number(row.dispatch_started_at),
      consumedAt: row.consumed_at == null ? null : Number(row.consumed_at),
      error: typeof row.error_json === 'string' && row.error_json.length > 0
        ? parseJsonObject(row.error_json)
        : null,
    };
  }
}
