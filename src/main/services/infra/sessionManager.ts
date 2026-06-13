// ============================================================================
// Session Manager - 会话管理和恢复（中期记忆）
// 支持云端优先的渐进加载策略
// ============================================================================

import { BrowserWindow } from '../../platform';
import { getDatabase, type StoredSession } from '../core';
import { getToolCache } from './toolCache';
import { getAuthService } from '../auth/authService';
import { getSupabase, isSupabaseInitialized } from './supabaseService';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type { Session, Message, ModelConfig, TodoItem } from '../../../shared/contract';
import { normalizeAgentEngineSession } from '../../../shared/contract/agentEngine';
import { stripAppshotBlocks } from '../../../shared/contract/appshot';
import { deriveSessionWorkbenchSnapshot, toSessionWorkbenchProvenance } from '../../../shared/contract/sessionWorkspace';
import { createLogger } from './logger';

import { Disposable, getServiceRegistry } from '../serviceRegistry';
const logger = createLogger('SessionManager');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SessionWithMessages extends Session {
  messages: Message[];
  todos: TodoItem[];
  messageCount: number;
  turnCount?: number;
}

function isVisibleHistoryMessage(message: Message): boolean {
  return !message.isMeta && message.visibility !== 'rewound';
}

export interface SessionCreateOptions {
  title?: string;
  modelConfig: ModelConfig;
  workingDirectory?: string;
  type?: Session['type'];
  origin?: Session['origin'];
  parentSessionId?: string;
  sourceRunId?: string;
  engine?: Session['engine'];
  readOnly?: boolean;
  retryOfSessionId?: string;
  userId?: string | null;
}

export interface SessionListOptions {
  limit?: number;
  offset?: number;
  searchQuery?: string;
  includeArchived?: boolean;
}

interface TelemetryUserPromptRow {
  id: string;
  user_prompt: string;
  start_time: number | string;
}

interface ExistingUserMessageRow {
  content: string;
}

// SessionRepository 持久化只存 provider+model（apiKey 不入库）；剥离后让
// SessionManager 返回的内存 session 与 DB 读回（fromRow）语义一致，避免
// res.json(session) 在 webServer 路径把 apiKey 透传给客户端。
function sanitizeModelConfigForSession(config: ModelConfig): ModelConfig {
  const { apiKey: _omitted, ...rest } = config;
  void _omitted;
  return rest;
}

// ----------------------------------------------------------------------------
// Session Manager
// ----------------------------------------------------------------------------

export class SessionManager implements Disposable {
  async dispose(): Promise<void> {
    this.sessionCache.clear();
    this.currentSessionId = null;
  }

  private static readonly MAX_CACHE_SIZE = 50;
  private currentSessionId: string | null = null;
  private sessionCache: Map<string, SessionWithMessages> = new Map();

  private buildWorkbenchSnapshot(session: Pick<Session, 'workingDirectory' | 'workbenchProvenance'>, messages: Message[]) {
    return deriveSessionWorkbenchSnapshot(messages.filter(isVisibleHistoryMessage), {
      workingDirectory: session.workingDirectory ?? null,
      provenance: session.workbenchProvenance
    });
  }

  private normalizePromptForBackfill(content: string): string {
    return content.replace(/\r\n/g, '\n').trim();
  }

