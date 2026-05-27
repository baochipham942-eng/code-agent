// ============================================================================
// Database Service - SQLite 数据持久化层（薄门面，委托给 Repository）
// ============================================================================

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { app } from '../../platform';
import { createLogger } from '../infra/logger';
import { getServiceRegistry } from '../serviceRegistry';
import { loadBetterSqlite3 } from './database/nativeLoader';
import { applySchema } from './database/schema';
import { applyIndexes } from './database/indexes';
import { applySessionsMigrations, applyTelemetryTurnsMigrations, applyEvaluationCleanupMigration } from './database/migrations';

const logger = createLogger('DatabaseService');
const moduleDir = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
import type BetterSqlite3 from 'better-sqlite3';
const Database = loadBetterSqlite3(moduleDir, logger);
import type { Session, Message, ToolResult, ModelProvider, TodoItem, SessionTask } from '../../../shared/contract';
import type { ContextInterventionAction, ContextInterventionSnapshot } from '../../../shared/contract/contextView';
import type { CaptureItem, CaptureSource, CaptureStats } from '../../../shared/contract/capture';

// Re-export types from repositories（保持外部调用方零修改）
export type { StoredSession, StoredMessage, MemoryRecord, RelationQueryOptions, EntityRelation, UserPreference, ProjectKnowledge, ToolExecution } from './repositories';

import { SessionRepository, MemoryRepository, ConfigRepository, CaptureRepository, ExperimentRepository, SwarmTraceRepository, PendingApprovalRepository } from './repositories';

type DatabaseRecoveryCallback = () => void;

const databaseRecoveryListeners = new Set<DatabaseRecoveryCallback>();

export function onDatabaseRecovered(callback: DatabaseRecoveryCallback): () => void {
  databaseRecoveryListeners.add(callback);
  return () => {
    databaseRecoveryListeners.delete(callback);
  };
}

function notifyDatabaseRecovered(): void {
  for (const listener of databaseRecoveryListeners) {
    try {
      listener();
    } catch (error) {
      logger.warn('[DatabaseService] Database recovery listener failed:', error);
    }
  }
}

