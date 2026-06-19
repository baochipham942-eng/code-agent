// ============================================================================
// CLI Database Service - 独立于 Electron 的数据库层
// ============================================================================

import path from 'path';
import fs from 'fs';
import os from 'os';
import Module from 'module';
import type {
  Session,
  SessionStatus,
  Message,
  ToolResult,
  ModelProvider,
  TodoItem,
  TokenUsage,
  PRLink,
} from '../shared/contract';
import {
  TRANSCRIPT_FTS_BODY_COLUMN_INDEX,
  type TranscriptKind,
} from '../shared/transcriptFts.sql';
import { MEMORY } from '../shared/constants';
import { migrateCliSessionsTable, createCliTables, createCliIndexes } from './cliDatabaseSchema';
import { visibleHistoryMessageWhere } from './cliDatabaseSql';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface StoredSession extends Session {
  messageCount: number;
}

type SQLiteRow = Record<string, unknown>;
// CJS 打包态下 import.meta.url 为 undefined（esbuild 把 import.meta 替换成 {}），
// 必须优先用宿主 require；仅 ESM/tsx dev 态才回退到 createRequire。对齐 nodeModuleLoader.ts。
const cliRequire = typeof require === 'function' ? require : Module.createRequire(import.meta.url);

function parseJson<T>(value: string): T {
  const parsed: unknown = JSON.parse(value);
  return parsed as T;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
}

// ----------------------------------------------------------------------------
// CLI Database Service
// ----------------------------------------------------------------------------

// 延迟加载 better-sqlite3，避免 native 模块版本冲突
let Database: typeof import('better-sqlite3') | null = null;

export class CLIDatabaseService {
  private db: import('better-sqlite3').Database | null = null;
  private dbPath: string;
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;