  private backfillMissingTelemetryUserPrompts(sessionId: string): number {
    const db = getDatabase();
    const rawDb = db.getDb();
    if (!rawDb) return 0;

    try {
      const telemetryRows = rawDb
        .prepare(
          `
        SELECT id, user_prompt, start_time
        FROM telemetry_turns
        WHERE session_id = ?
          AND COALESCE(turn_type, 'user') = 'user'
          AND user_prompt IS NOT NULL
          AND TRIM(user_prompt) != ''
        ORDER BY start_time ASC, turn_number ASC, id ASC
      `
        )
        .all(sessionId) as TelemetryUserPromptRow[];

      if (telemetryRows.length === 0) return 0;

      const existingRows = rawDb
        .prepare(
          `
        SELECT content
        FROM messages
        WHERE session_id = ?
          AND role = 'user'
      `
        )
        .all(sessionId) as ExistingUserMessageRow[];

      const remainingExistingCounts = new Map<string, number>();
      for (const row of existingRows) {
        const key = this.normalizePromptForBackfill(row.content);
        remainingExistingCounts.set(key, (remainingExistingCounts.get(key) ?? 0) + 1);
      }

      let inserted = 0;
      for (const row of telemetryRows) {
        const content = row.user_prompt;
        const key = this.normalizePromptForBackfill(content);
        const existingCount = remainingExistingCounts.get(key) ?? 0;
        if (existingCount > 0) {
          remainingExistingCounts.set(key, existingCount - 1);
          continue;
        }

        const timestamp = Number(row.start_time);
        db.addMessage(
          sessionId,
          {
            id: `telemetry-user-${row.id}`,
            role: 'user',
            content,
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now()
          },
          { skipTimestampUpdate: true }
        );
        inserted++;
      }

      if (inserted > 0) {
        logger.info('Backfilled missing user prompts from telemetry', {
          sessionId,
          inserted
        });
      }

      return inserted;
    } catch (error) {
      logger.warn('Failed to backfill user prompts from telemetry', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return 0;
    }
  }

  private updateCachedWorkbenchState(session: SessionWithMessages): void {
    const visibleMessages = session.messages.filter(isVisibleHistoryMessage);
    session.messageCount = visibleMessages.length;
    session.turnCount = visibleMessages.filter((message) => message.role === 'user').length;
    session.workbenchSnapshot = this.buildWorkbenchSnapshot(session, session.messages);
  }

  private currentOwnerUserId(): string | null {
    return getAuthService().getCurrentUser()?.id ?? null;
  }

  private sessionMatchesOwner(session: Pick<Session, 'userId'>, userId: string | null): boolean {
    return userId === null ? session.userId == null : session.userId === userId;
  }

  private getAccessibleStoredSession(
    sessionId: string,
    options: { includeDeleted?: boolean } = {},
    userId: string | null = this.currentOwnerUserId()
  ): StoredSession | null {
    return getDatabase().getSession(sessionId, {
      ...options,
      userId
    });
  }

  private assertAccessibleSession(sessionId: string, userId: string | null = this.currentOwnerUserId()): StoredSession {
    const session = this.getAccessibleStoredSession(sessionId, {}, userId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return session;
  }

  private isDuplicateMessageError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('UNIQUE constraint failed: messages.id');
  }

  private maybePersistWorkbenchProvenance(sessionId: string, message: Message): Session['workbenchProvenance'] | undefined {
    const provenance = toSessionWorkbenchProvenance(message.metadata?.workbench, message.timestamp);
    if (!provenance) {
      return undefined;
    }

    const db = getDatabase();
    db.updateSession(sessionId, {
      workbenchProvenance: provenance,
      updatedAt: message.timestamp || Date.now()
    });
    return provenance;
  }

  private extractWorkbenchProvenance(messages: Message[]): Session['workbenchProvenance'] | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const provenance = toSessionWorkbenchProvenance(messages[i].metadata?.workbench, messages[i].timestamp);
      if (provenance) return provenance;
    }
    return undefined;
  }

  // --------------------------------------------------------------------------
  // Session CRUD
  // --------------------------------------------------------------------------

  /**
   * 创建新会话
   */
  async createSession(options: SessionCreateOptions): Promise<Session> {
    const db = getDatabase();
    const now = Date.now();

    // Detect git branch
    let gitBranch: string | undefined;
    if (options.workingDirectory) {
      try {
        const { execSync } = await import('child_process');
        gitBranch =
          execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: options.workingDirectory,
            timeout: 3000,
            encoding: 'utf-8'
          }).trim() || undefined;
      } catch {
        /* not a git repo or git not available */
      }
    }

    const session: Session = {
      id: `session_${now}_${crypto.randomUUID().split('-')[0]}`,
      userId: options.userId ?? getAuthService().getCurrentUser()?.id ?? null,
      title: options.title || this.generateSessionTitle(),
      modelConfig: sanitizeModelConfigForSession(options.modelConfig),
      workingDirectory: options.workingDirectory,
      type: options.type || 'chat',
      origin: options.origin,
      parentSessionId: options.parentSessionId,
      sourceRunId: options.sourceRunId,
      engine: normalizeAgentEngineSession(options.engine),
      memoryMode: 'auto',
      suppressedMemoryEntryIds: [],
      readOnly: options.readOnly,
      retryOfSessionId: options.retryOfSessionId,
      createdAt: now,
      updatedAt: now,
      gitBranch
    };

    db.createSession(session);

    // P0-2：按 workspace 隐式归桶到 project（拿/建 project + 写 project_id）。
    // 失败不阻塞会话创建（项目空间是增量能力）。
    try {
      const { getProjectService } = await import('../project/projectService');
      const project = await getProjectService().ensureProjectForWorkspace(session.workingDirectory, now);
      db.getProjectRepo().assignSessionProject(session.id, project.id);
      session.projectId = project.id;
    } catch (err) {
      logger.warn('[SessionManager] P0-2 项目归桶失败（不阻塞）:', err instanceof Error ? err.message : String(err));
    }

    // 初始化缓存条目，确保后续 addMessageToSession 能正确更新缓存
    this.sessionCache.set(session.id, {
      ...session,
      messages: [],
      todos: [],
      messageCount: 0,
      turnCount: 0,
      workbenchSnapshot: this.buildWorkbenchSnapshot(session, [])
    } as SessionWithMessages);

    // 记录审计日志
    db.logAuditEvent('session_created', { sessionId: session.id }, session.id);

    this.notifySessionListUpdated();

    return session;
  }

  /**
   * 获取会话（带消息）
   * 策略：懒加载 - 只加载最近 N 条消息，如果本地没有消息，从云端按需拉取
   * @param sessionId 会话 ID
   * @param messageLimit 加载的消息数量限制，默认 30 条（首轮响应优化）
   */
  async getSession(sessionId: string, messageLimit: number = 30): Promise<SessionWithMessages | null> {
    const db = getDatabase();
    const ownerId = this.currentOwnerUserId();

    // 检查缓存
    if (this.sessionCache.has(sessionId)) {
      const cached = this.sessionCache.get(sessionId)!;
      if (!this.sessionMatchesOwner(cached, ownerId)) {
        this.sessionCache.delete(sessionId);
      } else {
        const backfilled = this.backfillMissingTelemetryUserPrompts(sessionId);
        if (backfilled > 0) {
          const reloadLimit = Math.max(messageLimit, cached.messages.length + backfilled);
          cached.messages = db.getRecentMessages(sessionId, reloadLimit);
          cached.messageCount = db.getSession(sessionId, { userId: ownerId })?.messageCount ?? cached.messages.length;
          this.updateCachedWorkbenchState(cached);
        }
        return cached;
      }
    }

    let storedSession = db.getSession(sessionId, { userId: ownerId });
    if (!storedSession) return null;

    const backfilled = this.backfillMissingTelemetryUserPrompts(sessionId);
    if (backfilled > 0) {
      storedSession = db.getSession(sessionId, { userId: ownerId }) ?? storedSession;
    }

    // 懒加载：只加载最近 N 条消息（性能优化）
    let messages = db.getRecentMessages(sessionId, messageLimit);

    // 如果本地没有消息，尝试从云端拉取
    if (messages.length === 0) {
      const cloudMessages = await this.pullMessagesFromCloud(sessionId);
      if (cloudMessages.length > 0) {
        // 缓存到本地
        for (const msg of cloudMessages) {
          db.addMessage(sessionId, msg, {
            skipTimestampUpdate: true,
            syncOrigin: 'remote'
          });
        }
        // 云端拉取后从本地按 active 口径读取，避免 rewound 尝试重新进入上下文
        messages = db.getRecentMessages(sessionId, messageLimit);
      }
    }

    const todos = db.getTodos(sessionId);

    const sessionWithMessages: SessionWithMessages = {
      ...storedSession,
      messages,
      todos,
      workbenchSnapshot: this.buildWorkbenchSnapshot(storedSession, messages)
    };

    // 缓存（LRU: 超过上限时淘汰最早的条目）
    if (this.sessionCache.size >= SessionManager.MAX_CACHE_SIZE) {
      const oldestKey = this.sessionCache.keys().next().value;
      if (oldestKey) this.sessionCache.delete(oldestKey);
    }
    this.sessionCache.set(sessionId, sessionWithMessages);

    return sessionWithMessages;
  }

  /**
   * 从云端拉取会话消息
   */
  private async pullMessagesFromCloud(sessionId: string): Promise<Message[]> {
    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user || !isSupabaseInitialized()) return [];

    try {
      const supabase = getSupabase();
      const { data: cloudMessages, error } = await supabase.from('messages').select('*').eq('session_id', sessionId).eq('is_deleted', false).order('timestamp', { ascending: true });

      if (error) {
        logger.error('Pull messages error', { error });
        return [];
      }

      if (!cloudMessages || cloudMessages.length === 0) return [];

      // 定义云端消息的类型结构
      interface CloudMessage {
        id: string;
        role: string;
        content: string;
        timestamp: number;
        tool_calls?: string;
        tool_results?: string;
        visibility?: string;
        hidden_by_rewind_id?: string | null;
        hidden_at?: number | null;
      }

      // 转换为本地格式
      // role 从云端来是 string，需要断言为 MessageRole
      return (cloudMessages as CloudMessage[]).map(
        (m): Message => ({
          id: m.id,
          role: m.role as Message['role'],
          content: m.content,
          timestamp: m.timestamp,
          visibility: (m.visibility as Message['visibility']) || 'active',
          hiddenByRewindId: m.hidden_by_rewind_id || undefined,
          hiddenAt: m.hidden_at || undefined,
          toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
          toolResults: m.tool_results ? JSON.parse(m.tool_results) : undefined
        })
      );
    } catch (err) {
      logger.error('pullMessagesFromCloud error', err as Error);
      return [];
    }
  }

  /**
   * 列出所有会话
   * 策略：先返回本地缓存，后台同步云端列表
   */
  async listSessions(options: SessionListOptions = {}): Promise<StoredSession[]> {
    const db = getDatabase();
    const { limit = 50, offset = 0, includeArchived = false } = options;
    const ownerId = this.currentOwnerUserId();

    let sessions = db.listSessions(limit, offset, includeArchived, ownerId);

    // 搜索过滤
    if (options.searchQuery) {
      const query = options.searchQuery.toLowerCase();
      sessions = sessions.filter((s) => s.title.toLowerCase().includes(query) || s.workingDirectory?.toLowerCase().includes(query));
    }

    // 后台同步云端会话列表（不阻塞返回）
    this.syncSessionListFromCloud().catch((err) => {
      logger.error('Failed to sync session list from cloud', err);
    });

    return sessions.map((session) => {
      const cached = this.sessionCache.get(session.id);
      const ownerMatchedCached = cached && this.sessionMatchesOwner(cached, ownerId) ? cached : null;
      const recentMessages = ownerMatchedCached?.messages.length ? ownerMatchedCached.messages.slice(-12) : db.getRecentMessages(session.id, 12);

      return {
        ...session,
        workbenchSnapshot: this.buildWorkbenchSnapshot(ownerMatchedCached || session, recentMessages)
      };
    });
  }

  /**
   * 列出已归档的会话
   */
  async listArchivedSessions(limit: number = 50, offset: number = 0): Promise<StoredSession[]> {
    const db = getDatabase();
    return db.listArchivedSessions(limit, offset, this.currentOwnerUserId());
  }

  /**
   * 从云端同步会话列表（仅元数据）
   */
  private async syncSessionListFromCloud(): Promise<void> {
    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user || !isSupabaseInitialized()) return;

    try {
      const supabase = getSupabase();
      const { data: cloudSessions, error } = await supabase.from('sessions').select('id, title, model_provider, model_name, working_directory, created_at, updated_at, is_deleted').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(100);

      if (error) {
        logger.error('Cloud session list error', { error });
        return;
      }

      if (!cloudSessions || cloudSessions.length === 0) return;

      const db = getDatabase();
      let didMutate = false;

      // 定义云端会话结构
      interface CloudSession {
        id: string;
        title: string;
        model_provider: string;
        model_name: string;
        working_directory?: string;
        created_at: string | number;
        updated_at: number;
        is_deleted: boolean;
      }

      // 更新本地缓存（只更新元数据，不拉取消息）
      for (const cloudSession of cloudSessions as CloudSession[]) {
        const localSession = db.getSession(cloudSession.id, {
          includeDeleted: true,
          userId: user.id
        });

        if (cloudSession.is_deleted) {
          if (localSession && cloudSession.updated_at > localSession.updatedAt) {
            db.deleteSession(cloudSession.id, {
              deletedAt: cloudSession.updated_at,
              syncOrigin: 'remote'
            });
            this.sessionCache.delete(cloudSession.id);
          }
          continue;
        }

        if (!localSession) {
          // 本地不存在，创建会话元数据（消息稍后按需拉取）
          // model_provider 从云端来是 string，需要断言为 ModelProvider
          db.createSessionWithId(
            cloudSession.id,
            {
              title: cloudSession.title,
              userId: user.id,
              modelConfig: {
                provider: cloudSession.model_provider as ModelConfig['provider'],
                model: cloudSession.model_name
              },
              workingDirectory: cloudSession.working_directory,
              createdAt: cloudSession.created_at,
              updatedAt: cloudSession.updated_at
            },
            {
              syncOrigin: 'remote'
            }
          );
          didMutate = true;
        } else if (cloudSession.updated_at > localSession.updatedAt) {
          // 云端更新，更新本地元数据（保留云端原始时间戳）
          db.updateSession(
            cloudSession.id,
            {
              title: cloudSession.title,
              userId: localSession.userId ?? user.id,
              modelConfig: {
                provider: cloudSession.model_provider as ModelConfig['provider'],
                model: cloudSession.model_name
              },
              workingDirectory: cloudSession.working_directory,
              updatedAt: cloudSession.updated_at
            },
            {
              syncOrigin: 'remote',
              isDeleted: false
            }
          );
          // 清除缓存，避免返回过期数据
          this.sessionCache.delete(cloudSession.id);
          didMutate = true;
        }
      }

      // 只有云端同步真的改动了本地会话元数据，才通知前端刷新列表。
      // 否则 renderer 的 loadSessions -> syncSessionListFromCloud -> list-updated
      // 会形成自激循环，把侧边栏“新会话”按钮一直打进 loading 态。
      if (didMutate) {
        this.notifySessionListUpdated();
      }
    } catch (err) {
      logger.error('syncSessionListFromCloud error', err as Error);
    }
  }

  /**
   * 通知前端会话列表已更新
   */
  private notifySessionListUpdated(): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send(IPC_CHANNELS.SESSION_LIST_UPDATED);
    }
  }

  /**
   * 更新会话
   */
  async updateSession(sessionId: string, updates: Partial<Session>, options?: { allowEngineUpdate?: boolean }): Promise<void> {
    if (updates.engine !== undefined && !options?.allowEngineUpdate) {
      throw new Error('Agent Engine metadata must be changed through the Agent Engine selector.');
    }

    const db = getDatabase();
    const ownerId = this.currentOwnerUserId();
    this.assertAccessibleSession(sessionId, ownerId);
    db.updateSession(sessionId, updates);

    // 更新缓存
    if (this.sessionCache.has(sessionId)) {
      const cached = this.sessionCache.get(sessionId)!;
      Object.assign(cached, updates, {
        updatedAt: updates.updatedAt ?? Date.now()
      });
    }

    // 通知前端
    this.notifySessionUpdated(sessionId, updates);

    // 记录审计日志
    db.logAuditEvent('session_updated', { sessionId, updates }, sessionId);
  }

  /**
   * 通知前端会话已更新
   */
  private notifySessionUpdated(sessionId: string, updates: Partial<Session>): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send(IPC_CHANNELS.SESSION_UPDATED, {
        sessionId,
        updates
      });
    }
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<void> {
    const db = getDatabase();
    this.assertAccessibleSession(sessionId);
    db.deleteSession(sessionId);

    // 清除缓存
    this.sessionCache.delete(sessionId);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }

    // 通知前端
    this.notifySessionListUpdated();

    // 记录审计日志
    db.logAuditEvent('session_deleted', { sessionId });
  }

  /**
   * 归档会话
   */
  async archiveSession(sessionId: string): Promise<Session | null> {
    const db = getDatabase();
    const ownerId = this.currentOwnerUserId();
    this.assertAccessibleSession(sessionId, ownerId);

    // 归档会话
    db.archiveSession(sessionId);

    // 清除缓存
    this.sessionCache.delete(sessionId);

    // 通知前端
    this.notifySessionListUpdated();

    // 获取更新后的会话
    const session = db.getSession(sessionId, { userId: ownerId });

    // 记录审计日志
    db.logAuditEvent('session_archived', { sessionId }, sessionId);

    return session;
  }

  /**
   * 取消归档会话
   */
  async unarchiveSession(sessionId: string): Promise<Session | null> {
    const db = getDatabase();
    const ownerId = this.currentOwnerUserId();
    this.assertAccessibleSession(sessionId, ownerId);

    // 取消归档
    db.unarchiveSession(sessionId);

    // 清除缓存
    this.sessionCache.delete(sessionId);

    // 通知前端
    this.notifySessionListUpdated();

    // 获取更新后的会话
    const session = db.getSession(sessionId, { userId: ownerId });

    // 记录审计日志
    db.logAuditEvent('session_unarchived', { sessionId }, sessionId);

    return session;
  }

  // --------------------------------------------------------------------------
  // Current Session Management
  // --------------------------------------------------------------------------

  /**
   * 设置当前会话
   * 会自动结束前一个会话（异步生成摘要）
   */
  setCurrentSession(sessionId: string): void {
    // 旧版本会在这里异步调 endSession(previousSessionId) 生成摘要，
    // 但 Legacy summary generation 已经移除（见 endSession 内注释），
    // 残留的异步调用只会打误导性 log "Ending session, generating summary"
    // 还会与切会话期间的 zombie inference 在 currentSessionId 上 race。
    //
    // 切会话不取消正在运行的旧 session；本方法只负责更新当前 ID。
    this.currentSessionId = sessionId;

    // 设置工具缓存的 session
    const toolCache = getToolCache();
    toolCache.setSessionId(sessionId);
  }

  /**
   * 获取当前会话 ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * 获取当前会话
   */
  async getCurrentSession(): Promise<SessionWithMessages | null> {
    if (!this.currentSessionId) return null;
    return this.getSession(this.currentSessionId);
  }

  // --------------------------------------------------------------------------
  // Message Management
  // --------------------------------------------------------------------------

  /**
   * 添加消息到当前会话
   */
  async addMessage(message: Message): Promise<void> {
    if (!this.currentSessionId) {
      throw new Error('No current session');
    }

    await this.addMessageToSession(this.currentSessionId, message);

    // 自动更新会话标题（如果是第一条用户消息）
    // fire-and-forget：标题生成调用 quick model，不阻塞主推理链路
    if (isVisibleHistoryMessage(message) && message.role === 'user') {
      void this.maybeUpdateTitle(message.content).catch(() => {
        /* 静默降级 */
      });
    }
  }

  /**
   * 添加消息到指定会话（支持多会话并发）
   */
  async addMessageToSession(sessionId: string, message: Message): Promise<void> {
    const db = getDatabase();
    this.assertAccessibleSession(sessionId);
    let inserted = false;
    try {
      db.addMessage(sessionId, message);
      inserted = true;
    } catch (error) {
      if (!this.isDuplicateMessageError(error)) {
        throw error;
      }

      logger.debug('Message already exists; treating addMessageToSession as idempotent', {
        sessionId,
        messageId: message.id
      });
      db.updateMessage(message.id, message);
    }

    const provenance = this.maybePersistWorkbenchProvenance(sessionId, message);

    // 更新缓存
    if (this.sessionCache.has(sessionId)) {
      const cached = this.sessionCache.get(sessionId)!;
      const existingIndex = cached.messages.findIndex((cachedMessage) => cachedMessage.id === message.id);
      if (existingIndex >= 0) {
        cached.messages[existingIndex] = {
          ...cached.messages[existingIndex],
          ...message
        };
      } else {
        cached.messages.push(message);
        if (inserted && isVisibleHistoryMessage(message)) {
          cached.messageCount++;
        }
      }
      if (isVisibleHistoryMessage(message)) {
        cached.updatedAt = Date.now();
      }
      if (provenance) {
        cached.workbenchProvenance = provenance;
      }
      this.updateCachedWorkbenchState(cached);
    }

    // 第一条用户消息时自动生成会话标题（webServer 多会话路径走这里）
    if (inserted && isVisibleHistoryMessage(message) && message.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      void this.maybeUpdateTitleForSession(sessionId, message.content).catch(() => {
        /* 静默降级 */
      });
    }
  }

  /**
   * 更新消息
   */
  async updateMessage(messageId: string, updates: Partial<Message>): Promise<void> {
    const db = getDatabase();
    db.updateMessage(messageId, updates);

    // 更新缓存中的消息：多会话并发时，被更新的消息不一定属于 currentSessionId。
    for (const [cachedSessionId, cached] of this.sessionCache.entries()) {
      const msgIndex = cached.messages.findIndex((m) => m.id === messageId);
      if (msgIndex !== -1) {
        cached.messages[msgIndex] = {
          ...cached.messages[msgIndex],
          ...updates
        };
        const provenance = this.maybePersistWorkbenchProvenance(cachedSessionId, cached.messages[msgIndex]);
        if (provenance) {
          cached.workbenchProvenance = provenance;
        }
        this.updateCachedWorkbenchState(cached);
      }
    }
  }

  /**
   * 获取会话消息
   */
  async getMessages(sessionId: string, limit?: number, options?: { includeRewound?: boolean }): Promise<Message[]> {
    const db = getDatabase();
    if (!this.getAccessibleStoredSession(sessionId)) {
      return [];
    }
    return db.getMessages(sessionId, limit, undefined, options);
  }

  async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    const db = getDatabase();
    this.assertAccessibleSession(sessionId);
    db.replaceMessages(sessionId, messages);

    if (this.sessionCache.has(sessionId)) {
      const cached = this.sessionCache.get(sessionId)!;
      cached.messages = [...messages];
      cached.messageCount = messages.filter(isVisibleHistoryMessage).length;
      cached.updatedAt = Date.now();
      cached.workbenchProvenance = this.extractWorkbenchProvenance(messages);
      this.updateCachedWorkbenchState(cached);
    }
  }

  getSessionRuntimeState(sessionId: string): {
    compressionStateJson: string | null;
    persistentSystemContext: string[];
  } | null {
    const db = getDatabase();
    if (!this.getAccessibleStoredSession(sessionId)) {
      return null;
    }
    return db.getSessionRuntimeState(sessionId);
  }

  /**
   * 获取最近消息
   */
  async getRecentMessages(sessionId: string, count: number, options?: { includeRewound?: boolean }): Promise<Message[]> {
    const db = getDatabase();
    if (!this.getAccessibleStoredSession(sessionId)) {
      return [];
    }
    return db.getRecentMessages(sessionId, count, options);
  }

  /**
   * 加载更早的消息（分页）
   */
  async loadOlderMessages(sessionId: string, beforeTimestamp: number, limit: number = 30): Promise<{ messages: Message[]; hasMore: boolean }> {
    const db = getDatabase();
    if (!this.getAccessibleStoredSession(sessionId)) {
      return {
        messages: [],
        hasMore: false
      };
    }
    const messages = db.getMessagesBefore(sessionId, beforeTimestamp, limit);
    return {
      messages,
      hasMore: messages.length === limit
    };
  }

  async applyPromptRewind(sessionId: string, userMessageId: string, record?: Parameters<ReturnType<typeof getDatabase>['applyPromptRewind']>[2]): Promise<ReturnType<ReturnType<typeof getDatabase>['applyPromptRewind']>> {
    const db = getDatabase();
    this.assertAccessibleSession(sessionId);
    const result = db.applyPromptRewind(sessionId, userMessageId, record);

    this.sessionCache.delete(sessionId);
    const restored = await this.getSession(sessionId, Number.MAX_SAFE_INTEGER);
    if (restored) {
      restored.messages = result.activeMessages;
      restored.messageCount = result.activeMessages.filter(isVisibleHistoryMessage).length;
      restored.turnCount = result.activeMessages.filter((message) => isVisibleHistoryMessage(message) && message.role === 'user').length;
      restored.updatedAt = Date.now();
      restored.workbenchSnapshot = this.buildWorkbenchSnapshot(restored, result.activeMessages);
      this.sessionCache.set(sessionId, restored);
    }

    this.notifySessionUpdated(sessionId, {
      updatedAt: Date.now()
    });
    db.logAuditEvent(
      'prompt_rewound',
      {
        sessionId,
        rewindId: result.rewindId,
        anchorMessageId: userMessageId,
        hiddenMessageCount: result.hiddenMessageCount
      },
      sessionId
    );

    return result;
  }

  // --------------------------------------------------------------------------
  // Todo Management
  // --------------------------------------------------------------------------

  /**
   * 保存待办事项
   */
  async saveTodos(todos: TodoItem[]): Promise<void> {
    if (!this.currentSessionId) return;

    const db = getDatabase();
    if (!this.getAccessibleStoredSession(this.currentSessionId)) return;
    db.saveTodos(this.currentSessionId, todos);

    // 更新缓存
    if (this.sessionCache.has(this.currentSessionId)) {
      const cached = this.sessionCache.get(this.currentSessionId)!;
      cached.todos = todos;
    }
  }

  /**
   * 获取待办事项
   */
  async getTodos(sessionId: string): Promise<TodoItem[]> {
    const db = getDatabase();
    if (!this.getAccessibleStoredSession(sessionId)) {
      return [];
    }
    return db.getTodos(sessionId);
  }

  // --------------------------------------------------------------------------
  // Session Restoration
  // --------------------------------------------------------------------------

  /**
   * 恢复会话（加载消息和状态）
   *
   * restoreSession 必须强制从 DB 全量 reload messages，原因：
   * 1. getSession 默认只 load 最近 30 条（懒加载性能优化）
   * 2. sessionCache 一旦装入就 cache hit 直接返回，不会重新读 DB
   * 3. webServer 重启后 cache 是空的，但首次 load 走 getSession 默认 limit=30
   *
   * 这三层叠加导致：webServer 重启 → 用户继续对话 → LLM 拿到的 messages 只有最近 30 条
   * （甚至更少，如果走的 fresh load 路径），历史 tool result/assistant 输出全丢，
   * 模型像金鱼一样失忆。修法：清 cache + 全量 reload。
   */
  async restoreSession(sessionId: string): Promise<SessionWithMessages | null> {
    // 清缓存确保下面的 getSession 走 DB 全量路径
    this.sessionCache.delete(sessionId);
    const session = await this.getSession(sessionId, Number.MAX_SAFE_INTEGER);
    if (!session) return null;

    this.setCurrentSession(sessionId);

    // 记录审计日志
    const db = getDatabase();
    db.logAuditEvent('session_restored', { sessionId }, sessionId);

    return session;
  }

  /**
   * 结束会话（生成摘要用于 Smart Forking）
   * 在切换会话或关闭应用时调用
   */
  async endSession(sessionId?: string): Promise<void> {
    const targetSessionId = sessionId || this.currentSessionId;
    if (!targetSessionId) return;

    logger.info('Ending session, generating summary', {
      sessionId: targetSessionId
    });

    // Legacy summary generation and preference learning removed (memory module deleted)

    // 仅当调用方未指定 sessionId（即"结束当前会话"语义）时才清除 currentSessionId
    // 当从 setCurrentSession 传入明确 sessionId 时，调用方已设置了新的 currentSessionId，
    // 此处不应覆盖，防止快速切换 A→B→A 时 endSession(A) 延迟完成后误清
    if (!sessionId && targetSessionId === this.currentSessionId) {
      this.currentSessionId = null;
    }
  }

  /**
   * 获取最近的会话（用于自动恢复）
   */
  async getMostRecentSession(): Promise<StoredSession | null> {
    const sessions = await this.listSessions({ limit: 1 });
    return sessions[0] || null;
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  /**
   * 生成会话标题
   */
  private generateSessionTitle(): string {
    const now = new Date();
    return `Session ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
  }

  /**
   * 根据第一条消息自动更新标题
   */
  private async maybeUpdateTitle(firstMessage: string): Promise<void> {
    if (!this.currentSessionId) return;
    await this.maybeUpdateTitleForSession(this.currentSessionId, firstMessage);
  }

  /**
   * 多会话版本：根据指定 sessionId 的第一条用户消息生成标题。
   * webServer 走 addMessageToSession 时由该函数兜底（addMessage 单会话路径已经在上面挂过）。
   */
  private async maybeUpdateTitleForSession(sessionId: string, firstMessage: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    const isDefaultTitle = session.title === 'New Chat' || session.title === 'New Session' || session.title.startsWith('Session ') || session.title === '新对话';

    if (!(isDefaultTitle && session.messageCount <= 1)) return;

    const visibleMessage = stripAppshotBlocks(firstMessage);
    const titleSource = visibleMessage || (firstMessage.trim().startsWith('<appshot') ? 'Appshot 会话' : firstMessage);
    let title = await this.generateSmartTitle(titleSource);

    if (!title) {
      const firstLine = titleSource.trim().split('\n')[0] || 'Appshot 会话';
      title = firstLine.slice(0, 50);
      if (firstLine.length > 50) title += '...';
    }

    await this.updateSession(sessionId, { title });
  }

  /**
   * 使用小模型生成智能会话标题
   * 模型不可用时返回 null，由调用方降级处理
   */
  private async generateSmartTitle(message: string): Promise<string | null> {
    try {
      const { quickTask, isQuickModelAvailable } = await import('../../model/quickModel');
      if (!isQuickModelAvailable()) return null;

      // 截取前 500 字符避免 prompt 太长
      const truncated = message.length > 500 ? message.slice(0, 500) + '...' : message;

      const result = await quickTask(`为以下用户消息生成一个简短的会话标题（10-25字，中文优先，不加引号不加标点）：\n\n${truncated}`);

      if (result.success && result.content) {
        // 清理：去引号、去标点、限长
        let title = result.content
          .trim()
          .replace(/^["'「『]|["'」』]$/g, '')
          .replace(/[。！？.!?]$/g, '');
        if (title.length > 50) title = title.slice(0, 50) + '...';
        if (title.length >= 2) return title;
      }
      return null;
    } catch {
      return null; // 静默降级
    }
  }

  /**
   * 清除会话缓存
   */
  clearCache(): void {
    this.sessionCache.clear();
  }

  /**
   * 导出会话（用于分享或备份）
   */
  async exportSession(sessionId: string): Promise<SessionWithMessages | null> {
    return this.getSession(sessionId);
  }

  /**
   * 导入会话
   */
  async importSession(data: SessionWithMessages): Promise<string> {
    const db = getDatabase();
    const now = Date.now();

    // 创建新的 session ID
    const newId = `session_${now}_${crypto.randomUUID().split('-')[0]}`;

    const session: Session = {
      id: newId,
      userId: getAuthService().getCurrentUser()?.id ?? data.userId ?? null,
      title: data.title,
      modelConfig: sanitizeModelConfigForSession(data.modelConfig),
      workingDirectory: data.workingDirectory,
      type: data.type || 'chat',
      origin: data.origin,
      parentSessionId: data.parentSessionId,
      sourceRunId: data.sourceRunId,
      readOnly: data.readOnly,
      retryOfSessionId: data.retryOfSessionId,
      createdAt: now,
      updatedAt: now
    };

    db.createSession(session);

    // 导入消息
    for (const message of data.messages) {
      const newMessage: Message = {
        ...message,
        id: `msg_${Date.now()}_${crypto.randomUUID().split('-')[0]}`
      };
      db.addMessage(newId, newMessage);
    }

    // 导入 todos
    if (data.todos && data.todos.length > 0) {
      db.saveTodos(newId, data.todos);
    }

    // 记录审计日志
    db.logAuditEvent('session_imported', { newId, originalId: data.id }, newId);

    return newId;
  }

  /**
   * 合并会话（将一个会话的消息追加到另一个）
   */
  async mergeSessions(targetId: string, sourceId: string): Promise<void> {
    const db = getDatabase();
    this.assertAccessibleSession(targetId);
    this.assertAccessibleSession(sourceId);

    const sourceMessages = db.getMessages(sourceId);
    for (const message of sourceMessages) {
      const newMessage: Message = {
        ...message,
        id: `msg_${Date.now()}_${crypto.randomUUID().split('-')[0]}`
      };
      db.addMessage(targetId, newMessage);
    }

    // 清除缓存
    this.sessionCache.delete(targetId);

    // 记录审计日志
    db.logAuditEvent('sessions_merged', { targetId, sourceId, messagesMerged: sourceMessages.length }, targetId);
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let sessionManagerInstance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new SessionManager();
  }
  return sessionManagerInstance;
}

getServiceRegistry().register('SessionManager', getSessionManager());