// ----------------------------------------------------------------------------
// Database Service
// ----------------------------------------------------------------------------

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export class DatabaseService {
  private db: BetterSqlite3.Database | null = null;
  private dbPath: string;
  private _initPromise: Promise<void> | null = null;
  private _initFailed = false;
  private _retryCount = 0;
  private readonly MAX_RETRIES = 3;
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;

  // Repositories
  private sessionRepo!: SessionRepository;
  private memoryRepo!: MemoryRepository;
  private configRepo!: ConfigRepository;
  private captureRepo!: CaptureRepository;
  private experimentRepo!: ExperimentRepository;
  private swarmTraceRepo!: SwarmTraceRepository;
  private pendingApprovalRepo!: PendingApprovalRepository;

  constructor() {
    const userDataPath = app?.getPath?.('userData') || process.cwd();
    this.dbPath = path.join(userDataPath, 'code-agent.db');
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * 是否已初始化完成
   */
  get isReady(): boolean {
    return this.db !== null;
  }

  /**
   * 等待数据库初始化完成（供其他服务在启动时等待）
   * 如果尚未开始初始化，返回立即 resolve 的 Promise（不会自动触发初始化）
   */
  async waitForInit(): Promise<boolean> {
    if (this.db) return true;
    if (this._initPromise) {
      try {
        await this._initPromise;
        return this.db !== null;
      } catch (error) {
        logger.warn('[DatabaseService] Failed to wait for init:', error);
        return false;
      }
    }
    return false;
  }

  async initialize(): Promise<void> {
    // 已初始化成功，跳过
    if (this.db) return;
    // 正在初始化中，等待
    if (this._initPromise && !this._initFailed) return this._initPromise;

    this._initFailed = false;
    this._initPromise = this._doInitialize().catch((err) => {
      this._initFailed = true;
      this._scheduleRetry();
      throw err;
    });
    return this._initPromise;
  }

  /**
   * 初始化失败后自动重试（指数退避，最多 MAX_RETRIES 次）
   */
  private _scheduleRetry(): void {
    if (this._retryCount >= this.MAX_RETRIES || !Database) return;

    this._retryCount++;
    const delay = Math.min(1000 * Math.pow(2, this._retryCount - 1), 10000);
    logger.warn(`Database init retry ${this._retryCount}/${this.MAX_RETRIES} in ${delay}ms`);

    this._retryTimer = setTimeout(async () => {
      try {
        this._initPromise = null;
        this._initFailed = false;
        await this.initialize();
        notifyDatabaseRecovered();
        logger.info(`Database recovered after ${this._retryCount} retries`);
        this._retryCount = 0;
      } catch (error) {
        logger.warn('[DatabaseService] Failed to retry initialization:', error);
        // _scheduleRetry will be called again by initialize().catch
      }
    }, delay);
  }

  private async _doInitialize(): Promise<void> {
    // 确保目录存在（异步，性能优化）
    const dir = path.dirname(this.dbPath);
    await fs.promises.mkdir(dir, { recursive: true }).catch((err) => {
      // EEXIST 表示目录已存在，不是错误
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    });

    if (!Database) {
      throw new Error('better-sqlite3 not available (CLI mode or native module missing)');
    }

    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');

      applySchema(this.db, logger);
      applySessionsMigrations(this.db, logger);
      applyTelemetryTurnsMigrations(this.db, logger);
      applyEvaluationCleanupMigration(this.db, logger);
      applyIndexes(this.db);

      // 初始化 Repositories
      this.sessionRepo = new SessionRepository(this.db);
      this.memoryRepo = new MemoryRepository(this.db);
      this.configRepo = new ConfigRepository(this.db);
      this.captureRepo = new CaptureRepository(this.db);
      this.experimentRepo = new ExperimentRepository(this.db);
      this.swarmTraceRepo = new SwarmTraceRepository(this.db);
      this.pendingApprovalRepo = new PendingApprovalRepository(this.db);

      const crashedSessions = this.sessionRepo.markCrashedActiveSessions(Date.now());
      if (crashedSessions.interrupted > 0 || crashedSessions.orphaned > 0) {
        logger.warn(`[DatabaseService] Marked crashed active sessions: ${crashedSessions.interrupted} interrupted, ${crashedSessions.orphaned} orphaned`);
      }

      // 首次升级后：从已有 messages 表 backfill episodic FTS 索引（幂等）
      this.sessionRepo.backfillSessionMessagesFts();
    } catch (err) {
      // 初始化失败时回退状态，避免 this.db 已赋值但 Repository 未初始化
      logger.error('Database initialization failed, resetting state:', err);
      if (this.db) {
        try {
          this.db.close();
        } catch (closeErr) {
          logger.warn('[DatabaseService] Failed to close database during cleanup:', closeErr);
        }
      }
      this.db = null;
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Raw Database Access
  // --------------------------------------------------------------------------

  /**
   * 获取原始的 better-sqlite3 数据库实例
   * 仅用于需要直接执行 SQL 的特殊场景
   */
  getDb(): BetterSqlite3.Database | null {
    return this.db;
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  close(): void {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async dispose(): Promise<void> {
    this.close();
  }

  /**
   * 获取数据库统计信息
   */
  getStats(): {
    sessionCount: number;
    messageCount: number;
    toolExecutionCount: number;
    knowledgeCount: number;
  } {
    if (!this.db) throw new Error('Database not initialized');

    const sessionRow = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as Record<string, unknown>;
    const messageRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as Record<string, unknown>;
    const toolRow = this.db.prepare('SELECT COUNT(*) as c FROM tool_executions').get() as Record<string, unknown>;
    const knowledgeRow = this.db.prepare('SELECT COUNT(*) as c FROM project_knowledge').get() as Record<string, unknown>;

    return {
      sessionCount: sessionRow.c as number,
      messageCount: messageRow.c as number,
      toolExecutionCount: toolRow.c as number,
      knowledgeCount: knowledgeRow.c as number
    };
  }

  // ==========================================================================
  // Turn Snapshots — 调试快照（CLI ↔ Electron 共享同一张表）
  // ==========================================================================

  insertTurnSnapshot(input: { sessionId: string; turnId?: string | null; turnIndex: number; contextChunks?: unknown; tokenBreakdown?: unknown; createdAt?: number }): { id: string; createdAt: number; byteSize: number } {
    this.ensureDb();
    const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const createdAt = input.createdAt ?? Date.now();
    const contextJson = input.contextChunks ? JSON.stringify(input.contextChunks) : null;
    const tokenJson = input.tokenBreakdown ? JSON.stringify(input.tokenBreakdown) : null;
    const byteSize = (contextJson ? Buffer.byteLength(contextJson, 'utf8') : 0) + (tokenJson ? Buffer.byteLength(tokenJson, 'utf8') : 0);
    this.db!.prepare(
      `INSERT INTO turn_snapshots (id, session_id, turn_id, turn_index, context_chunks, token_breakdown, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.sessionId, input.turnId ?? null, input.turnIndex, contextJson, tokenJson, byteSize, createdAt);
    return { id, createdAt, byteSize };
  }

  getSnapshotStats(): {
    snapshotCount: number;
    sessionCount: number;
    totalBytes: number;
  } {
    this.ensureDb();
    const row = this.db!.prepare(`SELECT COUNT(*) AS c, COUNT(DISTINCT session_id) AS sc, COALESCE(SUM(byte_size), 0) AS bytes FROM turn_snapshots`).get() as { c: number; sc: number; bytes: number } | undefined;
    return {
      snapshotCount: row?.c ?? 0,
      sessionCount: row?.sc ?? 0,
      totalBytes: row?.bytes ?? 0
    };
  }

  clearSnapshots(opts: { olderThanMs?: number; sessionId?: string } = {}): number {
    this.ensureDb();
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
    const result = this.db!.prepare(`DELETE FROM turn_snapshots ${where}`).run(...params);
    return result.changes;
  }

  // -- Compaction Snapshots --
  insertCompactionSnapshot(input: { sessionId: string; strategy?: string | null; preMessageCount: number; postMessageCount: number; preTokens: number; postTokens: number; savedTokens: number; usagePercent?: number | null; preMessagesSummary?: unknown; postMessagesSummary?: unknown; createdAt?: number }): { id: string; createdAt: number; byteSize: number } {
    this.ensureDb();
    const id = `compact_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const createdAt = input.createdAt ?? Date.now();
    const preJson = input.preMessagesSummary ? JSON.stringify(input.preMessagesSummary) : null;
    const postJson = input.postMessagesSummary ? JSON.stringify(input.postMessagesSummary) : null;
    const byteSize = (preJson ? Buffer.byteLength(preJson, 'utf8') : 0) + (postJson ? Buffer.byteLength(postJson, 'utf8') : 0);
    this.db!.prepare(
      `INSERT INTO compaction_snapshots (id, session_id, strategy, pre_message_count, post_message_count, pre_tokens, post_tokens, saved_tokens, usage_percent, pre_messages_summary, post_messages_summary, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.sessionId, input.strategy ?? null, input.preMessageCount, input.postMessageCount, input.preTokens, input.postTokens, input.savedTokens, input.usagePercent ?? null, preJson, postJson, byteSize, createdAt);
    return { id, createdAt, byteSize };
  }

  getCompactionStats(): {
    snapshotCount: number;
    sessionCount: number;
    totalBytes: number;
  } {
    this.ensureDb();
    const row = this.db!.prepare(`SELECT COUNT(*) AS c, COUNT(DISTINCT session_id) AS sc, COALESCE(SUM(byte_size), 0) AS bytes FROM compaction_snapshots`).get() as { c: number; sc: number; bytes: number } | undefined;
    return {
      snapshotCount: row?.c ?? 0,
      sessionCount: row?.sc ?? 0,
      totalBytes: row?.bytes ?? 0
    };
  }

  clearCompactionSnapshots(opts: { olderThanMs?: number; sessionId?: string } = {}): number {
    this.ensureDb();
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
    const result = this.db!.prepare(`DELETE FROM compaction_snapshots ${where}`).run(...params);
    return result.changes;
  }

  listTurnSnapshots(
    sessionId: string,
    limit: number = 100
  ): Array<{
    id: string;
    sessionId: string;
    turnId: string | null;
    turnIndex: number;
    contextChunks: unknown;
    tokenBreakdown: unknown;
    byteSize: number;
    createdAt: number;
  }> {
    this.ensureDb();
    const rows = this.db!.prepare(`SELECT * FROM turn_snapshots WHERE session_id = ? ORDER BY turn_index ASC, created_at ASC LIMIT ?`).all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      turnId: row.turn_id == null ? null : String(row.turn_id),
      turnIndex: Number(row.turn_index ?? 0),
      contextChunks: parseJsonValue(row.context_chunks),
      tokenBreakdown: parseJsonValue(row.token_breakdown),
      byteSize: Number(row.byte_size ?? 0),
      createdAt: Number(row.created_at ?? 0)
    }));
  }

  // ==========================================================================
  // Facade Methods — 委托给 Repository
  // ==========================================================================

  private _ensureDbWarned = false;
  private ensureDb(): void {
    if (!this.db) {
      if (!this._ensureDbWarned) {
        this._ensureDbWarned = true;
        logger.warn('Database not initialized — DB operations will be skipped. ' + (this._retryCount < this.MAX_RETRIES ? `Auto-retry in progress (${this._retryCount}/${this.MAX_RETRIES}).` : 'All retries exhausted. Restart the app to recover.'));
      }
      throw new Error('Database not initialized');
    }
    // DB 恢复后重置警告标记
    if (this._ensureDbWarned) {
      this._ensureDbWarned = false;
      logger.info('Database connection restored — operations resumed');
    }
  }

  // --- SessionRepository ---
  createSession(session: Session): void {
    this.ensureDb();
    this.sessionRepo.createSession(session);
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
    options?: { syncOrigin?: 'local' | 'remote' }
  ): void {
    this.ensureDb();
    this.sessionRepo.createSessionWithId(id, data, options);
  }
  getSession(sessionId: string, options?: { includeDeleted?: boolean }): import('./repositories').StoredSession | null {
    this.ensureDb();
    return this.sessionRepo.getSession(sessionId, options);
  }
  listSessions(limit: number = 50, offset: number = 0, includeArchived: boolean = false): import('./repositories').StoredSession[] {
    this.ensureDb();
    return this.sessionRepo.listSessions(limit, offset, includeArchived);
  }
  updateSession(sessionId: string, updates: Partial<Session>, options?: { syncOrigin?: 'local' | 'remote'; isDeleted?: boolean }): void {
    this.ensureDb();
    this.sessionRepo.updateSession(sessionId, updates, options);
  }
  deleteSession(sessionId: string, options?: { syncOrigin?: 'local' | 'remote'; deletedAt?: number }): void {
    this.ensureDb();
    this.sessionRepo.deleteSession(sessionId, options);
  }
  updateSessionPlanTitle(sessionId: string, planTitle: string | null, updatedAt?: number): void {
    this.ensureDb();
    this.sessionRepo.updateSessionPlanTitle(sessionId, planTitle, updatedAt);
  }
  getSessionPlanTitle(sessionId: string): string | null {
    this.ensureDb();
    return this.sessionRepo.getSessionPlanTitle(sessionId);
  }
  clearAllSessions(): number {
    this.ensureDb();
    return this.sessionRepo.clearAllSessions();
  }
  markCrashedActiveSessions(now?: number): {
    interrupted: number;
    orphaned: number;
  } {
    this.ensureDb();
    return this.sessionRepo.markCrashedActiveSessions(now);
  }
  clearAllMessages(): number {
    this.ensureDb();
    return this.sessionRepo.clearAllMessages();
  }
  hasMessages(sessionId: string): boolean {
    this.ensureDb();
    return this.sessionRepo.hasMessages(sessionId);
  }
  getLocalCacheStats(): { sessionCount: number; messageCount: number } {
    this.ensureDb();
    return this.sessionRepo.getLocalCacheStats();
  }
  addMessage(
    sessionId: string,
    message: Message,
    options?: {
      skipTimestampUpdate?: boolean;
      syncOrigin?: 'local' | 'remote';
      syncedAt?: number | null;
    }
  ): void {
    this.ensureDb();
    this.sessionRepo.addMessage(sessionId, message, options);
  }
  replaceMessages(sessionId: string, messages: Message[], updatedAt?: number): void {
    this.ensureDb();
    this.sessionRepo.replaceMessages(sessionId, messages, updatedAt);
  }
  updateMessage(messageId: string, updates: Partial<Message>): void {
    this.ensureDb();
    this.sessionRepo.updateMessage(messageId, updates);
  }
  getMessages(sessionId: string, limit?: number, offset?: number, options?: { includeRewound?: boolean }): Message[] {
    this.ensureDb();
    return this.sessionRepo.getMessages(sessionId, limit, offset, options);
  }
  getMessageCount(sessionId: string, options?: { includeRewound?: boolean }): number {
    this.ensureDb();
    return this.sessionRepo.getMessageCount(sessionId, options);
  }
  getRecentMessages(sessionId: string, count: number, options?: { includeRewound?: boolean }): Message[] {
    this.ensureDb();
    return this.sessionRepo.getRecentMessages(sessionId, count, options);
  }
  getMessagesBefore(sessionId: string, beforeTimestamp: number, limit: number = 30, options?: { includeRewound?: boolean }): Message[] {
    this.ensureDb();
    return this.sessionRepo.getMessagesBefore(sessionId, beforeTimestamp, limit, options);
  }
  getMessageById(sessionId: string, messageId: string, options?: { includeRewound?: boolean }): Message | null {
    this.ensureDb();
    return this.sessionRepo.getMessageById(sessionId, messageId, options);
  }
  applyPromptRewind(sessionId: string, userMessageId: string, record?: import('./repositories/SessionRepository').PromptRewindRecordInput): import('./repositories/SessionRepository').PromptRewindResult {
    this.ensureDb();
    return this.sessionRepo.applyPromptRewind(sessionId, userMessageId, record);
  }
  getUnsyncedSessions(limit: number = 1000): import('./repositories').StoredSession[] {
    this.ensureDb();
    return this.sessionRepo.getUnsyncedSessions(limit);
  }
  markSessionsSynced(sessionIds: string[]): void {
    this.ensureDb();
    this.sessionRepo.markSessionsSynced(sessionIds);
  }
  getUnsyncedMessages(limit: number = 1000): Array<Message & { sessionId: string }> {
    this.ensureDb();
    return this.sessionRepo.getUnsyncedMessages(limit);
  }
  markMessagesSynced(messageIds: string[]): void {
    this.ensureDb();
    this.sessionRepo.markMessagesSynced(messageIds);
  }
  truncateMessagesAfter(sessionId: string, messageId: string): number {
    this.ensureDb();
    return this.sessionRepo.truncateMessagesAfter(sessionId, messageId);
  }
  saveTodos(sessionId: string, todos: TodoItem[], updatedAt?: number): void {
    this.ensureDb();
    this.sessionRepo.saveTodos(sessionId, todos, updatedAt);
  }
  getTodos(sessionId: string): TodoItem[] {
    this.ensureDb();
    return this.sessionRepo.getTodos(sessionId);
  }
  saveSessionTasks(sessionId: string, tasks: SessionTask[], updatedAt?: number): void {
    this.ensureDb();
    this.sessionRepo.saveSessionTasks(sessionId, tasks, updatedAt);
  }
  getSessionTasks(sessionId: string): SessionTask[] {
    this.ensureDb();
    return this.sessionRepo.getSessionTasks(sessionId);
  }
  saveContextIntervention(sessionId: string, agentId: string | null | undefined, messageId: string, action: ContextInterventionAction | null, updatedAt?: number): void {
    this.ensureDb();
    this.sessionRepo.saveContextIntervention(sessionId, agentId, messageId, action, updatedAt);
  }
  getContextInterventions(sessionId: string, agentId?: string | null): ContextInterventionSnapshot {
    this.ensureDb();
    return this.sessionRepo.getContextInterventions(sessionId, agentId);
  }
  saveSessionRuntimeState(
    sessionId: string,
    state: {
      compressionStateJson?: string | null;
      persistentSystemContext?: string[];
    },
    updatedAt?: number
  ): void {
    this.ensureDb();
    this.sessionRepo.saveSessionRuntimeState(sessionId, state, updatedAt);
  }
  getSessionRuntimeState(sessionId: string): {
    compressionStateJson: string | null;
    persistentSystemContext: string[];
  } | null {
    this.ensureDb();
    return this.sessionRepo.getSessionRuntimeState(sessionId);
  }
  listArchivedSessions(limit: number = 50, offset: number = 0): import('./repositories').StoredSession[] {
    this.ensureDb();
    return this.sessionRepo.listArchivedSessions(limit, offset);
  }
  archiveSession(sessionId: string): import('./repositories').StoredSession | null {
    this.ensureDb();
    return this.sessionRepo.archiveSession(sessionId);
  }
  unarchiveSession(sessionId: string): import('./repositories').StoredSession | null {
    this.ensureDb();
    return this.sessionRepo.unarchiveSession(sessionId);
  }
  searchSessionMessagesFts(
    query: string,
    options?: { limit?: number; sessionId?: string; includeRewound?: boolean }
  ): Array<{
    messageId: string;
    sessionId: string;
    role: string;
    content: string;
    timestamp: number;
  }> {
    this.ensureDb();
    return this.sessionRepo.searchSessionMessagesFts(query, options);
  }

  // --- MemoryRepository ---
  createMemory(data: Omit<import('./repositories').MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): import('./repositories').MemoryRecord {
    this.ensureDb();
    return this.memoryRepo.createMemory(data);
  }
  getMemory(id: string): import('./repositories').MemoryRecord | null {
    this.ensureDb();
    return this.memoryRepo.getMemory(id);
  }
  listMemories(options?: { type?: string; category?: string; source?: string; projectPath?: string; sessionId?: string; limit?: number; offset?: number; orderBy?: string; orderDir?: 'ASC' | 'DESC' }): import('./repositories').MemoryRecord[] {
    this.ensureDb();
    return this.memoryRepo.listMemories(options);
  }
  updateMemory(id: string, updates: Partial<import('./repositories').MemoryRecord>): import('./repositories').MemoryRecord | null {
    this.ensureDb();
    return this.memoryRepo.updateMemory(id, updates);
  }
  deleteMemory(id: string): boolean {
    this.ensureDb();
    return this.memoryRepo.deleteMemory(id);
  }
  deleteMemories(filter: { type?: string; category?: string; source?: string; projectPath?: string; sessionId?: string }): number {
    this.ensureDb();
    return this.memoryRepo.deleteMemories(filter);
  }
  searchMemories(
    query: string,
    options?: {
      type?: string;
      category?: string;
      limit?: number;
      applyDecay?: boolean;
    }
  ): import('./repositories').MemoryRecord[] {
    this.ensureDb();
    return this.memoryRepo.searchMemories(query, options);
  }
  getMemoryStats(): {
    total: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
    byCategory: Record<string, number>;
  } {
    this.ensureDb();
    return this.memoryRepo.getMemoryStats();
  }
  recordMemoryAccess(id: string): void {
    this.ensureDb();
    this.memoryRepo.recordMemoryAccess(id);
  }
  addRelation(params: { sourceId: string; targetId: string; relationType: 'calls' | 'imports' | 'similar_to' | 'solves' | 'depends_on' | 'modifies' | 'references'; confidence: number; evidence: string; sessionId: string }): void {
    if (!this.db) return;
    this.memoryRepo.addRelation(params);
  }
  getRelationsFor(entityId: string, direction?: 'source' | 'target' | 'both', options?: import('./repositories').RelationQueryOptions): import('./repositories').EntityRelation[] {
    if (!this.db) return [];
    return this.memoryRepo.getRelationsFor(entityId, direction, options);
  }
  updateRelationConfidence(id: string, confidence: number, evidence?: string): void {
    if (!this.db) return;
    this.memoryRepo.updateRelationConfidence(id, confidence, evidence);
  }

  // --- ConfigRepository ---
  setPreference(key: string, value: unknown): void {
    this.ensureDb();
    this.configRepo.setPreference(key, value);
  }
  getPreference<T>(key: string, defaultValue?: T): T | undefined {
    this.ensureDb();
    return this.configRepo.getPreference(key, defaultValue);
  }
  getAllPreferences(): Record<string, unknown> {
    this.ensureDb();
    return this.configRepo.getAllPreferences();
  }
  deletePreference(key: string): boolean {
    this.ensureDb();
    return this.configRepo.deletePreference(key);
  }
  saveProjectKnowledge(projectPath: string, key: string, value: unknown, source?: 'learned' | 'explicit' | 'inferred', confidence?: number): void {
    this.ensureDb();
    this.configRepo.saveProjectKnowledge(projectPath, key, value, source, confidence);
  }
  getProjectKnowledge(projectPath: string, key?: string): import('./repositories').ProjectKnowledge[] {
    this.ensureDb();
    return this.configRepo.getProjectKnowledge(projectPath, key);
  }
  getAllProjectKnowledge(): import('./repositories').ProjectKnowledge[] {
    this.ensureDb();
    return this.configRepo.getAllProjectKnowledge();
  }
  updateProjectKnowledge(id: string, content: string): boolean {
    this.ensureDb();
    return this.configRepo.updateProjectKnowledge(id, content);
  }
  deleteProjectKnowledge(id: string): boolean {
    this.ensureDb();
    return this.configRepo.deleteProjectKnowledge(id);
  }
  deleteProjectKnowledgeBySource(source: string): number {
    this.ensureDb();
    return this.configRepo.deleteProjectKnowledgeBySource(source);
  }
  logAuditEvent(eventType: string, eventData: Record<string, unknown>, sessionId?: string): void {
    this.ensureDb();
    this.configRepo.logAuditEvent(eventType, eventData, sessionId);
  }
  getAuditLog(options?: { sessionId?: string; eventType?: string; limit?: number; since?: number }): Array<{
    id: number;
    sessionId: string | null;
    eventType: string;
    eventData: Record<string, unknown>;
    createdAt: number;
  }> {
    this.ensureDb();
    return this.configRepo.getAuditLog(options);
  }
  saveToolExecution(sessionId: string, messageId: string | null, toolName: string, args: Record<string, unknown>, result: ToolResult, ttlMs?: number): void {
    this.ensureDb();
    this.configRepo.saveToolExecution(sessionId, messageId, toolName, args, result, ttlMs);
  }
  getCachedToolResult(toolName: string, args: Record<string, unknown>): ToolResult | null {
    this.ensureDb();
    return this.configRepo.getCachedToolResult(toolName, args);
  }
  cleanExpiredCache(): number {
    this.ensureDb();
    return this.configRepo.cleanExpiredCache();
  }
  clearToolCache(): number {
    this.ensureDb();
    return this.configRepo.clearToolCache();
  }
  getToolCacheCount(): number {
    this.ensureDb();
    return this.configRepo.getToolCacheCount();
  }

  // --- CaptureRepository ---
  createCapture(item: CaptureItem): void {
    this.ensureDb();
    this.captureRepo.createCapture(item);
  }
  listCaptures(opts?: { source?: CaptureSource; limit?: number; offset?: number }): CaptureItem[] {
    this.ensureDb();
    return this.captureRepo.listCaptures(opts);
  }
  getCapture(id: string): CaptureItem | undefined {
    this.ensureDb();
    return this.captureRepo.getCapture(id);
  }
  deleteCapture(id: string): boolean {
    this.ensureDb();
    return this.captureRepo.deleteCapture(id);
  }
  getCaptureStats(): CaptureStats {
    this.ensureDb();
    return this.captureRepo.getCaptureStats();
  }
  searchCaptures(query: string, limit?: number): CaptureItem[] {
    this.ensureDb();
    return this.captureRepo.searchCaptures(query, limit);
  }

  // --- ExperimentRepository ---
  insertExperiment(experiment: { id: string; name: string; timestamp: number; model?: string; provider?: string; scope?: string; config_json?: string; summary_json: string; source?: string; git_commit?: string }): void {
    this.ensureDb();
    this.experimentRepo.insertExperiment(experiment);
  }
  insertExperimentCases(
    experimentId: string,
    cases: Array<{
      id: string;
      case_id: string;
      session_id?: string;
      status: string;
      score: number;
      duration_ms?: number;
      data_json?: string;
    }>
  ): void {
    this.ensureDb();
    this.experimentRepo.insertExperimentCases(experimentId, cases);
  }
  listExperiments(limit?: number): Array<{
    id: string;
    name: string;
    timestamp: number;
    model: string | null;
    provider: string | null;
    scope: string;
    config_json: string | null;
    summary_json: string;
    source: string;
    git_commit: string | null;
  }> {
    this.ensureDb();
    return this.experimentRepo.listExperiments(limit);
  }
  loadExperiment(id: string):
    | {
        experiment: {
          id: string;
          name: string;
          timestamp: number;
          model: string | null;
          provider: string | null;
          scope: string;
          config_json: string | null;
          summary_json: string;
          source: string;
          git_commit: string | null;
        };
        cases: Array<{
          id: string;
          experiment_id: string;
          case_id: string;
          session_id: string | null;
          status: string;
          score: number;
          duration_ms: number | null;
          data_json: string | null;
        }>;
      }
    | undefined {
    this.ensureDb();
    return this.experimentRepo.loadExperiment(id);
  }
  updateExperimentSummary(id: string, summaryJson: string): void {
    this.ensureDb();
    this.experimentRepo.updateExperimentSummary(id, summaryJson);
  }
  deleteExperiment(id: string): boolean {
    this.ensureDb();
    return this.experimentRepo.deleteExperiment(id);
  }

  // --- SwarmTraceRepository ---
  /**
   * 暴露 swarm trace 仓库给 SwarmTraceWriter / IPC handler 直接使用。
   * 与 experiment / capture 不同，trace 写入路径调用密度高且字段繁多，
   * 不再为每个方法包一层薄门面。
   */
  getSwarmTraceRepo(): SwarmTraceRepository {
    this.ensureDb();
    return this.swarmTraceRepo;
  }

  // --- PendingApprovalRepository ---
  /**
   * 暴露 pending_approvals 仓库给 PlanApprovalGate / SwarmLaunchApprovalGate
   * 用于 fire-and-forget 写入和启动 hydrate（ADR-010 #2）。
   */
  getPendingApprovalRepo(): PendingApprovalRepository {
    this.ensureDb();
    return this.pendingApprovalRepo;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let dbInstance: DatabaseService | null = null;

export function getDatabase(): DatabaseService {
  if (!dbInstance) {
    dbInstance = new DatabaseService();
    getServiceRegistry().register('DatabaseService', dbInstance);
  }
  return dbInstance;
}

export async function initDatabase(): Promise<DatabaseService> {
  const db = getDatabase();
  await db.initialize();
  return db;
}
