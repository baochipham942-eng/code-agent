/* eslint-disable max-lines -- 既有超限文件（transcript FTS 接入前已 ~1199 行），拆分见 docs/audits/god-file-split-roadmap.md */
// ============================================================================
// SessionRepository - 会话 CRUD（sessions 表 + messages 表 + todos 表）
// ============================================================================
 

import type BetterSqlite3 from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Session, SessionStatus, TokenUsage, Message, ModelProvider, TodoItem, SessionTask, ToolCall } from '../../../../shared/contract';
import { normalizeAgentEngineSession } from '../../../../shared/contract/agentEngine';
import type { ContextInterventionAction, ContextInterventionSnapshot } from '../../../../shared/contract/contextView';
import { collectAttachmentPersistenceMetrics, sanitizeAttachmentsForPersistence, stripInlineAttachmentBlocks } from '../../../../shared/utils/messageAttachments';
import { extractArtifacts } from '../../../agent/artifactExtractor';
import { createLogger } from '../../infra/logger';
import { generateFallbackShortDescription } from '../../../model/providers/shared';
import {
  runTranscriptFtsBackfill,
  TRANSCRIPT_FTS_BODY_COLUMN_INDEX,
  type TranscriptKind,
} from '../../../../shared/transcriptFts.sql';
import { MEMORY } from '../../../../shared/constants';
import type { StoredSession, StoredMessage } from '../../../protocol/types';

export type { StoredSession, StoredMessage };

const logger = createLogger('SessionRepository');

// SQLite 行类型
type SQLiteRow = Record<string, unknown>;

type SyncOrigin = 'local' | 'remote';
type MessageQueryOptions = { includeRewound?: boolean };
type SessionOwnerFilter = string | null | undefined;

export interface PromptRewindRecordInput {
  checkpointMessageId?: string | null;
  filesRestored?: number;
  filesDeleted?: number;
  errors?: string[];
  createdAt?: number;
}

export interface PromptRewindResult {
  rewindId: string;
  anchorMessage: Message;
  hiddenMessageIds: string[];
  hiddenMessageCount: number;
  activeMessages: Message[];
}

function activeMessageWhere(alias = 'm'): string {
  return `COALESCE(${alias}.visibility, 'active') = 'active'`;
}

function loopInternalMessageWhere(alias = 'm'): string {
  return `COALESCE(${alias}.content, '') NOT LIKE '%【循环模式 · 第%轮】%' AND COALESCE(${alias}.content, '') NOT LIKE '%[[LOOP_WAIT]]%'`;
}

function visibleHistoryMessageWhere(alias = 'm'): string {
  return `${activeMessageWhere(alias)} AND COALESCE(${alias}.is_meta, 0) = 0 AND ${loopInternalMessageWhere(alias)}`;
}

/**
 * 入库 choke point：保证持久化的所有 ToolCall 都有 shortDescription（产品视角
 * 语义短句）。任何上游路径——messageProcessor / TaskManager.turnState 重构造 /
 * web mode persist / subagent 透传——丢字段时这里统一兜底，避免 UI 看到 stale
 * 旧消息时 fallback 到机械拼接。
 */
function ensureToolCallShortDescription(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!toolCalls) return toolCalls;
  return toolCalls.map((tc) => ({
    ...tc,
    shortDescription: tc.shortDescription ?? generateFallbackShortDescription(tc.name, tc.arguments ?? {})
  }));
}