  constructor() {
    const dataDir = this.getDataDir();
    this.dbPath = path.join(dataDir, 'code-agent.db');
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * 暴露底层 better-sqlite3 Database 引用，供 Repository 通过 duck-typed
   * RawDbProvider 接口注入使用。
   * 未初始化时返回 null —— 调用方应先用 isInitialized gate 守卫。
   */
  getDb(): import('better-sqlite3').Database | null {
    return this.db;
  }

  /**
   * 等待数据库初始化完成（供 SessionManager 等在需要时等待）
   */
  async waitForInit(): Promise<boolean> {
    if (this._initialized) return true;
    if (this._initPromise) {
      try {
        await this._initPromise;
        return this._initialized;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * 获取数据目录
   */
  private getDataDir(): string {
    const dataDir = process.env.CODE_AGENT_DATA_DIR || path.join(os.homedir(), '.code-agent');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    return dataDir;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // 防止重复初始化
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInitialize();
    return this._initPromise;
  }

  private async _doInitialize(): Promise<void> {
    // 延迟加载 better-sqlite3
    if (!Database) {
      try {
        Database = cliRequire('better-sqlite3') as typeof import('better-sqlite3');
      } catch (error) {
        throw new Error(`Failed to load better-sqlite3: ${error instanceof Error ? error.message : error}`, { cause: error });
      }
    }

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const DatabaseCtor = Database;
    if (!DatabaseCtor) throw new Error('better-sqlite3 constructor not loaded');
    this.db = new DatabaseCtor(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.createTables();
    this.migrateSessionsTable();
    this.createIndexes();
    this._initialized = true;
  }

  private migrateSessionsTable(): void {
    migrateCliSessionsTable(this.db);
  }

  private createTables(): void {
    createCliTables(this.db);
  }

  private createIndexes(): void {
    createCliIndexes(this.db);
  }

  // --------------------------------------------------------------------------
  // Turn Snapshots — 调试快照（CLI ↔ Electron 共享同一张表）
  // --------------------------------------------------------------------------

  insertTurnSnapshot(input: {
    sessionId: string;
    turnId?: string | null;
    turnIndex: number;
    contextChunks?: unknown;
    tokenBreakdown?: unknown;
    createdAt?: number;
  }): { id: string; createdAt: number; byteSize: number } {
    if (!this.db) throw new Error('Database not initialized');
    const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const createdAt = input.createdAt ?? Date.now();
    const contextJson = input.contextChunks ? JSON.stringify(input.contextChunks) : null;
    const tokenJson = input.tokenBreakdown ? JSON.stringify(input.tokenBreakdown) : null;
    // byte_size 用 utf-8 字节数估算，给设置页统计用
    const byteSize =
      (contextJson ? Buffer.byteLength(contextJson, 'utf8') : 0) +
      (tokenJson ? Buffer.byteLength(tokenJson, 'utf8') : 0);

    this.db
      .prepare(
        `INSERT INTO turn_snapshots (id, session_id, turn_id, turn_index, context_chunks, token_breakdown, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sessionId, input.turnId ?? null, input.turnIndex, contextJson, tokenJson, byteSize, createdAt);
    return { id, createdAt, byteSize };
  }

  getSnapshotStats(): { snapshotCount: number; sessionCount: number; totalBytes: number } {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c, COUNT(DISTINCT session_id) AS sc, COALESCE(SUM(byte_size), 0) AS bytes FROM turn_snapshots`,
      )
      .get() as { c: number; sc: number; bytes: number } | undefined;
    return {
      snapshotCount: row?.c ?? 0,
      sessionCount: row?.sc ?? 0,
      totalBytes: row?.bytes ?? 0,
    };
  }

  clearSnapshots(opts: { olderThanMs?: number; sessionId?: string } = {}): number {
    if (!this.db) throw new Error('Database not initialized');
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.olderThanMs !== undefined) {
      conditions.push('created_at < ?');
      params.push(Date.now() - opts.olderThanMs);
    }
    if (opts.sessionId) {
      conditions.push('session_id = ?');
      params.push(opts.sessionId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = this.db.prepare(`DELETE FROM turn_snapshots ${where}`).run(...params);
    return result.changes;
  }

  // --------------------------------------------------------------------------
  // Compaction Snapshots
  // --------------------------------------------------------------------------

  insertCompactionSnapshot(input: {
    sessionId: string;
    strategy?: string | null;
    preMessageCount: number;
    postMessageCount: number;
    preTokens: number;
    postTokens: number;
    savedTokens: number;
    usagePercent?: number | null;
    preMessagesSummary?: unknown;
    postMessagesSummary?: unknown;
    createdAt?: number;
  }): { id: string; createdAt: number; byteSize: number } {
    if (!this.db) throw new Error('Database not initialized');
    const id = `compact_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const createdAt = input.createdAt ?? Date.now();
    const preJson = input.preMessagesSummary ? JSON.stringify(input.preMessagesSummary) : null;
    const postJson = input.postMessagesSummary ? JSON.stringify(input.postMessagesSummary) : null;
    const byteSize =
      (preJson ? Buffer.byteLength(preJson, 'utf8') : 0) +
      (postJson ? Buffer.byteLength(postJson, 'utf8') : 0);

    this.db
      .prepare(
        `INSERT INTO compaction_snapshots (id, session_id, strategy, pre_message_count, post_message_count, pre_tokens, post_tokens, saved_tokens, usage_percent, pre_messages_summary, post_messages_summary, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.strategy ?? null,
        input.preMessageCount,
        input.postMessageCount,
        input.preTokens,
        input.postTokens,
        input.savedTokens,
        input.usagePercent ?? null,
        preJson,
        postJson,
        byteSize,
        createdAt,
      );
    return { id, createdAt, byteSize };
  }

  listCompactionSnapshots(sessionId: string, limit: number = 100): Array<{
    id: string;
    sessionId: string;
    strategy: string | null;
    preMessageCount: number;
    postMessageCount: number;
    preTokens: number;
    postTokens: number;
    savedTokens: number;
    usagePercent: number | null;
    preMessagesSummary: unknown;
    postMessagesSummary: unknown;
    byteSize: number;
    createdAt: number;
  }> {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM compaction_snapshots WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
      )
      .all(sessionId, limit) as SQLiteRow[];
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      strategy: row.strategy == null ? null : String(row.strategy),
      preMessageCount: Number(row.pre_message_count ?? 0),
      postMessageCount: Number(row.post_message_count ?? 0),
      preTokens: Number(row.pre_tokens ?? 0),
      postTokens: Number(row.post_tokens ?? 0),
      savedTokens: Number(row.saved_tokens ?? 0),
      usagePercent: row.usage_percent == null ? null : Number(row.usage_percent),
      preMessagesSummary: row.pre_messages_summary ? parseJson<unknown>(String(row.pre_messages_summary)) : null,
      postMessagesSummary: row.post_messages_summary ? parseJson<unknown>(String(row.post_messages_summary)) : null,
      byteSize: Number(row.byte_size ?? 0),
      createdAt: Number(row.created_at ?? 0),
    }));
  }

  getCompactionStats(): { snapshotCount: number; sessionCount: number; totalBytes: number } {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c, COUNT(DISTINCT session_id) AS sc, COALESCE(SUM(byte_size), 0) AS bytes FROM compaction_snapshots`,
      )
      .get() as { c: number; sc: number; bytes: number } | undefined;
    return {
      snapshotCount: row?.c ?? 0,
      sessionCount: row?.sc ?? 0,
      totalBytes: row?.bytes ?? 0,
    };
  }

  clearCompactionSnapshots(opts: { olderThanMs?: number; sessionId?: string } = {}): number {
    if (!this.db) throw new Error('Database not initialized');
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.olderThanMs !== undefined) {
      conditions.push('created_at < ?');
      params.push(Date.now() - opts.olderThanMs);
    }
    if (opts.sessionId) {
      conditions.push('session_id = ?');
      params.push(opts.sessionId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = this.db.prepare(`DELETE FROM compaction_snapshots ${where}`).run(...params);
    return result.changes;
  }

  listTurnSnapshots(sessionId: string, limit: number = 100): Array<{
    id: string;
    sessionId: string;
    turnId: string | null;
    turnIndex: number;
    contextChunks: unknown;
    tokenBreakdown: unknown;
    byteSize: number;
    createdAt: number;
  }> {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM turn_snapshots WHERE session_id = ? ORDER BY turn_index ASC, created_at ASC LIMIT ?`,
      )
      .all(sessionId, limit) as SQLiteRow[];
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      turnId: row.turn_id == null ? null : String(row.turn_id),
      turnIndex: Number(row.turn_index ?? 0),
      contextChunks: row.context_chunks ? parseJson<unknown>(String(row.context_chunks)) : null,
      tokenBreakdown: row.token_breakdown ? parseJson<unknown>(String(row.token_breakdown)) : null,
      byteSize: Number(row.byte_size ?? 0),
      createdAt: Number(row.created_at ?? 0),
    }));
  }

  // --------------------------------------------------------------------------
  // Session CRUD
  // --------------------------------------------------------------------------

  createSession(session: Session): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at, workspace, status, last_token_usage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.id,
      session.title,
      session.modelConfig.provider,
      session.modelConfig.model,
      session.workingDirectory || null,
      session.createdAt,
      session.updatedAt,
      session.workspace || null,
      session.status || 'idle',
      session.lastTokenUsage ? JSON.stringify(session.lastTokenUsage) : null
    );
  }

  getSession(sessionId: string): StoredSession | null {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id AND ${visibleHistoryMessageWhere('m')}
      WHERE s.id = ?
      GROUP BY s.id
    `);

    const row = stmt.get(sessionId) as SQLiteRow | undefined;
    if (!row) return null;

    return this.rowToSession(row);
  }

  listSessions(limit: number = 50, offset: number = 0): StoredSession[] {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id AND ${visibleHistoryMessageWhere('m')}
      WHERE s.status != 'archived'
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(limit, offset) as SQLiteRow[];
    return rows.map((row) => this.rowToSession(row));
  }

  updateSession(sessionId: string, updates: Partial<Session>): void {
    if (!this.db) throw new Error('Database not initialized');

    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET title = ?, model_provider = ?, model_name = ?,
          working_directory = ?, updated_at = ?, workspace = ?, status = ?, last_token_usage = ?,
          pr_link = ?
      WHERE id = ?
    `);

    const lastTokenUsage = updates.lastTokenUsage !== undefined
      ? JSON.stringify(updates.lastTokenUsage)
      : (session.lastTokenUsage ? JSON.stringify(session.lastTokenUsage) : null);

    const prLink = updates.prLink !== undefined
      ? JSON.stringify(updates.prLink)
      : (session.prLink ? JSON.stringify(session.prLink) : null);

    stmt.run(
      updates.title ?? session.title,
      updates.modelConfig?.provider ?? session.modelConfig.provider,
      updates.modelConfig?.model ?? session.modelConfig.model,
      updates.workingDirectory ?? session.workingDirectory,
      Date.now(),
      updates.workspace !== undefined ? updates.workspace : session.workspace,
      updates.status ?? session.status ?? 'idle',
      lastTokenUsage,
      prLink,
      sessionId
    );
  }

  deleteSession(sessionId: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  private rowToSession(row: SQLiteRow): StoredSession {
    let lastTokenUsage: TokenUsage | undefined;
    if (row.last_token_usage) {
      try {
        lastTokenUsage = parseJson<TokenUsage>(String(row.last_token_usage));
      } catch {
        // 忽略解析错误
      }
    }

    let prLink: PRLink | undefined;
    if (row.pr_link) {
      try {
        prLink = parseJson<PRLink>(String(row.pr_link));
      } catch {
        // 忽略解析错误
      }
    }

    return {
      id: row.id as string,
      title: row.title as string,
      modelConfig: {
        provider: row.model_provider as ModelProvider,
        model: row.model_name as string,
      },
      workingDirectory: row.working_directory as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      messageCount: (row.message_count as number) || 0,
      workspace: row.workspace as string | undefined,
      status: (row.status as SessionStatus) || 'idle',
      lastTokenUsage,
      prLink,
    };
  }

  // --------------------------------------------------------------------------
  // Message CRUD
  // --------------------------------------------------------------------------

  addMessage(sessionId: string, message: Message): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls, tool_results, attachments, content_parts, is_meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const attachmentsMeta = message.attachments?.map(a => ({
      id: a.id,
      type: a.type,
      category: a.category,
      name: a.name,
      size: a.size,
      mimeType: a.mimeType,
      path: a.path,
    }));

    stmt.run(
      message.id,
      sessionId,
      message.role,
      message.content,
      message.timestamp,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolResults ? JSON.stringify(message.toolResults) : null,
      attachmentsMeta ? JSON.stringify(attachmentsMeta) : null,
      message.contentParts ? JSON.stringify(message.contentParts) : null,
      message.isMeta ? 1 : 0
    );

    // 更新 session 的 updated_at
    if (!message.isMeta) {
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
    }
  }

  getMessages(sessionId: string, limit?: number): Message[] {
    if (!this.db) throw new Error('Database not initialized');

    let sql = `
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `;

    if (limit !== undefined) {
      sql += ` LIMIT ${limit}`;
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(sessionId) as SQLiteRow[];

    return rows.map((row): Message => ({
      id: row.id as string,
      role: row.role as Message['role'],
      content: row.content as string,
      timestamp: row.timestamp as number,
      toolCalls: row.tool_calls ? parseJson<NonNullable<Message['toolCalls']>>(String(row.tool_calls)) : undefined,
      toolResults: row.tool_results ? parseJson<NonNullable<Message['toolResults']>>(String(row.tool_results)) : undefined,
      attachments: row.attachments ? parseJson<NonNullable<Message['attachments']>>(String(row.attachments)) : undefined,
      contentParts: row.content_parts ? parseJson<NonNullable<Message['contentParts']>>(String(row.content_parts)) : undefined,
      ...(row.is_meta ? { isMeta: true } : {}),
    }));
  }

  getRecentMessages(sessionId: string, count: number): Message[] {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(sessionId, count) as SQLiteRow[];

    return rows.reverse().map((row): Message => ({
      id: row.id as string,
      role: row.role as Message['role'],
      content: row.content as string,
      timestamp: row.timestamp as number,
      toolCalls: row.tool_calls ? parseJson<NonNullable<Message['toolCalls']>>(String(row.tool_calls)) : undefined,
      toolResults: row.tool_results ? parseJson<NonNullable<Message['toolResults']>>(String(row.tool_results)) : undefined,
      contentParts: row.content_parts ? parseJson<NonNullable<Message['contentParts']>>(String(row.content_parts)) : undefined,
      ...(row.is_meta ? { isMeta: true } : {}),
    }));
  }

  // --------------------------------------------------------------------------
  // Memories (Workstream A — preCompact flush target)
  // --------------------------------------------------------------------------

  createMemory(data: {
    type: string;
    category: string;
    content: string;
    summary?: string;
    source: string;
    projectPath?: string;
    sessionId?: string;
    confidence: number;
    metadata?: Record<string, unknown>;
  }): { id: string; createdAt: number; updatedAt: number } {
    if (!this.db) throw new Error('Database not initialized');
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const now = Date.now();

    this.db
      .prepare(
        `
        INSERT INTO memories (id, type, category, content, summary, source, project_path, session_id, confidence, metadata, access_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `,
      )
      .run(
        id,
        data.type,
        data.category,
        data.content,
        data.summary ?? null,
        data.source,
        data.projectPath ?? null,
        data.sessionId ?? null,
        data.confidence,
        JSON.stringify(data.metadata ?? {}),
        now,
        now,
      );

    return { id, createdAt: now, updatedAt: now };
  }

  listMemories(options: {
    type?: string;
    category?: string;
    source?: string;
    projectPath?: string;
    sessionId?: string;
    limit?: number;
    offset?: number;
    orderBy?: string;
    orderDir?: 'ASC' | 'DESC';
  } = {}): Array<{
    id: string;
    type: string;
    category: string;
    content: string;
    summary: string | null;
    source: string;
    projectPath: string | null;
    sessionId: string | null;
    confidence: number;
    metadata: Record<string, unknown>;
    accessCount: number;
    createdAt: number;
    updatedAt: number;
  }> {
    if (!this.db) return [];
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    if (options.category) {
      conditions.push('category = ?');
      params.push(options.category);
    }
    if (options.source) {
      conditions.push('source = ?');
      params.push(options.source);
    }
    if (options.projectPath) {
      conditions.push('project_path = ?');
      params.push(options.projectPath);
    }
    if (options.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = ['created_at', 'updated_at', 'confidence', 'access_count'].includes(
      options.orderBy ?? '',
    )
      ? options.orderBy
      : 'created_at';
    const orderDir = options.orderDir === 'ASC' ? 'ASC' : 'DESC';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT * FROM memories ${where} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as SQLiteRow[];

    return rows.map((row) => ({
      id: String(row.id),
      type: String(row.type),
      category: String(row.category),
      content: String(row.content),
      summary: row.summary == null ? null : String(row.summary),
      source: String(row.source),
      projectPath: row.project_path == null ? null : String(row.project_path),
      sessionId: row.session_id == null ? null : String(row.session_id),
      confidence: Number(row.confidence ?? 1),
      metadata: row.metadata ? parseJsonRecord(String(row.metadata)) : {},
      accessCount: Number(row.access_count ?? 0),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }));
  }

  /**
   * FTS5 全文搜索历史会话消息（与 Electron SessionRepository.searchSessionMessagesFts 对齐）
   * - 查询默认包成 phrase literal，避免 `-` / `:` 之类 FTS5 运算符误解释
   * - sessionId 参数限定搜索作用域
   */
  searchSessionMessagesFts(
    query: string,
    options: { limit?: number; sessionId?: string } = {},
  ): Array<{
    messageId: string;
    sessionId: string;
    role: string;
    content: string;
    timestamp: number;
  }> {
    if (!this.db) return [];
    const trimmed = query.trim();
    if (trimmed.length < 3) return [];

    const ftsQuery = trimmed.startsWith('"')
      ? trimmed
      : '"' + trimmed.replace(/"/g, '""') + '"';
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const params: unknown[] = [ftsQuery];
    let whereSession = '';
    if (options.sessionId) {
      whereSession = 'AND f.session_id = ?';
      params.push(options.sessionId);
    }
    params.push(limit);

    try {
      const rows = this.db
        .prepare(
          `
          SELECT f.message_id, f.session_id, f.role, f.content, f.timestamp
          FROM session_messages_fts f
          JOIN messages m ON m.id = f.message_id
          WHERE f.content MATCH ? ${whereSession}
            AND ${visibleHistoryMessageWhere('m')}
          ORDER BY rank, f.timestamp DESC
          LIMIT ?
          `,
        )
        .all(...params) as SQLiteRow[];

      return rows.map((row) => ({
        messageId: String(row.message_id ?? ''),
        sessionId: String(row.session_id ?? ''),
        role: String(row.role ?? ''),
        content: String(row.content ?? ''),
        timestamp: Number(row.timestamp ?? 0),
      }));
    } catch {
      // FTS 表不存在或查询失败 — 返回空，不阻塞调用方
      return [];
    }
  }

  /**
   * Transcript FTS（kind 分解索引，roadmap 2.1）— 与 Electron
   * SessionRepository.searchTranscriptFts 对齐，History 工具 CLI 模式底层。
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
    } = {},
  ): Array<{
    messageId: string;
    sessionId: string;
    kind: TranscriptKind;
    toolName: string | null;
    snippet: string;
    timestamp: number;
  }> {
    if (!this.db) return [];
    const trimmed = query.trim();
    if (trimmed.length < 3) return [];

    const ftsQuery = trimmed.startsWith('"')
      ? trimmed
      : '"' + trimmed.replace(/"/g, '""') + '"';
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
    const rows = this.db
      .prepare(
        `
        SELECT f.message_id, f.session_id, f.kind, f.tool_name, f.timestamp,
               snippet(transcript_fts, ${TRANSCRIPT_FTS_BODY_COLUMN_INDEX}, '«', '»', ' … ', 24) AS snip
        FROM transcript_fts f
        JOIN messages m ON m.id = f.message_id
        WHERE f.body MATCH ? ${extra}
          AND COALESCE(m.visibility, 'active') = 'active'
        ORDER BY rank, f.timestamp DESC
        LIMIT ?
        `,
      )
      .all(...params) as SQLiteRow[];

    return rows.map((row) => ({
      messageId: String(row.message_id ?? ''),
      sessionId: String(row.session_id ?? ''),
      kind: String(row.kind ?? '') as TranscriptKind,
      toolName: row.tool_name ? String(row.tool_name) : null,
      snippet: String(row.snip ?? ''),
      timestamp: Number(row.timestamp ?? 0),
    }));
  }

  /**
   * 锚点 ±N 条消息上下文（与 Electron SessionRepository.getTranscriptAround 对齐）。
   */
  getTranscriptAround(
    messageId: string,
    options: { before?: number; after?: number } = {},
  ): { sessionId: string; messages: Array<{ message: Message; matched: boolean }> } | null {
    if (!this.db) return null;
    const clampWindow = (value: number | undefined, fallback: number): number => {
      if (value === undefined || !Number.isFinite(value)) return fallback;
      return Math.max(0, Math.min(Math.floor(value), MEMORY.HISTORY_AROUND_MAX_WINDOW));
    };
    const before = clampWindow(options.before, MEMORY.HISTORY_AROUND_DEFAULT_WINDOW);
    const after = clampWindow(options.after, MEMORY.HISTORY_AROUND_DEFAULT_WINDOW);

    const anchor = this.db
      .prepare('SELECT rowid AS rid, session_id, timestamp FROM messages WHERE id = ?')
      .get(messageId) as { rid: number; session_id: string; timestamp: number } | undefined;
    if (!anchor) return null;

    const visible = visibleHistoryMessageWhere('m');
    const beforeRows = this.db
      .prepare(
        `
        SELECT m.* FROM messages m
        WHERE m.session_id = ?
          AND (m.timestamp < ? OR (m.timestamp = ? AND m.rowid <= ?))
          AND (${visible} OR m.id = ?)
        ORDER BY m.timestamp DESC, m.rowid DESC
        LIMIT ?
        `,
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
        `,
      )
      .all(anchor.session_id, anchor.timestamp, anchor.timestamp, anchor.rid, after) as SQLiteRow[];

    const toMessage = (row: SQLiteRow): Message => ({
      id: row.id as string,
      role: row.role as Message['role'],
      content: (row.content as string) || '',
      timestamp: row.timestamp as number,
      toolCalls: row.tool_calls ? parseJson<NonNullable<Message['toolCalls']>>(String(row.tool_calls)) : undefined,
      toolResults: row.tool_results ? parseJson<NonNullable<Message['toolResults']>>(String(row.tool_results)) : undefined,
      thinking: (row.thinking as string) || undefined,
      ...(row.is_meta ? { isMeta: true } : {}),
    });

    const ordered = [...beforeRows.reverse(), ...afterRows];
    return {
      sessionId: anchor.session_id,
      messages: ordered.map((row) => ({
        message: toMessage(row),
        matched: String(row.id) === messageId,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Tool Cache
  // --------------------------------------------------------------------------

  private hashArguments(toolName: string, args: Record<string, unknown>): string {
    const str = `${toolName}:${JSON.stringify(args)}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  saveToolExecution(
    sessionId: string,
    messageId: string | null,
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    ttlMs?: number
  ): void {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    const expiresAt = ttlMs ? now + ttlMs : null;

    const stmt = this.db.prepare(`
      INSERT INTO tool_executions (id, session_id, message_id, tool_name, arguments, arguments_hash, result, success, duration, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      `te_${now}_${Math.random().toString(36).substr(2, 9)}`,
      sessionId,
      messageId,
      toolName,
      JSON.stringify(args),
      this.hashArguments(toolName, args),
      JSON.stringify(result),
      result.success ? 1 : 0,
      result.duration || 0,
      now,
      expiresAt
    );
  }

  getCachedToolResult(toolName: string, args: Record<string, unknown>): ToolResult | null {
    if (!this.db) throw new Error('Database not initialized');

    const hash = this.hashArguments(toolName, args);
    const now = Date.now();

    const stmt = this.db.prepare(`
      SELECT result FROM tool_executions
      WHERE arguments_hash = ? AND tool_name = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const row = stmt.get(hash, toolName, now) as SQLiteRow | undefined;
    if (!row) return null;

    return parseJson<ToolResult>(String(row.result));
  }

  listToolExecutions(sessionId: string, limit: number = 500): Array<{
    id: string;
    sessionId: string;
    messageId: string | null;
    toolName: string;
    arguments: Record<string, unknown>;
    result: ToolResult;
    success: boolean;
    duration: number;
    createdAt: number;
  }> {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT id, session_id, message_id, tool_name, arguments, result, success, duration, created_at
         FROM tool_executions WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
      )
      .all(sessionId, limit) as SQLiteRow[];
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      messageId: row.message_id == null ? null : String(row.message_id),
      toolName: String(row.tool_name),
      arguments: row.arguments ? parseJsonRecord(String(row.arguments)) : {},
      result: row.result ? parseJson<ToolResult>(String(row.result)) : { toolCallId: String(row.id), success: false },
      success: Number(row.success ?? 0) === 1,
      duration: Number(row.duration ?? 0),
      createdAt: Number(row.created_at ?? 0),
    }));
  }

  cleanExpiredCache(): number {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      DELETE FROM tool_executions
      WHERE expires_at IS NOT NULL AND expires_at < ?
    `);

    const result = stmt.run(Date.now());
    return result.changes;
  }

  // --------------------------------------------------------------------------
  // Todos
  // --------------------------------------------------------------------------

  saveTodos(sessionId: string, todos: TodoItem[]): void {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    this.db.prepare('DELETE FROM todos WHERE session_id = ?').run(sessionId);

    const stmt = this.db.prepare(`
      INSERT INTO todos (session_id, content, status, active_form, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const todo of todos) {
      stmt.run(sessionId, todo.content, todo.status, todo.activeForm, now, now);
    }
  }

  getTodos(sessionId: string): TodoItem[] {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT content, status, active_form FROM todos
      WHERE session_id = ?
      ORDER BY id ASC
    `);

    const rows = stmt.all(sessionId) as SQLiteRow[];

    return rows.map((row): TodoItem => ({
      content: row.content as string,
      status: row.status as TodoItem['status'],
      activeForm: row.active_form as string,
    }));
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  getStats(): {
    sessionCount: number;
    messageCount: number;
    toolExecutionCount: number;
  } {
    if (!this.db) throw new Error('Database not initialized');

    const sessionRow = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as SQLiteRow;
    const messageRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as SQLiteRow;
    const toolRow = this.db.prepare('SELECT COUNT(*) as c FROM tool_executions').get() as SQLiteRow;

    return {
      sessionCount: sessionRow.c as number,
      messageCount: messageRow.c as number,
      toolExecutionCount: toolRow.c as number,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let dbInstance: CLIDatabaseService | null = null;

export function getCLIDatabase(): CLIDatabaseService {
  if (!dbInstance) {
    dbInstance = new CLIDatabaseService();
  }
  return dbInstance;
}

export async function initCLIDatabase(): Promise<CLIDatabaseService> {
  const db = getCLIDatabase();
  await db.initialize();
  return db;
}
