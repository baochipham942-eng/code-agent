 
// ============================================================================
// SessionRepository - 会话 CRUD（sessions 表 + messages 表 + todos 表）
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { Session, Message, ModelProvider, TodoItem, SessionTask } from '../../../../shared/contract';
import { normalizeAgentEngineSession } from '../../../../shared/contract/agentEngine';
import type { ContextInterventionAction, ContextInterventionSnapshot } from '../../../../shared/contract/contextView';
import type { TranscriptKind } from '../../../../shared/transcriptFts.sql';
import type { StoredSession, StoredMessage } from '../../../protocol/types';
import {
  ConversationBranchError,
  type ConversationBoundary,
  type ConversationMessageSnapshot,
} from '../../../../shared/contract/conversationBranch';
import {
  activeMessageWhere,
  loopInternalMessageWhere,
  visibleHistoryMessageWhere,
  ensureToolCallShortDescription,
  buildAttachmentMetadata,
  normalizeStoredTimestamp,
  rowToMessage,
  rowToSession,
} from './sessionRepositoryParsers';
import { sanitizeConversationMessageSnapshot } from '../conversationMessageSnapshot';
import * as sidecarState from './sessionRepositorySidecarState';
import { getLatestUserAuthorId as readLatestUserAuthorId } from './sessionRepositoryParsers';
import { ConversationBranchRepository } from './ConversationBranchRepository';
import { SessionFtsRepository } from './SessionFtsRepository';
import type {
  SessionMessagesFtsCountOptions,
  SessionMessagesFtsHit,
  SessionMessagesFtsSearchOptions,
} from './sessionRepositoryFtsSearch';
import {
  patchSessionMetadataAtomically,
  type SessionMetadataPatchOptions,
} from './sessionMetadataPatch';
import {
  SessionRewindRepository,
  type PromptRewindRecordInput,
  type PromptRewindRestoreResult,
  type PromptRewindResult,
} from './SessionRewindRepository';

export type { StoredSession, StoredMessage };
export type {
  PromptRewindRecordInput,
  PromptRewindRestoreResult,
  PromptRewindResult,
} from './SessionRewindRepository';

function sqliteTableExists(db: BetterSqlite3.Database, tableName: string): boolean {
  const row = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { found?: number } | undefined;
  return row?.found === 1;
}

// SQLite 行类型
type SQLiteRow = Record<string, unknown>;

type SyncOrigin = 'local' | 'remote';
type MessageQueryOptions = { includeRewound?: boolean };
type SessionOwnerFilter = string | null | undefined;

interface SessionWriteOptions {
  syncOrigin?: SyncOrigin;
}

interface MessageWriteOptions {
  skipTimestampUpdate?: boolean;
  syncOrigin?: SyncOrigin;
  syncedAt?: number | null;
  updatedAt?: number;
  /** Internal compatibility projection write; immutable ledger was recorded by the caller. */
  skipConversationLedger?: boolean;
}

export class SessionRepository {
  private readonly conversationBranchRepo: ConversationBranchRepository | null;
  private readonly rewindRepo: SessionRewindRepository;
  private readonly ftsRepo: SessionFtsRepository;
  private readonly sessionsHaveProjectId: boolean;

  constructor(private db: BetterSqlite3.Database) {
    this.conversationBranchRepo = sqliteTableExists(db, 'conversation_branches')
      ? new ConversationBranchRepository(db)
      : null;
    this.rewindRepo = new SessionRewindRepository(db, this.conversationBranchRepo);
    this.ftsRepo = new SessionFtsRepository(db);
    this.sessionsHaveProjectId = (
      db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    ).some((column) => column.name === 'project_id');
  }