function buildAttachmentMetadata(attachments: Message['attachments']): Message['attachments'] | undefined {
  const sanitized = sanitizeAttachmentsForPersistence(attachments);
  const metrics = collectAttachmentPersistenceMetrics(attachments, sanitized);
  if (metrics.strippedDataUrlCount > 0 || metrics.persistedDataUrlChars > 0) {
    logger.debug('Attachment persistence media profile', metrics);
  }
  return sanitized;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

function parseStoredJson<T>(value: unknown): T | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown as T;
  } catch {
    return undefined;
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface SessionWriteOptions {
  syncOrigin?: SyncOrigin;
}

interface MessageWriteOptions {
  skipTimestampUpdate?: boolean;
  syncOrigin?: SyncOrigin;
  syncedAt?: number | null;
  updatedAt?: number;
}

export class SessionRepository {
  constructor(private db: BetterSqlite3.Database) {}

  private normalizeTimestamp(value: number | string | undefined, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return fallback;
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
          session_type, origin, parent_session_id, source_run_id, agent_engine, read_only, retry_of_session_id,
          created_at, updated_at, workspace, workbench_provenance, status, last_token_usage,
          is_deleted, synced_at, git_branch
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
    `);

    stmt.run(session.id, session.userId ?? null, session.title, session.modelConfig.provider, session.modelConfig.model, session.workingDirectory || null, session.type || 'chat', session.origin ? JSON.stringify(session.origin) : null, session.parentSessionId || null, session.sourceRunId || null, session.engine ? JSON.stringify(normalizeAgentEngineSession(session.engine)) : null, session.readOnly ? 1 : 0, session.retryOfSessionId || null, session.createdAt, session.updatedAt, session.workspace || null, session.workbenchProvenance ? JSON.stringify(session.workbenchProvenance) : null, session.status || 'idle', session.lastTokenUsage ? JSON.stringify(session.lastTokenUsage) : null, session.gitBranch || null);
  }

  createSessionWithId(
    id: string,
    data: {
      title: string;
      userId?: string | null;
      modelConfig: { provider: ModelProvider; model: string };
      workingDirectory?: string;
      type?: Session['type'];
      origin?: Session['origin'];
      parentSessionId?: string;
      sourceRunId?: string;
      engine?: Session['engine'];
      readOnly?: boolean;
      retryOfSessionId?: string;
      createdAt?: number | string;
      updatedAt?: number | string;
      isDeleted?: boolean;
    },
    options?: SessionWriteOptions
  ): void {
    const now = Date.now();
    const createdAt = this.normalizeTimestamp(data.createdAt, now);
    const updatedAt = this.normalizeTimestamp(data.updatedAt, createdAt);
    // 云端同步（syncOrigin='remote'）走幂等 upsert：本地可能已存在同 id 但 user_id 为
    // NULL/不同（按 owner 过滤的 getSession 查不到 → 误判为不存在），纯 INSERT 会撞主键
    // UNIQUE 报错且每轮同步刷屏，这些会话也永远认领不到当前用户 → 列表里不显示。
    // 冲突时校准 user_id（认领归属）+ 云端元数据，保留 created_at 与本地专属字段。
    // 非同步的本地新建仍走严格 INSERT（id 总是新生成，撞 id 视为真 bug 应暴露）。
    const conflictClause = options?.syncOrigin === 'remote'
      ? `ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            title = excluded.title,
            model_provider = excluded.model_provider,
            model_name = excluded.model_name,
            working_directory = excluded.working_directory,
            updated_at = excluded.updated_at,
            is_deleted = excluded.is_deleted,
            synced_at = excluded.synced_at`
      : '';
    const stmt = this.db.prepare(`
        INSERT INTO sessions (
          id, user_id, title, model_provider, model_name, working_directory,
          session_type, origin, parent_session_id, source_run_id, agent_engine, read_only, retry_of_session_id,
          created_at, updated_at, is_deleted, synced_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ${conflictClause}
    `);

    stmt.run(id, data.userId ?? null, data.title, data.modelConfig.provider, data.modelConfig.model, data.workingDirectory || null, data.type || 'chat', data.origin ? JSON.stringify(data.origin) : null, data.parentSessionId || null, data.sourceRunId || null, data.engine ? JSON.stringify(normalizeAgentEngineSession(data.engine)) : null, data.readOnly ? 1 : 0, data.retryOfSessionId || null, createdAt, updatedAt, data.isDeleted ? 1 : 0, this.resolveSyncedAt(options));
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

    return this.rowToSession(row);
  }

  listSessions(limit: number = 50, offset: number = 0, includeArchived: boolean = false, userId?: string | null): StoredSession[] {
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
    return rows.map((row) => this.rowToSession(row));
  }

  updateSession(sessionId: string, updates: Partial<Session>, options?: SessionWriteOptions & { isDeleted?: boolean }): void {
    // Use COALESCE to avoid read-before-write: only update fields that are provided
    const stmt = this.db.prepare(`
        UPDATE sessions
        SET title = COALESCE(?, title),
            user_id = COALESCE(?, user_id),
            model_provider = COALESCE(?, model_provider),
          model_name = COALESCE(?, model_name),
          working_directory = COALESCE(?, working_directory),
          agent_engine = COALESCE(?, agent_engine),
          updated_at = COALESCE(?, updated_at),
          workspace = COALESCE(?, workspace),
          workbench_provenance = COALESCE(?, workbench_provenance),
          status = COALESCE(?, status),
          last_token_usage = COALESCE(?, last_token_usage),
          is_deleted = COALESCE(?, is_deleted),
          synced_at = COALESCE(?, synced_at)
      WHERE id = ?
    `);

    const lastTokenUsage = updates.lastTokenUsage !== undefined ? JSON.stringify(updates.lastTokenUsage) : null; // null means keep existing via COALESCE
    const workbenchProvenance = updates.workbenchProvenance !== undefined ? JSON.stringify(updates.workbenchProvenance) : null;
    const agentEngine = updates.engine !== undefined ? JSON.stringify(normalizeAgentEngineSession(updates.engine)) : null;

    const result = stmt.run(updates.title ?? null, updates.userId !== undefined ? updates.userId : null, updates.modelConfig?.provider ?? null, updates.modelConfig?.model ?? null, updates.workingDirectory ?? null, agentEngine, updates.updatedAt ?? Date.now(), updates.workspace !== undefined ? updates.workspace : null, workbenchProvenance, updates.status ?? null, lastTokenUsage, options?.isDeleted !== undefined ? (options.isDeleted ? 1 : 0) : null, this.resolveSyncedAt(options) ?? null, sessionId);

    if (result.changes === 0) throw new Error(`Session not found: ${sessionId}`);
  }

  deleteSession(sessionId: string, options?: SessionWriteOptions & { deletedAt?: number }): void {
    const deletedAt = options?.deletedAt ?? Date.now();
    this.db
      .prepare(
        `
      UPDATE sessions
      SET is_deleted = 1, updated_at = ?, synced_at = ?
      WHERE id = ?
    `
      )
      .run(deletedAt, this.resolveSyncedAt(options), sessionId);
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
    const row = this.db
      .prepare(`SELECT plan_title FROM sessions WHERE id = ?`)
      .get(sessionId) as { plan_title: string | null } | undefined;
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
         WHERE status IN ('running', 'paused', 'cancelling') AND is_deleted = 0`
      )
      .run(now).changes;

    const orphaned = this.db
      .prepare(
        `UPDATE sessions
           SET status = 'orphaned', updated_at = ?, synced_at = NULL
         WHERE status = 'queued' AND is_deleted = 0`
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
      messageCount: messageRow.c as number
    };
  }

  // --------------------------------------------------------------------------
  // Message CRUD
  // --------------------------------------------------------------------------

  addMessage(sessionId: string, message: Message, options?: MessageWriteOptions): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        id, session_id, role, content, timestamp, tool_calls, tool_results,
        attachments, thinking, effort_level, synced_at, content_parts, metadata, is_meta,
        compaction, visibility, hidden_by_rewind_id, hidden_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const attachmentsMeta = buildAttachmentMetadata(message.attachments);
    const thinkingContent = message.thinking || message.reasoning || null;

    const toolCallsForStorage = ensureToolCallShortDescription(message.toolCalls);
    stmt.run(message.id, sessionId, message.role, message.content, message.timestamp, toolCallsForStorage ? JSON.stringify(toolCallsForStorage) : null, message.toolResults ? JSON.stringify(message.toolResults) : null, attachmentsMeta ? JSON.stringify(attachmentsMeta) : null, thinkingContent, message.effortLevel || null, this.resolveSyncedAt(options), message.contentParts ? JSON.stringify(message.contentParts) : null, message.metadata ? JSON.stringify(message.metadata) : null, message.isMeta ? 1 : 0, message.compaction ? JSON.stringify(message.compaction) : null, message.visibility ?? 'active', message.hiddenByRewindId ?? null, message.hiddenAt ?? null);

    if (!options?.skipTimestampUpdate && !message.isMeta) {
      this.db.prepare('UPDATE sessions SET updated_at = ?, synced_at = NULL WHERE id = ?').run(options?.updatedAt ?? Date.now(), sessionId);
    }
  }

  replaceMessages(sessionId: string, messages: Message[], updatedAt: number = Date.now()): void {
    const replaceFn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      for (const message of messages) {
        this.addMessage(sessionId, message, {
          skipTimestampUpdate: true,
          updatedAt
        });
      }
      this.db.prepare('UPDATE sessions SET updated_at = ?, synced_at = NULL WHERE id = ?').run(updatedAt, sessionId);
    });

    replaceFn();
  }

  updateMessage(messageId: string, updates: Partial<Message>): void {
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

    values.push(messageId);
    const sql = `UPDATE messages SET ${setClauses.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
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

    return rows.map((row) => this.rowToMessage(row));
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

    return rows.reverse().map((row) => this.rowToMessage(row));
  }

  getMessagesBefore(sessionId: string, beforeTimestamp: number, limit: number = 30, options: MessageQueryOptions = {}): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND timestamp < ?
      ${options.includeRewound ? '' : `AND ${activeMessageWhere('messages')}`}
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?
    `);

    const rows = stmt.all(sessionId, beforeTimestamp, limit) as SQLiteRow[];

    return rows.reverse().map((row) => this.rowToMessage(row));
  }

  // --------------------------------------------------------------------------
  // Episodic FTS search (Workstream D)
  // --------------------------------------------------------------------------

  /**
   * 用 FTS5 全文检索历史会话消息。
   *
   * - 触发器自动同步 messages → session_messages_fts，应用层无感
   * - 按相关性排序（BM25 rank），最近优先作为 tie-breaker
   * - sessionId 过滤可选，限定在当前 session 内搜索
   * - trigram tokenizer 要求查询至少 3 个字符
   * - 默认把查询包成 phrase literal（双引号），避开 `-` / `:` 等 FTS5 运算符；
   *   用户若显式以 `"` 开头则原样透传，保留高级 FTS5 语法
   */
  searchSessionMessagesFts(
    query: string,
    options: {
      limit?: number;
      sessionId?: string;
      includeRewound?: boolean;
    } = {}
  ): Array<{
    messageId: string;
    sessionId: string;
    role: string;
    content: string;
    timestamp: number;
  }> {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      return [];
    }

    const ftsQuery = normalizeFtsQuery(trimmed);
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const params: unknown[] = [ftsQuery];
    let whereSession = '';
    if (options.sessionId) {
      whereSession = options.includeRewound ? 'AND f.session_id = ?' : 'AND m.session_id = ?';
      params.push(options.sessionId);
    }
    params.push(limit);

    try {
      const sql = options.includeRewound
        ? `
          SELECT f.message_id, f.session_id, f.role, f.content, f.timestamp
          FROM session_messages_fts f
          WHERE f.content MATCH ? ${whereSession}
            AND ${loopInternalMessageWhere('f')}
          ORDER BY rank, f.timestamp DESC
          LIMIT ?
          `
        : `
          SELECT f.message_id, f.session_id, f.role, f.content, f.timestamp
          FROM session_messages_fts f
          JOIN messages m ON m.id = f.message_id
          WHERE f.content MATCH ? ${whereSession}
            AND ${visibleHistoryMessageWhere('m')}
          ORDER BY rank, f.timestamp DESC
          LIMIT ?
          `;
      const rows = this.db.prepare(sql).all(...params) as SQLiteRow[];

      return rows.map((row) => ({
        messageId: String(row.message_id ?? ''),
        sessionId: String(row.session_id ?? ''),
        role: String(row.role ?? ''),
        content: String(row.content ?? ''),
        timestamp: Number(row.timestamp ?? 0)
      }));
    } catch (err) {
      logger.warn('[EpisodicFts] search failed', {
        query: trimmed,
        error: err
      });
      return [];
    }
  }

  /**
   * Backfill session_messages_fts from an existing messages table.
   * 只在 FTS 表为空、且 messages 表非空时执行（典型场景：升级后首次启动）。
   * 返回 backfill 的行数；幂等且可重复调用。
   */
  backfillSessionMessagesFts(): number {
    try {
      const ftsRow = this.db.prepare('SELECT COUNT(*) as c FROM session_messages_fts').get() as { c: number } | undefined;
      const msgRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number } | undefined;
      const ftsCount = Number(ftsRow?.c ?? 0);
      const msgCount = Number(msgRow?.c ?? 0);

      if (ftsCount > 0 || msgCount === 0) {
        return 0;
      }

      logger.info(`[EpisodicFts] Backfilling FTS from ${msgCount} messages...`);
      const result = this.db
        .prepare(
          `
          INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
          SELECT id, session_id, role, COALESCE(content, ''), timestamp
          FROM messages
          WHERE COALESCE(is_meta, 0) = 0
            AND ${loopInternalMessageWhere('messages')}
          `
        )
        .run();
      const inserted = Number(result.changes ?? 0);
      logger.info(`[EpisodicFts] Backfill complete: ${inserted} rows`);
      return inserted;
    } catch (err) {
      logger.warn('[EpisodicFts] Backfill failed (non-blocking)', {
        error: err
      });
      return 0;
    }
  }

  // --------------------------------------------------------------------------
  // Transcript FTS（kind 分解索引，roadmap 2.1）— History 工具底层
  // --------------------------------------------------------------------------

  /**
   * 按 kind 分解的转录全文检索（transcript_fts，BM25 排序）。
   * 与 searchSessionMessagesFts 的差异：覆盖 tool_input/tool_output/reasoning，
   * 支持 kind / toolName / 时间窗过滤。FTS 语法错误向上抛（调用方提示模型修正）。
   */
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
    } = {}
  ): Array<{
    messageId: string;
    sessionId: string;
    kind: TranscriptKind;
    toolName: string | null;
    snippet: string;
    timestamp: number;
  }> {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      return [];
    }

    const ftsQuery = normalizeFtsQuery(trimmed);
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const conditions: string[] = [];
    const params: unknown[] = [ftsQuery];

    if (options.sessionId) {
      conditions.push('f.session_id = ?');
      params.push(options.sessionId);
    }
    if (options.kinds && options.kinds.length > 0) {
      conditions.push(`f.kind IN (${options.kinds.map(() => '?').join(', ')})`);
      params.push(...options.kinds);
    }
    if (options.toolName) {
      conditions.push('f.tool_name = ?');
      params.push(options.toolName);
    }
    if (options.timeAfter !== undefined) {
      conditions.push('f.timestamp >= ?');
      params.push(options.timeAfter);
    }
    if (options.timeBefore !== undefined) {
      conditions.push('f.timestamp <= ?');
      params.push(options.timeBefore);
    }
    params.push(limit);

    const extra = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
    const snippetExpr = `snippet(transcript_fts, ${TRANSCRIPT_FTS_BODY_COLUMN_INDEX}, '«', '»', ' … ', 24)`;
    // meta/loop 已在 trigger 期排除；查询期只需补 rewound 可见性过滤
    const sql = options.includeRewound
      ? `
        SELECT f.message_id, f.session_id, f.kind, f.tool_name, f.timestamp, ${snippetExpr} AS snip
        FROM transcript_fts f
        WHERE f.body MATCH ? ${extra}
        ORDER BY rank, f.timestamp DESC
        LIMIT ?
        `
      : `
        SELECT f.message_id, f.session_id, f.kind, f.tool_name, f.timestamp, ${snippetExpr} AS snip
        FROM transcript_fts f
        JOIN messages m ON m.id = f.message_id
        WHERE f.body MATCH ? ${extra}
          AND ${activeMessageWhere('m')}
        ORDER BY rank, f.timestamp DESC
        LIMIT ?
        `;

    const rows = this.db.prepare(sql).all(...params) as SQLiteRow[];
    return rows.map((row) => ({
      messageId: String(row.message_id ?? ''),
      sessionId: String(row.session_id ?? ''),
      kind: String(row.kind ?? '') as TranscriptKind,
      toolName: row.tool_name ? String(row.tool_name) : null,
      snippet: String(row.snip ?? ''),
      timestamp: Number(row.timestamp ?? 0)
    }));
  }

  /**
   * 取锚点消息 ±N 条上下文（同 session，按 timestamp + rowid 稳定排序）。
   * 邻居过滤 meta/loop/rewound；锚点本身即使被隐藏也返回（matched=true）。
   * 锚点不存在返回 null。
   */
  getTranscriptAround(
    messageId: string,
    options: { before?: number; after?: number } = {}
  ): { sessionId: string; messages: Array<{ message: Message; matched: boolean }> } | null {
    const clampWindow = (value: number | undefined, fallback: number): number => {
      if (value === undefined || !Number.isFinite(value)) return fallback;
      return Math.max(0, Math.min(Math.floor(value), MEMORY.HISTORY_AROUND_MAX_WINDOW));
    };
    const before = clampWindow(options.before, MEMORY.HISTORY_AROUND_DEFAULT_WINDOW);
    const after = clampWindow(options.after, MEMORY.HISTORY_AROUND_DEFAULT_WINDOW);

    const anchor = this.db
      .prepare('SELECT rowid AS rid, session_id, timestamp FROM messages WHERE id = ?')
      .get(messageId) as { rid: number; session_id: string; timestamp: number } | undefined;
    if (!anchor) {
      return null;
    }

    const visible = `${visibleHistoryMessageWhere('m')}`;
    const beforeRows = this.db
      .prepare(
        `
        SELECT m.* FROM messages m
        WHERE m.session_id = ?
          AND (m.timestamp < ? OR (m.timestamp = ? AND m.rowid <= ?))
          AND (${visible} OR m.id = ?)
        ORDER BY m.timestamp DESC, m.rowid DESC
        LIMIT ?
        `
      )
      .all(anchor.session_id, anchor.timestamp, anchor.timestamp, anchor.rid, messageId, before + 1) as SQLiteRow[];

    const afterRows = this.db
      .prepare(
        `
        SELECT m.* FROM messages m
        WHERE m.session_id = ?
          AND (m.timestamp > ? OR (m.timestamp = ? AND m.rowid > ?))
          AND ${visible}
        ORDER BY m.timestamp ASC, m.rowid ASC
        LIMIT ?
        `
      )
      .all(anchor.session_id, anchor.timestamp, anchor.timestamp, anchor.rid, after) as SQLiteRow[];

    const ordered = [...beforeRows.reverse(), ...afterRows];
    return {
      sessionId: anchor.session_id,
      messages: ordered.map((row) => ({
        message: this.rowToMessage(row),
        matched: String(row.id) === messageId
      }))
    };
  }

  /**
   * Backfill transcript_fts from existing messages（升级后首次启动）。
   * 只在 transcript_fts 为空且 messages 非空时执行；幂等。
   */
  backfillTranscriptFts(): number {
    try {
      const ftsRow = this.db.prepare('SELECT COUNT(*) as c FROM transcript_fts').get() as { c: number } | undefined;
      const msgRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number } | undefined;
      if (Number(ftsRow?.c ?? 0) > 0 || Number(msgRow?.c ?? 0) === 0) {
        return 0;
      }

      logger.info(`[TranscriptFts] Backfilling from ${Number(msgRow?.c ?? 0)} messages...`);
      const inserted = runTranscriptFtsBackfill(this.db);
      logger.info(`[TranscriptFts] Backfill complete: ${inserted} rows`);
      return inserted;
    } catch (err) {
      logger.warn('[TranscriptFts] Backfill failed (non-blocking)', { error: err });
      return 0;
    }
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
    return rows.map((row) => this.rowToSession(row));
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
      ...this.rowToMessage(row),
      sessionId: row.session_id as string
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
    return row ? this.rowToMessage(row) : null;
  }

  applyPromptRewind(sessionId: string, userMessageId: string, record: PromptRewindRecordInput = {}): PromptRewindResult {
    const now = record.createdAt ?? Date.now();
    const rewindId = `rewind_${now}_${uuidv4().slice(0, 8)}`;

    const applyFn = this.db.transaction(() => {
      const anchorRow = this.db
        .prepare(
          `
        SELECT rowid as __rowid, *
        FROM messages
        WHERE session_id = ?
          AND id = ?
          AND role = 'user'
          AND ${activeMessageWhere('messages')}
        LIMIT 1
      `
        )
        .get(sessionId, userMessageId) as SQLiteRow | undefined;

      if (!anchorRow) {
        throw new Error(`Active user message not found: ${userMessageId}`);
      }

      const anchorMessage = this.rowToMessage(anchorRow);
      const anchorRowId = Number(anchorRow.__rowid || 0);
      const rowsToHide = this.db
        .prepare(
          `
        SELECT id
        FROM messages
        WHERE session_id = ?
          AND rowid >= ?
          AND ${activeMessageWhere('messages')}
        ORDER BY timestamp ASC, rowid ASC
      `
        )
        .all(sessionId, anchorRowId) as Array<{ id: string }>;

      const hiddenMessageIds = rowsToHide.map((row) => String(row.id));
      if (hiddenMessageIds.length > 0) {
        const placeholders = hiddenMessageIds.map(() => '?').join(',');
        this.db
          .prepare(
            `
          UPDATE messages
          SET visibility = 'rewound',
              hidden_by_rewind_id = ?,
              hidden_at = ?,
              synced_at = NULL
          WHERE session_id = ?
            AND id IN (${placeholders})
        `
          )
          .run(rewindId, now, sessionId, ...hiddenMessageIds);
      }

      this.db
        .prepare(
          `
        INSERT INTO session_rewinds (
          id, session_id, anchor_message_id, anchor_prompt, anchor_timestamp,
          checkpoint_message_id, hidden_message_count, hidden_message_ids,
          files_restored, files_deleted, errors_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(rewindId, sessionId, userMessageId, anchorMessage.content, anchorMessage.timestamp, record.checkpointMessageId ?? null, hiddenMessageIds.length, JSON.stringify(hiddenMessageIds), record.filesRestored ?? 0, record.filesDeleted ?? 0, JSON.stringify(record.errors ?? []), now);

      this.db.prepare('UPDATE sessions SET updated_at = ?, synced_at = NULL WHERE id = ?').run(now, sessionId);

      return {
        rewindId,
        anchorMessage,
        hiddenMessageIds,
        hiddenMessageCount: hiddenMessageIds.length,
        activeMessages: this.getMessages(sessionId)
      };
    });

    return applyFn();
  }

  private rowToMessage(row: SQLiteRow): Message {
    const content = stripInlineAttachmentBlocks((row.content as string) || '');
    const artifacts = row.role === 'assistant' ? extractArtifacts(content) : [];
    return {
      id: row.id as string,
      role: row.role as Message['role'],
      content,
      timestamp: row.timestamp as number,
      visibility: (row.visibility as Message['visibility']) || 'active',
      hiddenByRewindId: (row.hidden_by_rewind_id as string) || undefined,
      hiddenAt: (row.hidden_at as number) || undefined,
      toolCalls: parseStoredJson<Message['toolCalls']>(row.tool_calls),
      toolResults: parseStoredJson<Message['toolResults']>(row.tool_results),
      attachments: sanitizeAttachmentsForPersistence(parseStoredJson<Message['attachments']>(row.attachments)),
      thinking: (row.thinking as string) || undefined,
      effortLevel: (row.effort_level as Message['effortLevel']) || undefined,
      contentParts: parseStoredJson<Message['contentParts']>(row.content_parts),
      metadata: parseStoredJson<Message['metadata']>(row.metadata),
      ...(row.is_meta ? { isMeta: true } : {}),
      compaction: parseStoredJson<Message['compaction']>(row.compaction),
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  }

  // --------------------------------------------------------------------------
  // Message Truncation (for checkpoint fork)
  // --------------------------------------------------------------------------

  /**
   * Delete all messages after a given message (by timestamp).
   * Used by checkpoint:fork to truncate conversation history.
   */
  truncateMessagesAfter(sessionId: string, messageId: string): number {
    const msg = this.db.prepare('SELECT timestamp FROM messages WHERE id = ? AND session_id = ?').get(messageId, sessionId) as { timestamp: number } | undefined;

    if (!msg) return 0;

    const result = this.db.prepare('DELETE FROM messages WHERE session_id = ? AND timestamp > ?').run(sessionId, msg.timestamp);

    return result.changes;
  }

  // --------------------------------------------------------------------------
  // Todos
  // --------------------------------------------------------------------------

  saveTodos(sessionId: string, todos: TodoItem[], updatedAt?: number): void {
    const now = updatedAt ?? Date.now();

    const saveFn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM todos WHERE session_id = ?').run(sessionId);

      const stmt = this.db.prepare(`
        INSERT INTO todos (session_id, content, status, active_form, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const todo of todos) {
        stmt.run(sessionId, todo.content, todo.status, todo.activeForm, now, now);
      }
    });

    saveFn();
  }

  getTodos(sessionId: string): TodoItem[] {
    const stmt = this.db.prepare(`
      SELECT content, status, active_form FROM todos
      WHERE session_id = ?
      ORDER BY id ASC
    `);

    const rows = stmt.all(sessionId) as SQLiteRow[];

    return rows.map(
      (row): TodoItem => ({
        content: row.content as string,
        status: row.status as TodoItem['status'],
        activeForm: row.active_form as string
      })
    );
  }

  // --------------------------------------------------------------------------
  // Session Tasks
  // --------------------------------------------------------------------------

  saveSessionTasks(sessionId: string, tasks: SessionTask[], updatedAt?: number): void {
    const now = updatedAt ?? Date.now();

    const saveFn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM session_tasks WHERE session_id = ?').run(sessionId);

      const stmt = this.db.prepare(`
        INSERT INTO session_tasks (
          session_id, task_id, subject, description, active_form, status, priority, owner,
          parent_task_id, blocks_json, blocked_by_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const task of tasks) {
        stmt.run(sessionId, task.id, task.subject, task.description, task.activeForm, task.status, task.priority, task.owner ?? null, task.parentTaskId ?? null, safeJsonStringify(task.blocks ?? []), safeJsonStringify(task.blockedBy ?? []), safeJsonStringify(task.metadata ?? {}), task.createdAt, task.updatedAt || now);
      }
    });

    saveFn();
  }

  getSessionTasks(sessionId: string): SessionTask[] {
    const stmt = this.db.prepare(`
      SELECT task_id, subject, description, active_form, status, priority, owner,
             parent_task_id, blocks_json, blocked_by_json, metadata_json, created_at, updated_at
      FROM session_tasks
      WHERE session_id = ?
      ORDER BY created_at ASC, task_id ASC
    `);

    const rows = stmt.all(sessionId) as SQLiteRow[];

    return rows.map(
      (row): SessionTask => ({
        id: String(row.task_id),
        subject: String(row.subject ?? ''),
        description: String(row.description ?? ''),
        activeForm: String(row.active_form ?? ''),
        status: row.status as SessionTask['status'],
        priority: row.priority as SessionTask['priority'],
        owner: row.owner == null ? undefined : String(row.owner),
        parentTaskId: row.parent_task_id == null ? undefined : String(row.parent_task_id),
        blocks: parseJsonArray(row.blocks_json),
        blockedBy: parseJsonArray(row.blocked_by_json),
        metadata: parseJsonObject(row.metadata_json),
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0
      })
    );
  }

  /**
   * Session Task 事件日志追加（roadmap 2.6，append-only 审计）。
   */
  appendSessionTaskEvents(events: Array<{ sessionId: string; taskId: string; at: number; kind: string; summary?: string; actor?: string }>): void {
    if (events.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO session_task_events (session_id, task_id, at, kind, summary, actor)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const event of events) {
      stmt.run(event.sessionId, event.taskId, event.at, event.kind, event.summary ?? null, event.actor ?? null);
    }
  }

  getSessionTaskEvents(sessionId: string, options: { taskId?: string; limit?: number } = {}): Array<{ taskId: string; at: number; kind: string; summary?: string; actor?: string }> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const params: unknown[] = [sessionId];
    let where = 'session_id = ?';
    if (options.taskId) {
      where += ' AND task_id = ?';
      params.push(options.taskId);
    }
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT task_id, at, kind, summary, actor FROM session_task_events
      WHERE ${where}
      ORDER BY at DESC, id DESC
      LIMIT ?
    `).all(...params) as SQLiteRow[];
    return rows.reverse().map((row) => ({
      taskId: String(row.task_id),
      at: Number(row.at),
      kind: String(row.kind),
      ...(row.summary != null ? { summary: String(row.summary) } : {}),
      ...(row.actor != null ? { actor: String(row.actor) } : {}),
    }));
  }

  /**
   * 事件历史里出现过的最大顶层任务 id（含已删任务）。
   * 单条 SQL 全量聚合——避免 getSessionTaskEvents 的 limit 钳制在长会话里
   * 漏掉早期已删 id 导致复用（Codex R2 MED）。
   */
  getMaxTopLevelTaskIdFromEvents(sessionId: string): number {
    try {
      const row = this.db.prepare(`
        SELECT MAX(CAST(
          CASE WHEN instr(task_id, '.') > 0
               THEN substr(task_id, 1, instr(task_id, '.') - 1)
               ELSE task_id END AS INTEGER)) AS max_top
        FROM session_task_events
        WHERE session_id = ?
      `).get(sessionId) as { max_top: number | null } | undefined;
      return Number(row?.max_top ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  // --------------------------------------------------------------------------
  // Context Interventions
  // --------------------------------------------------------------------------

  saveContextIntervention(sessionId: string, agentId: string | null | undefined, messageId: string, action: ContextInterventionAction | null, updatedAt?: number): void {
    const scopedAgentId = agentId?.trim() || 'global';
    if (!action) {
      this.db
        .prepare(
          `DELETE FROM context_interventions
            WHERE session_id = ? AND agent_id = ? AND message_id = ?`
        )
        .run(sessionId, scopedAgentId, messageId);
      return;
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO context_interventions (
          session_id, agent_id, message_id, action, updated_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(sessionId, scopedAgentId, messageId, action, updatedAt ?? Date.now());
  }

  getContextInterventions(sessionId: string, agentId?: string | null): ContextInterventionSnapshot {
    const scopedAgentId = agentId?.trim() || 'global';
    const rows = this.db
      .prepare(
        `SELECT message_id, action FROM context_interventions
          WHERE session_id = ? AND agent_id = ?
          ORDER BY updated_at ASC`
      )
      .all(sessionId, scopedAgentId) as SQLiteRow[];

    const snapshot: ContextInterventionSnapshot = {
      pinned: [],
      excluded: [],
      retained: []
    };

    for (const row of rows) {
      const id = String(row.message_id);
      if (row.action === 'pin') snapshot.pinned.push(id);
      if (row.action === 'exclude') snapshot.excluded.push(id);
      if (row.action === 'retain') snapshot.retained.push(id);
    }

    return snapshot;
  }

  // --------------------------------------------------------------------------
  // Session Runtime State
  // --------------------------------------------------------------------------

  saveSessionRuntimeState(
    sessionId: string,
    state: {
      compressionStateJson?: string | null;
      persistentSystemContext?: string[];
    },
    updatedAt?: number
  ): void {
    const existing = this.getSessionRuntimeState(sessionId);
    const compressionStateJson = state.compressionStateJson !== undefined ? state.compressionStateJson : (existing?.compressionStateJson ?? null);
    const persistentSystemContext = state.persistentSystemContext !== undefined ? state.persistentSystemContext : (existing?.persistentSystemContext ?? []);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_runtime_state (
          session_id, compression_state_json, persistent_system_context_json, updated_at
        ) VALUES (?, ?, ?, ?)`
      )
      .run(sessionId, compressionStateJson, safeJsonStringify(persistentSystemContext), updatedAt ?? Date.now());
  }

  getSessionRuntimeState(sessionId: string): {
    compressionStateJson: string | null;
    persistentSystemContext: string[];
  } | null {
    const row = this.db
      .prepare(
        `SELECT compression_state_json, persistent_system_context_json
          FROM session_runtime_state
          WHERE session_id = ?`
      )
      .get(sessionId) as SQLiteRow | undefined;

    if (!row) return null;

    return {
      compressionStateJson: row.compression_state_json == null ? null : String(row.compression_state_json),
      persistentSystemContext: parseJsonArray(row.persistent_system_context_json)
    };
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
    `
      )
      .all(...params, limit, offset) as SQLiteRow[];

    return rows.map((row) => this.rowToSession(row));
  }

  archiveSession(sessionId: string, updatedAt?: number): StoredSession | null {
    this.db.prepare(`UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?`).run(updatedAt ?? Date.now(), sessionId);
    return this.getSession(sessionId);
  }

  unarchiveSession(sessionId: string, updatedAt?: number): StoredSession | null {
    this.db.prepare(`UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?`).run(updatedAt ?? Date.now(), sessionId);
    return this.getSession(sessionId);
  }

  // --------------------------------------------------------------------------
  // Session Events
  // --------------------------------------------------------------------------

  // Note: session_events table methods are in TelemetryRepository

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private rowToSession(row: SQLiteRow): StoredSession {
    let lastTokenUsage: TokenUsage | undefined;
    if (row.last_token_usage) {
      try {
        lastTokenUsage = parseStoredJson<TokenUsage>(row.last_token_usage);
      } catch (err: unknown) {
        logger.warn('[DB] Failed to parse last_token_usage JSON:', err instanceof Error ? err.message : String(err));
      }
    }

    let workbenchProvenance: Session['workbenchProvenance'] | undefined;
    if (row.workbench_provenance) {
      try {
        workbenchProvenance = JSON.parse(row.workbench_provenance as string) as Session['workbenchProvenance'];
      } catch (err: unknown) {
        logger.warn('[DB] Failed to parse workbench_provenance JSON:', err instanceof Error ? err.message : String(err));
      }
    }

    let origin: Session['origin'] | undefined;
    if (row.origin) {
      const parsedOrigin = parseJsonObject(row.origin);
      if (typeof parsedOrigin.kind === 'string') {
        const metadata = parsedOrigin.metadata && typeof parsedOrigin.metadata === 'object' && !Array.isArray(parsedOrigin.metadata) ? (parsedOrigin.metadata as Record<string, unknown>) : undefined;
        origin = {
          kind: parsedOrigin.kind as NonNullable<Session['origin']>['kind'],
          id: typeof parsedOrigin.id === 'string' ? parsedOrigin.id : undefined,
          name: typeof parsedOrigin.name === 'string' ? parsedOrigin.name : undefined,
          metadata
        };
      }
    }

    const engine = row.agent_engine ? normalizeAgentEngineSession(parseJsonObject(row.agent_engine)) : normalizeAgentEngineSession(null);

    const isArchived = row.status === 'archived';
    const isDeleted = Boolean(row.is_deleted);

    return {
      id: row.id as string,
      userId: row.user_id == null ? null : String(row.user_id),
      title: row.title as string,
      modelConfig: {
        provider: row.model_provider as ModelProvider,
        model: row.model_name as string
      },
      workingDirectory: row.working_directory as string | undefined,
      type: (row.session_type as Session['type']) || 'chat',
      origin,
      parentSessionId: row.parent_session_id as string | undefined,
      sourceRunId: row.source_run_id as string | undefined,
      engine,
      readOnly: Boolean(row.read_only),
      retryOfSessionId: row.retry_of_session_id as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      messageCount: (row.message_count as number) || 0,
      turnCount: (row.turn_count as number) || 0,
      workspace: row.workspace as string | undefined,
      workbenchProvenance,
      status: (row.status as SessionStatus) || 'idle',
      lastTokenUsage,
      isArchived,
      archivedAt: isArchived ? (row.updated_at as number) : undefined,
      isDeleted,
      gitBranch: row.git_branch as string | undefined,
      projectId: (row.project_id as string) || undefined
    };
  }
}

// ----------------------------------------------------------------------------
// FTS query helper
// ----------------------------------------------------------------------------

/**
 * 把用户查询归一化成 FTS5 安全的表达式。
 *
 * - 以 `"` 开头表示用户知道自己在写 FTS5 语法（phrase / prefix / operators），
 *   直接原样透传
 * - 否则把整个查询包成 phrase literal：双引号包裹 + 内部 `"` 转义为 `""`
 *   → 避开 `-` `+` `:` 等 FTS5 操作符被误解释
 */
function normalizeFtsQuery(raw: string): string {
  if (raw.startsWith('"')) {
    return raw;
  }
  return '"' + raw.replace(/"/g, '""') + '"';
}