  private readConversationBoundary(sessionId: string): ConversationBoundary {
    const row = this.db.prepare(`
      SELECT user_id, ${this.sessionsHaveProjectId ? 'project_id' : 'NULL AS project_id'}
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(sessionId) as { user_id: string | null; project_id: string | null } | undefined;
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    return {
      ownerUserId: typeof row.user_id === 'string' ? row.user_id : null,
      projectId: typeof row.project_id === 'string' ? row.project_id : null,
    };
  }

  private toConversationMessage(message: Message): ConversationMessageSnapshot {
    return sanitizeConversationMessageSnapshot(message);
  }

  private assertRemoteSessionBoundaryCompatible(
    sessionId: string,
    incoming: ConversationBoundary,
  ): void {
    if (!sqliteTableExists(this.db, 'conversation_branches')) return;
    const branch = this.db.prepare(`
      SELECT id, owner_user_id, project_id
      FROM conversation_branches
      WHERE session_id = ?
      LIMIT 1
    `).get(sessionId) as {
      id: string;
      owner_user_id: string | null;
      project_id: string | null;
    } | undefined;
    if (!branch) return;
    if (branch.owner_user_id !== incoming.ownerUserId) {
      throw new ConversationBranchError(
        'OWNER_MISMATCH',
        `remote session ${sessionId} cannot change immutable branch ${branch.id} owner`,
      );
    }
    if (branch.project_id !== incoming.projectId) {
      throw new ConversationBranchError(
        'PROJECT_MISMATCH',
        `remote session ${sessionId} cannot change immutable branch ${branch.id} project`,
      );
    }
  }

  private protectedForkMessageIds(sessionId: string): Set<string> {
    if (
      !sqliteTableExists(this.db, 'session_forks')
      || !sqliteTableExists(this.db, 'session_fork_message_map')
    ) {
      return new Set();
    }
    const rows = this.db.prepare(`
      SELECT map.source_message_id AS message_id
      FROM session_forks AS fork
      JOIN session_fork_message_map AS map ON map.fork_id = fork.id
      WHERE fork.source_session_id = ?
        AND fork.status IN ('workspace_ready', 'completed')
      UNION
      SELECT map.child_message_id AS message_id
      FROM session_forks AS fork
      JOIN session_fork_message_map AS map ON map.fork_id = fork.id
      WHERE fork.child_session_id = ?
        AND fork.status IN ('workspace_ready', 'completed')
    `).all(sessionId, sessionId) as Array<{ message_id: string }>;
    return new Set(rows.map((row) => String(row.message_id)));
  }

  private forkProtectedProjection(message: Message): Record<string, unknown> {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      toolCalls: message.toolCalls ?? null,
      toolResults: message.toolResults ?? null,
      attachments: message.attachments ?? null,
      thinking: message.thinking ?? message.reasoning ?? null,
      effortLevel: message.effortLevel ?? null,
      contentParts: message.contentParts ?? null,
      metadata: message.metadata ?? null,
      isMeta: Boolean(message.isMeta),
      compaction: message.compaction ?? null,
    };
  }

  private resolveSyncedAt(options?: SessionWriteOptions | MessageWriteOptions): number | null {
    if (options && 'syncedAt' in options && options.syncedAt !== undefined) {
      return options.syncedAt;
    }
    return options?.syncOrigin === 'remote' ? Date.now() : null;
  }

  // --------------------------------------------------------------------------
  // Session CRUD
  // --------------------------------------------------------------------------

  private applyOwnerFilter(filters: string[], params: unknown[], userId: SessionOwnerFilter): void {
    if (userId === undefined) return;
    if (userId === null) {
      filters.push('s.user_id IS NULL');
      return;
    }
    filters.push('s.user_id = ?');
    params.push(userId);
  }

  createSession(session: Session): void {
    const stmt = this.db.prepare(`
        INSERT INTO sessions (
          id, user_id, title, model_provider, model_name, working_directory,
          session_type, origin, metadata, parent_session_id, source_run_id, agent_engine, memory_mode,
          suppressed_memory_entry_ids, read_only, retry_of_session_id,
          created_at, updated_at, workspace, workbench_provenance, status, last_token_usage,
          is_deleted, synced_at, git_branch, project_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
    `);

    this.db.transaction(() => {
      stmt.run(
        session.id,
        session.userId ?? null,
        session.title,
        session.modelConfig.provider,
        session.modelConfig.model,
        session.workingDirectory || null,
        session.type || 'chat',
        session.origin ? JSON.stringify(session.origin) : null,
        session.metadata ? JSON.stringify(session.metadata) : null,
        session.parentSessionId || null,
        session.sourceRunId || null,
        session.engine ? JSON.stringify(normalizeAgentEngineSession(session.engine)) : null,
        session.memoryMode || 'auto',
        JSON.stringify(session.suppressedMemoryEntryIds || []),
        session.readOnly ? 1 : 0,
        session.retryOfSessionId || null,
        session.createdAt,
        session.updatedAt,
        session.workspace || null,
        session.workbenchProvenance ? JSON.stringify(session.workbenchProvenance) : null,
        session.status || 'idle',
        session.lastTokenUsage ? JSON.stringify(session.lastTokenUsage) : null,
        session.gitBranch || null,
        session.projectId ?? null,
      );
    })();
  }

  createSessionWithId(
    id: string,
    data: {
      title: string;
      userId?: string | null;
      modelConfig: { provider: ModelProvider; model: string };
      workingDirectory?: string;
      projectId?: string | null;
      type?: Session['type'];
      origin?: Session['origin'];
      parentSessionId?: string;
      sourceRunId?: string;
      engine?: Session['engine'];
      metadata?: Session['metadata'];
      readOnly?: boolean;
      retryOfSessionId?: string;
      createdAt?: number | string;
      updatedAt?: number | string;
      isDeleted?: boolean;
    },
    options?: SessionWriteOptions,
  ): void {
    const now = Date.now();
    const createdAt = normalizeStoredTimestamp(data.createdAt, now);
    const updatedAt = normalizeStoredTimestamp(data.updatedAt, createdAt);
    // 云端同步（syncOrigin='remote'）走幂等 upsert：本地可能已存在同 id 但 user_id 为
    // NULL/不同（按 owner 过滤的 getSession 查不到 → 误判为不存在），纯 INSERT 会撞主键
    // UNIQUE 报错且每轮同步刷屏，这些会话也永远认领不到当前用户 → 列表里不显示。
    // 冲突时校准 user_id（认领归属）+ 云端元数据，保留 created_at 与本地专属字段。
    // 非同步的本地新建仍走严格 INSERT（id 总是新生成，撞 id 视为真 bug 应暴露）。
    const conflictClause =
      options?.syncOrigin === 'remote'
        ? `ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            title = excluded.title,
            model_provider = excluded.model_provider,
            model_name = excluded.model_name,
            working_directory = excluded.working_directory,
            project_id = excluded.project_id,
            updated_at = excluded.updated_at,
            is_deleted = excluded.is_deleted,
            synced_at = excluded.synced_at`
        : '';
    const stmt = this.db.prepare(`
        INSERT INTO sessions (
          id, user_id, title, model_provider, model_name, working_directory,
          session_type, origin, metadata, parent_session_id, source_run_id, agent_engine, read_only, retry_of_session_id,
          created_at, updated_at, is_deleted, synced_at, project_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ${conflictClause}
    `);

    this.db.transaction(() => {
      if (options?.syncOrigin === 'remote') {
        this.assertRemoteSessionBoundaryCompatible(id, {
          ownerUserId: data.userId ?? null,
          projectId: data.projectId ?? null,
        });
      }
      stmt.run(
        id,
        data.userId ?? null,
        data.title,
        data.modelConfig.provider,
        data.modelConfig.model,
        data.workingDirectory || null,
        data.type || 'chat',
        data.origin ? JSON.stringify(data.origin) : null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        data.parentSessionId || null,
        data.sourceRunId || null,
        data.engine ? JSON.stringify(normalizeAgentEngineSession(data.engine)) : null,
        data.readOnly ? 1 : 0,
        data.retryOfSessionId || null,
        createdAt,
        updatedAt,
        data.isDeleted ? 1 : 0,
        this.resolveSyncedAt(options),
        data.projectId ?? null,
      );
    })();
  }

  getSession(sessionId: string, options?: { includeDeleted?: boolean; userId?: string | null }): StoredSession | null {
    const filters = ['s.id = ?', '(? = 1 OR s.is_deleted = 0)'];
    const params: unknown[] = [sessionId, options?.includeDeleted ? 1 : 0];
    this.applyOwnerFilter(filters, params, options?.userId);

    const stmt = this.db.prepare(`
      SELECT s.*,
             COUNT(m.id) as message_count,
             COALESCE(SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END), 0) as turn_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id AND ${visibleHistoryMessageWhere('m')}
      WHERE ${filters.join(' AND ')}
      GROUP BY s.id
    `);

    const row = stmt.get(...params) as SQLiteRow | undefined;
    if (!row) return null;

    return rowToSession(row);
  }

  listSessions(
    limit: number = 50,
    offset: number = 0,
    includeArchived: boolean = false,
    userId?: string | null,
  ): StoredSession[] {
    const filters = ['s.is_deleted = 0'];
    const params: unknown[] = [];
    if (!includeArchived) {
      filters.push("s.status != 'archived'");
    }
    this.applyOwnerFilter(filters, params, userId);
    const whereClause = `WHERE ${filters.join(' AND ')}`;
    const stmt = this.db.prepare(`
      SELECT s.*,
             COUNT(m.id) as message_count,
             COALESCE(SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END), 0) as turn_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id AND ${visibleHistoryMessageWhere('m')}
      ${whereClause}
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(...params, limit, offset) as SQLiteRow[];
    return rows.map((row) => rowToSession(row));
  }

  updateSession(
    sessionId: string,
    updates: Partial<Session>,
    options?: SessionWriteOptions & { isDeleted?: boolean },
  ): void {
    // Use COALESCE to avoid read-before-write: only update fields that are provided
    const stmt = this.db.prepare(`
        UPDATE sessions
        SET title = COALESCE(?, title),
            user_id = COALESCE(?, user_id),
            model_provider = COALESCE(?, model_provider),
          model_name = COALESCE(?, model_name),
          working_directory = COALESCE(?, working_directory),
          agent_engine = COALESCE(?, agent_engine),
          memory_mode = COALESCE(?, memory_mode),
          suppressed_memory_entry_ids = COALESCE(?, suppressed_memory_entry_ids),
          updated_at = COALESCE(?, updated_at),
          workspace = COALESCE(?, workspace),
          workbench_provenance = COALESCE(?, workbench_provenance),
          metadata = COALESCE(?, metadata),
          status = COALESCE(?, status),
          last_token_usage = COALESCE(?, last_token_usage),
          is_deleted = COALESCE(?, is_deleted),
          synced_at = COALESCE(?, synced_at)
      WHERE id = ?
    `);

    const lastTokenUsage = updates.lastTokenUsage !== undefined ? JSON.stringify(updates.lastTokenUsage) : null; // null means keep existing via COALESCE
    const workbenchProvenance =
      updates.workbenchProvenance !== undefined ? JSON.stringify(updates.workbenchProvenance) : null;
    const metadata = updates.metadata !== undefined ? JSON.stringify(updates.metadata) : null;
    const agentEngine =
      updates.engine !== undefined ? JSON.stringify(normalizeAgentEngineSession(updates.engine)) : null;
    const suppressedMemoryEntryIds =
      updates.suppressedMemoryEntryIds !== undefined ? JSON.stringify(updates.suppressedMemoryEntryIds) : null;

    const result = stmt.run(
      updates.title ?? null,
      updates.userId !== undefined ? updates.userId : null,
      updates.modelConfig?.provider ?? null,
      updates.modelConfig?.model ?? null,
      updates.workingDirectory ?? null,
      agentEngine,
      updates.memoryMode ?? null,
      suppressedMemoryEntryIds,
      updates.updatedAt ?? Date.now(),
      updates.workspace !== undefined ? updates.workspace : null,
      workbenchProvenance,
      metadata,
      updates.status ?? null,
      lastTokenUsage,
      options?.isDeleted !== undefined ? (options.isDeleted ? 1 : 0) : null,
      this.resolveSyncedAt(options) ?? null,
      sessionId,
    );

    if (result.changes === 0) throw new Error(`Session not found: ${sessionId}`);
  }

  /**
   * Key 级 metadata 补丁（Codex audit R1-MED1）：整列替换的 updateSession 在
   * 读-改-写之间有 await 窗口，会互相覆盖 key。本方法在单次同步调用内完成
   * 读-合并-写（better-sqlite3 无 await），对其他 JS 调用方原子。
   * patch 值为 null 表示删除该 key；可选在同一原子调用内写 model 列。
   * 返回 false = 会话不存在。
   */
  patchSessionMetadata(
    sessionId: string,
    patch: Record<string, unknown>,
    options?: SessionMetadataPatchOptions,
  ): boolean {
    return patchSessionMetadataAtomically(this.db, sessionId, patch, options);
  }

  deleteSession(sessionId: string, options?: SessionWriteOptions & { deletedAt?: number }): void {
    const deletedAt = options?.deletedAt ?? Date.now();
    this.db
      .prepare(
        `
      UPDATE sessions
      SET is_deleted = 1, updated_at = ?, synced_at = ?
      WHERE id = ?
    `,
      )
      .run(deletedAt, this.resolveSyncedAt(options), sessionId);
    if (sqliteTableExists(this.db, 'generative_ui_instances')) {
      this.db.prepare(`
        UPDATE generative_ui_instances SET status = 'deleted', updated_at = ?
        WHERE session_id = ? AND status != 'deleted'
      `).run(deletedAt, sessionId);
      this.db.prepare(`
        UPDATE execution_manifests
        SET status = 'invalidated', updated_at = ?, resolved_at = ?, invalidation_reason = 'SESSION_DELETED'
        WHERE session_id = ? AND status IN ('pending', 'approved', 'executing')
      `).run(deletedAt, deletedAt, sessionId);
    }
  }

  /**
   * 写 session.plan_title — agent 调 TodoWrite 时显式传 plan_title 用。
   * 单独窄接口，只更新 plan_title + updated_at，不动 Session 类型 / updateSession
   * COALESCE 路径。NULL 时调用方传 null 显式清空。
   */
  updateSessionPlanTitle(sessionId: string, planTitle: string | null, updatedAt?: number): void {
    const result = this.db
      .prepare(`UPDATE sessions SET plan_title = ?, updated_at = ? WHERE id = ?`)
      .run(planTitle, updatedAt ?? Date.now(), sessionId);
    if (result.changes === 0) throw new Error(`Session not found: ${sessionId}`);
  }

  /**
   * 读 session.plan_title。NULL 代表 agent 还没主动制定 plan，UI 隐藏 plan 标题行
   * 只显示 checklist。
   */
  getSessionPlanTitle(sessionId: string): string | null {
    const row = this.db.prepare(`SELECT plan_title FROM sessions WHERE id = ?`).get(sessionId) as
      | { plan_title: string | null }
      | undefined;
    return row?.plan_title ?? null;
  }

  markCrashedActiveSessions(now: number = Date.now()): {
    interrupted: number;
    orphaned: number;
  } {
    const interrupted = this.db
      .prepare(
        `UPDATE sessions
           SET status = 'interrupted', updated_at = ?, synced_at = NULL
         WHERE status IN ('running', 'paused', 'cancelling') AND is_deleted = 0`,
      )
      .run(now).changes;

    const orphaned = this.db
      .prepare(
        `UPDATE sessions
           SET status = 'orphaned', updated_at = ?, synced_at = NULL
         WHERE status = 'queued' AND is_deleted = 0`,
      )
      .run(now).changes;

    return { interrupted, orphaned };
  }

  clearAllSessions(): number {
    const stmt = this.db.prepare('DELETE FROM sessions');
    const result = stmt.run();
    return result.changes;
  }

  clearAllMessages(): number {
    const stmt = this.db.prepare('DELETE FROM messages');
    const result = stmt.run();
    return result.changes;
  }

  hasMessages(sessionId: string): boolean {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
    const row = stmt.get(sessionId) as SQLiteRow | undefined;
    return ((row?.count as number) || 0) > 0;
  }

  getLocalCacheStats(): { sessionCount: number; messageCount: number } {
    const sessionRow = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as SQLiteRow;
    const messageRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as SQLiteRow;

    return {
      sessionCount: sessionRow.c as number,
      messageCount: messageRow.c as number,
    };
  }

  // --------------------------------------------------------------------------
  // Message CRUD
  // --------------------------------------------------------------------------

  addMessage(sessionId: string, message: Message, options?: MessageWriteOptions): void {
    // 'remote' = 云端回填/水合（例如懒加载读路径发现本地无消息时拉云端补齐）：
    // 这条消息本该已经存在于本地（可能是并发回填、也可能是本地已存在但因
    // rewound/hidden 而不计入 active 计数），此时本地状态优先，直接忽略这次
    // 写入即可——绝不能用 REPLACE 覆盖本地可能更新的状态（如撤回标记）。
    // 'local'（默认）保持严格 INSERT：同 id 冲突意味着真实的 ID 生成 bug，必须报错。
    const insertVerb = options?.syncOrigin === 'remote' ? 'INSERT OR IGNORE' : 'INSERT';
    const stmt = this.db.prepare(`
      ${insertVerb} INTO messages (
        id, session_id, role, content, timestamp, tool_calls, tool_results,
        attachments, thinking, effort_level, synced_at, content_parts, metadata, is_meta,
        compaction, visibility, hidden_by_rewind_id, hidden_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const attachmentsMeta = buildAttachmentMetadata(message.attachments);
    const thinkingContent = message.thinking || message.reasoning || null;

    const toolCallsForStorage = ensureToolCallShortDescription(message.toolCalls);
    const write = (): void => {
      const result = stmt.run(
        message.id,
        sessionId,
        message.role,
        message.content,
        message.timestamp,
        toolCallsForStorage ? JSON.stringify(toolCallsForStorage) : null,
        message.toolResults ? JSON.stringify(message.toolResults) : null,
        attachmentsMeta ? JSON.stringify(attachmentsMeta) : null,
        thinkingContent,
        message.effortLevel || null,
        this.resolveSyncedAt(options),
        message.contentParts ? JSON.stringify(message.contentParts) : null,
        message.metadata ? JSON.stringify(message.metadata) : null,
        message.isMeta ? 1 : 0,
        message.compaction ? JSON.stringify(message.compaction) : null,
        message.visibility ?? 'active',
        message.hiddenByRewindId ?? null,
        message.hiddenAt ?? null,
      );
      // OR IGNORE 命中冲突时 changes === 0：消息已存在，本地状态保持不变，无需再动账本/时间戳。
      if (result.changes === 0) return;

      if (this.conversationBranchRepo && !options?.skipConversationLedger) {
        const persistedRow = this.db.prepare(`
          SELECT *
          FROM messages
          WHERE session_id = ? AND id = ?
          LIMIT 1
        `).get(sessionId, message.id) as SQLiteRow | undefined;
        if (!persistedRow) {
          throw new Error(`Message disappeared before immutable append: ${message.id}`);
        }
        this.conversationBranchRepo.appendMessage({
          sessionId,
          boundary: this.readConversationBoundary(sessionId),
          message: this.toConversationMessage(rowToMessage(persistedRow)),
          idempotencyKey: `message-append:${message.id}`,
          provenance: {
            kind: 'compatibility_projection_append',
            syncOrigin: options?.syncOrigin ?? 'local',
          },
          createdAt: message.timestamp,
        });
      }

      if (!options?.skipTimestampUpdate && !message.isMeta) {
        this.db
          .prepare('UPDATE sessions SET updated_at = ?, synced_at = NULL WHERE id = ?')
          .run(options?.updatedAt ?? Date.now(), sessionId);
      }
    };
    if (this.conversationBranchRepo && !options?.skipConversationLedger) {
      this.db.transaction(write)();
    } else {
      write();
    }
  }

  replaceMessages(sessionId: string, messages: Message[], updatedAt: number = Date.now()): void {
    const replaceFn = this.db.transaction(() => {
      const protectedIds = this.protectedForkMessageIds(sessionId);
      if (protectedIds.size > 0) {
        const desiredById = new Map(messages.map((message) => [message.id, message]));
        for (const protectedId of protectedIds) {
          const desired = desiredById.get(protectedId);
          const currentRow = this.db.prepare(`
            SELECT *
            FROM messages
            WHERE session_id = ? AND id = ?
            LIMIT 1
          `).get(sessionId, protectedId) as SQLiteRow | undefined;
          if (
            !desired
            || !currentRow
            || JSON.stringify(this.forkProtectedProjection(desired))
              !== JSON.stringify(this.forkProtectedProjection(rowToMessage(currentRow)))
          ) {
            throw new Error(
              `FORK_PREFIX_PROTECTED: replaceMessages cannot remove or rewrite mapped message ${protectedId}`,
            );
          }
        }
      }

      if (protectedIds.size === 0) {
        this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      } else {
        const placeholders = [...protectedIds].map(() => '?').join(',');
        this.db.prepare(`
          DELETE FROM messages
          WHERE session_id = ? AND id NOT IN (${placeholders})
        `).run(sessionId, ...protectedIds);
      }
      for (const message of messages) {
        if (protectedIds.has(message.id)) continue;
        this.addMessage(sessionId, message, {
          skipTimestampUpdate: true,
          updatedAt,
          skipConversationLedger: true,
        });
      }
      this.db.prepare('UPDATE sessions SET updated_at = ?, synced_at = NULL WHERE id = ?').run(updatedAt, sessionId);
      if (this.conversationBranchRepo) {
        const persistedRows = this.db.prepare(`
          SELECT *
          FROM messages
          WHERE session_id = ?
          ORDER BY timestamp ASC, rowid ASC
        `).all(sessionId) as SQLiteRow[];
        const snapshots = persistedRows.map((row) => this.toConversationMessage(rowToMessage(row)));
        const digest = createHash('sha256').update(JSON.stringify(snapshots)).digest('hex');
        this.conversationBranchRepo.recordProjectionReplacement({
          sessionId,
          boundary: this.readConversationBoundary(sessionId),
          messages: snapshots,
          idempotencyKey: `projection-replace:${digest}`,
          reason: 'SessionRepository.replaceMessages compatibility projection',
          createdAt: updatedAt,
        });
      }
    });

    replaceFn();
  }

  updateMessage(messageId: string, updates: Partial<Message>, sessionId?: string): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      values.push(updates.content);
    }
    if (updates.role !== undefined) {
      setClauses.push('role = ?');
      values.push(updates.role);
    }
    if (updates.timestamp !== undefined) {
      setClauses.push('timestamp = ?');
      values.push(updates.timestamp);
    }
    if (updates.toolCalls !== undefined) {
      setClauses.push('tool_calls = ?');
      values.push(JSON.stringify(ensureToolCallShortDescription(updates.toolCalls)));
    }
    if (updates.toolResults !== undefined) {
      setClauses.push('tool_results = ?');
      values.push(JSON.stringify(updates.toolResults));
    }
    if (updates.attachments !== undefined) {
      setClauses.push('attachments = ?');
      const attachmentsMeta = buildAttachmentMetadata(updates.attachments);
      values.push(attachmentsMeta ? JSON.stringify(attachmentsMeta) : null);
    }
    if (updates.thinking !== undefined || updates.reasoning !== undefined) {
      setClauses.push('thinking = ?');
      values.push(updates.thinking || updates.reasoning || null);
    }
    if (updates.effortLevel !== undefined) {
      setClauses.push('effort_level = ?');
      values.push(updates.effortLevel || null);
    }
    if (updates.contentParts !== undefined) {
      setClauses.push('content_parts = ?');
      values.push(updates.contentParts ? JSON.stringify(updates.contentParts) : null);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }
    if (updates.isMeta !== undefined) {
      setClauses.push('is_meta = ?');
      values.push(updates.isMeta ? 1 : 0);
    }
    if (updates.compaction !== undefined) {
      setClauses.push('compaction = ?');
      values.push(updates.compaction ? JSON.stringify(updates.compaction) : null);
    }
    if (updates.visibility !== undefined) {
      setClauses.push('visibility = ?');
      values.push(updates.visibility ?? 'active');
    }
    if (updates.hiddenByRewindId !== undefined) {
      setClauses.push('hidden_by_rewind_id = ?');
      values.push(updates.hiddenByRewindId ?? null);
    }
    if (updates.hiddenAt !== undefined) {
      setClauses.push('hidden_at = ?');
      values.push(updates.hiddenAt ?? null);
    }

    if (setClauses.length === 0) return;

    // Mark as unsynced so pushToCloud picks up the update
    setClauses.push('synced_at = NULL');

    const sql = sessionId
      ? `UPDATE messages SET ${setClauses.join(', ')} WHERE id = ? AND session_id = ?`
      : `UPDATE messages SET ${setClauses.join(', ')} WHERE session_id = COALESCE(?, session_id) AND id = ?`;
    if (sessionId) {
      values.push(messageId, sessionId);
    } else {
      // 兼容普通 updateMessage 调用；碰撞恢复路径必须显式传入目标 sessionId。
      values.push(null, messageId);
    }
    const target = this.db.prepare(sessionId
      ? 'SELECT session_id FROM messages WHERE id = ? AND session_id = ? LIMIT 1'
      : 'SELECT session_id FROM messages WHERE id = ? LIMIT 1')
      .get(...(sessionId ? [messageId, sessionId] : [messageId])) as { session_id: string } | undefined;
    const resolvedSessionId = target?.session_id;
    const recordsRevision = Object.keys(updates).some((key) => ![
      'visibility',
      'hiddenByRewindId',
      'hiddenAt',
    ].includes(key));
    const write = (): void => {
      const result = this.db.prepare(sql).run(...values);
      if (result.changes === 0 || !resolvedSessionId) {
        throw new Error(`Message update missed for session ${sessionId ?? 'unknown'} and id ${messageId}`);
      }
      if (this.conversationBranchRepo && recordsRevision) {
        const revisedRow = this.db.prepare(`
          SELECT *
          FROM messages
          WHERE session_id = ? AND id = ?
          LIMIT 1
        `).get(resolvedSessionId, messageId) as SQLiteRow | undefined;
        if (!revisedRow) throw new Error(`Message disappeared after update: ${messageId}`);
        const revisedMessage = rowToMessage(revisedRow);
        const revisionDigest = createHash('sha256')
          .update(JSON.stringify(this.toConversationMessage(revisedMessage)))
          .digest('hex');
        this.conversationBranchRepo.recordMessageRevision({
          sessionId: resolvedSessionId,
          boundary: this.readConversationBoundary(resolvedSessionId),
          targetMessageId: messageId,
          revisedMessage: this.toConversationMessage(revisedMessage),
          idempotencyKey: `message-revision:${messageId}:${revisionDigest}`,
          reason: 'SessionRepository.updateMessage compatibility projection',
          createdAt: revisedMessage.timestamp,
        });
      }
    };
    if (this.conversationBranchRepo && recordsRevision) {
      this.db.transaction(write)();
    } else {
      write();
    }
  }

  getMessages(sessionId: string, limit?: number, offset?: number, options: MessageQueryOptions = {}): Message[] {
    const params: unknown[] = [sessionId];
    let sql = `
      SELECT * FROM messages
      WHERE session_id = ?
      ${options.includeRewound ? '' : `AND ${activeMessageWhere('messages')}`}
      ORDER BY timestamp ASC, rowid ASC
    `;

    if (limit !== undefined) {
      sql += ` LIMIT ${limit}`;
      if (offset !== undefined) {
        sql += ` OFFSET ${offset}`;
      }
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as SQLiteRow[];

    return rows.map((row) => rowToMessage(row));
  }

  getLatestUserAuthorId(sessionId: string): string | null {
    return readLatestUserAuthorId(this.db, sessionId);
  }

  getMessageCount(sessionId: string, options: MessageQueryOptions = {}): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM messages
      WHERE session_id = ?
      ${options.includeRewound ? '' : `AND ${visibleHistoryMessageWhere('messages')}`}
    `);
    const row = stmt.get(sessionId) as SQLiteRow | undefined;
    return (row?.count as number) || 0;
  }

  getRecentMessages(sessionId: string, count: number, options: MessageQueryOptions = {}): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ${options.includeRewound ? '' : `AND ${activeMessageWhere('messages')}`}
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?
    `);

    const rows = stmt.all(sessionId, count) as SQLiteRow[];

    return rows.reverse().map((row) => rowToMessage(row));
  }

  getMessagesBefore(
    sessionId: string,
    beforeTimestamp: number,
    limit: number = 30,
    options: MessageQueryOptions = {},
  ): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND timestamp < ?
      ${options.includeRewound ? '' : `AND ${activeMessageWhere('messages')}`}
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?
    `);

    const rows = stmt.all(sessionId, beforeTimestamp, limit) as SQLiteRow[];

    return rows.reverse().map((row) => rowToMessage(row));
  }

  // FTS 查询与回填由独立仓储实现，保留此处公开兼容 API。
  searchSessionMessagesFts(
    query: string,
    options: SessionMessagesFtsSearchOptions = {},
  ): SessionMessagesFtsHit[] {
    return this.ftsRepo.searchSessionMessagesFts(query, options);
  }

  countSessionMessagesFts(query: string, options: SessionMessagesFtsCountOptions = {}) {
    return this.ftsRepo.countSessionMessagesFts(query, options);
  }

  backfillSessionMessagesFts(): number {
    return this.ftsRepo.backfillSessionMessagesFts();
  }

  searchTranscriptFts(
    query: string,
    options: {
      limit?: number;
      sessionId?: string;
      kinds?: TranscriptKind[];
      toolName?: string;
      timeAfter?: number;
      timeBefore?: number;
      includeRewound?: boolean;
    } = {},
  ): Array<{
    messageId: string;
    sessionId: string;
    kind: TranscriptKind;
    toolName: string | null;
    snippet: string;
    timestamp: number;
  }> {
    return this.ftsRepo.searchTranscriptFts(query, options);
  }

  getTranscriptAround(
    messageId: string,
    options: { before?: number; after?: number } = {},
  ): {
    sessionId: string;
    messages: Array<{ message: Message; matched: boolean }>;
  } | null {
    return this.ftsRepo.getTranscriptAround(messageId, options);
  }

  backfillTranscriptFts(): number {
    return this.ftsRepo.backfillTranscriptFts();
  }

  getUnsyncedSessions(limit: number = 1000): StoredSession[] {
    const stmt = this.db.prepare(`
      SELECT s.*,
             COUNT(m.id) as message_count,
             COALESCE(SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END), 0) as turn_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id AND ${visibleHistoryMessageWhere('m')}
      WHERE s.synced_at IS NULL
      GROUP BY s.id
      ORDER BY s.updated_at ASC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as SQLiteRow[];
    return rows.map((row) => rowToSession(row));
  }

  markSessionsSynced(sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    const now = Date.now();
    const placeholders = sessionIds.map(() => '?').join(',');
    this.db.prepare(`UPDATE sessions SET synced_at = ? WHERE id IN (${placeholders})`).run(now, ...sessionIds);
  }

  getUnsyncedMessages(limit: number = 1000): Array<Message & { sessionId: string }> {
    const stmt = this.db.prepare(`
      SELECT m.*
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.synced_at IS NULL
        AND s.is_deleted = 0
        AND COALESCE(m.is_meta, 0) = 0
        AND ${loopInternalMessageWhere('m')}
      ORDER BY m.timestamp ASC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as SQLiteRow[];
    return rows.map((row) => ({
      ...rowToMessage(row),
      sessionId: row.session_id as string,
    }));
  }

  markMessagesSynced(messageIds: string[]): void {
    if (messageIds.length === 0) return;
    const now = Date.now();
    const placeholders = messageIds.map(() => '?').join(',');
    this.db.prepare(`UPDATE messages SET synced_at = ? WHERE id IN (${placeholders})`).run(now, ...messageIds);
  }

  getMessageById(sessionId: string, messageId: string, options: MessageQueryOptions = {}): Message | null {
    const stmt = this.db.prepare(`
      SELECT *
      FROM messages
      WHERE session_id = ? AND id = ?
      ${options.includeRewound ? '' : `AND ${activeMessageWhere('messages')}`}
      LIMIT 1
    `);
    const row = stmt.get(sessionId, messageId) as SQLiteRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  applyPromptRewind(
    sessionId: string,
    userMessageId: string,
    record: PromptRewindRecordInput = {},
  ): PromptRewindResult {
    return this.rewindRepo.applyPromptRewind(sessionId, userMessageId, record);
  }

  restorePromptRewind(
    sessionId: string,
    rewindId: string,
    restoredAt = Date.now(),
    ownerUserId?: string | null,
  ): PromptRewindRestoreResult {
    return this.rewindRepo.restorePromptRewind(
      sessionId,
      rewindId,
      restoredAt,
      ownerUserId,
    );
  }

  // --------------------------------------------------------------------------
  // Todos
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Todos / Session Tasks / Task Events / Context Interventions / Runtime State
  // 纯 SQL 逻辑抽到 ./sessionRepositorySidecarState.ts，此处为薄委托保持公共 API
  // --------------------------------------------------------------------------

  saveTodos(sessionId: string, todos: TodoItem[], updatedAt?: number): void {
    sidecarState.saveTodos(this.db, sessionId, todos, updatedAt);
  }

  getTodos(sessionId: string): TodoItem[] {
    return sidecarState.getTodos(this.db, sessionId);
  }

  saveSessionTasks(sessionId: string, tasks: SessionTask[], updatedAt?: number): void {
    sidecarState.saveSessionTasks(this.db, sessionId, tasks, updatedAt);
  }

  getSessionTasks(sessionId: string): SessionTask[] {
    return sidecarState.getSessionTasks(this.db, sessionId);
  }

  appendSessionTaskEvents(
    events: Array<{
      sessionId: string;
      taskId: string;
      at: number;
      kind: string;
      summary?: string;
      actor?: string;
    }>,
  ): void {
    sidecarState.appendSessionTaskEvents(this.db, events);
  }

  getSessionTaskEvents(
    sessionId: string,
    options: { taskId?: string; limit?: number } = {},
  ): Array<{ taskId: string; at: number; kind: string; summary?: string; actor?: string }> {
    return sidecarState.getSessionTaskEvents(this.db, sessionId, options);
  }

  getMaxTopLevelTaskIdFromEvents(sessionId: string): number {
    return sidecarState.getMaxTopLevelTaskIdFromEvents(this.db, sessionId);
  }

  saveContextIntervention(
    sessionId: string,
    agentId: string | null | undefined,
    messageId: string,
    action: ContextInterventionAction | null,
    updatedAt?: number,
  ): void {
    sidecarState.saveContextIntervention(this.db, sessionId, agentId, messageId, action, updatedAt);
  }

  getContextInterventions(sessionId: string, agentId?: string | null): ContextInterventionSnapshot {
    return sidecarState.getContextInterventions(this.db, sessionId, agentId);
  }

  saveSessionRuntimeState(
    sessionId: string,
    state: { compressionStateJson?: string | null; persistentSystemContext?: string[] },
    updatedAt?: number,
  ): void {
    sidecarState.saveSessionRuntimeState(this.db, sessionId, state, updatedAt);
  }

  getSessionRuntimeState(
    sessionId: string,
  ): { compressionStateJson: string | null; persistentSystemContext: string[] } | null {
    return sidecarState.getSessionRuntimeState(this.db, sessionId);
  }

  // --------------------------------------------------------------------------
  // Session Archive
  // --------------------------------------------------------------------------

  listArchivedSessions(limit: number = 50, offset: number = 0, userId?: string | null): StoredSession[] {
    const filters = ["s.status = 'archived'", 's.is_deleted = 0'];
    const params: unknown[] = [];
    this.applyOwnerFilter(filters, params, userId);
    const rows = this.db
      .prepare(
        `
      SELECT s.*,
             (SELECT COUNT(*) FROM messages WHERE session_id = s.id AND ${visibleHistoryMessageWhere('messages')}) as message_count,
             (SELECT COUNT(*) FROM messages WHERE session_id = s.id AND role = 'user' AND ${visibleHistoryMessageWhere('messages')}) as turn_count
      FROM sessions s
      WHERE ${filters.join(' AND ')}
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(...params, limit, offset) as SQLiteRow[];

    return rows.map((row) => rowToSession(row));
  }

  archiveSession(sessionId: string, updatedAt?: number): StoredSession | null {
    this.db
      .prepare(`UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?`)
      .run(updatedAt ?? Date.now(), sessionId);
    return this.getSession(sessionId);
  }

  unarchiveSession(sessionId: string, updatedAt?: number): StoredSession | null {
    this.db
      .prepare(`UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?`)
      .run(updatedAt ?? Date.now(), sessionId);
    return this.getSession(sessionId);
  }

  // --------------------------------------------------------------------------
  // Session Events
  // --------------------------------------------------------------------------

  // Note: session_events table methods are in TelemetryRepository

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------
}
