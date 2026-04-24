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
import type {
  Session,
  Message,
  ModelConfig,
  TodoItem,
} from '../../../shared/contract';
import {
  deriveSessionWorkbenchSnapshot,
  toSessionWorkbenchProvenance,
} from '../../../shared/contract/sessionWorkspace';
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

export interface SessionCreateOptions {
  title?: string;
  modelConfig: ModelConfig;
  workingDirectory?: string;
}

export interface SessionListOptions {
  limit?: number;
  offset?: number;
  searchQuery?: string;
  includeArchived?: boolean;
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
    return deriveSessionWorkbenchSnapshot(messages, {
      workingDirectory: session.workingDirectory ?? null,
      provenance: session.workbenchProvenance,
    });
  }

  private updateCachedWorkbenchState(session: SessionWithMessages): void {
    session.turnCount = session.messages.filter((message) => message.role === 'user').length;
    session.workbenchSnapshot = this.buildWorkbenchSnapshot(session, session.messages);
  }

  private maybePersistWorkbenchProvenance(sessionId: string, message: Message): Session['workbenchProvenance'] | undefined {
    const provenance = toSessionWorkbenchProvenance(message.metadata?.workbench, message.timestamp);
    if (!provenance) {
      return undefined;
    }

    const db = getDatabase();
    db.updateSession(sessionId, {
      workbenchProvenance: provenance,
      updatedAt: message.timestamp || Date.now(),
    });
    return provenance;
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
        gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: options.workingDirectory,
          timeout: 3000,
          encoding: 'utf-8',
        }).trim() || undefined;
      } catch { /* not a git repo or git not available */ }
    }

    const session: Session = {
      id: `session_${now}_${crypto.randomUUID().split('-')[0]}`,
      title: options.title || this.generateSessionTitle(),
      modelConfig: options.modelConfig,
      workingDirectory: options.workingDirectory,
      createdAt: now,
      updatedAt: now,
      gitBranch,
    };

    db.createSession(session);

    // 初始化缓存条目，确保后续 addMessageToSession 能正确更新缓存
    this.sessionCache.set(session.id, {
      ...session,
      messages: [],
      todos: [],
      messageCount: 0,
      turnCount: 0,
      workbenchSnapshot: this.buildWorkbenchSnapshot(session, []),
    } as SessionWithMessages);

    // 记录审计日志
    db.logAuditEvent('session_created', { sessionId: session.id }, session.id);

    return session;
  }

  /**
   * 获取会话（带消息）
   * 策略：懒加载 - 只加载最近 N 条消息，如果本地没有消息，从云端按需拉取
   * @param sessionId 会话 ID
   * @param messageLimit 加载的消息数量限制，默认 30 条（首轮响应优化）
   */
  async getSession(sessionId: string, messageLimit: number = 30): Promise<SessionWithMessages | null> {
    // 检查缓存
    if (this.sessionCache.has(sessionId)) {
      return this.sessionCache.get(sessionId)!;
    }

    const db = getDatabase();
    const storedSession = db.getSession(sessionId);
    if (!storedSession) return null;

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
            syncOrigin: 'remote',
          });
        }
        // 云端拉取后也只取最近 N 条
        messages = cloudMessages.slice(-messageLimit);
      }
    }

    const todos = db.getTodos(sessionId);

    const sessionWithMessages: SessionWithMessages = {
      ...storedSession,
      messages,
      todos,
      workbenchSnapshot: this.buildWorkbenchSnapshot(storedSession, messages),
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
      // TODO: Supabase 类型系统限制，需要 as any 绕过 PostgrestFilterBuilder 泛型约束
      const { data: cloudMessages, error } = await (supabase.from('messages') as any)
        .select('*')
        .eq('session_id', sessionId)
        .eq('is_deleted', false)
        .order('timestamp', { ascending: true });

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
      }

      // 转换为本地格式
      // role 从云端来是 string，需要断言为 MessageRole
      return (cloudMessages as CloudMessage[]).map((m): Message => ({
        id: m.id,
        role: m.role as Message['role'],
        content: m.content,
        timestamp: m.timestamp,
        toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
        toolResults: m.tool_results ? JSON.parse(m.tool_results) : undefined,
      }));
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

    let sessions = db.listSessions(limit, offset, includeArchived);

    // 搜索过滤
    if (options.searchQuery) {
      const query = options.searchQuery.toLowerCase();
      sessions = sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(query) ||
          s.workingDirectory?.toLowerCase().includes(query)
      );
    }

    // 后台同步云端会话列表（不阻塞返回）
    this.syncSessionListFromCloud().catch((err) => {
      logger.error('Failed to sync session list from cloud', err);
    });

    return sessions.map((session) => {
      const cached = this.sessionCache.get(session.id);
      const recentMessages = cached?.messages.length
        ? cached.messages.slice(-12)
        : db.getRecentMessages(session.id, 12);

      return {
        ...session,
        workbenchSnapshot: this.buildWorkbenchSnapshot(
          cached || session,
          recentMessages,
        ),
      };
    });
  }

  /**
   * 列出已归档的会话
   */
  async listArchivedSessions(limit: number = 50, offset: number = 0): Promise<StoredSession[]> {
    const db = getDatabase();
    return db.listArchivedSessions(limit, offset);
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
      // TODO: Supabase 类型系统限制，需要 as any 绕过 PostgrestFilterBuilder 泛型约束
      const { data: cloudSessions, error } = await (supabase.from('sessions') as any)
        .select('id, title, generation_id, model_provider, model_name, working_directory, created_at, updated_at, is_deleted')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(100);

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
        generation_id?: string;
        model_provider: string;
        model_name: string;
        working_directory?: string;
        created_at: string | number;
        updated_at: number;
        is_deleted: boolean;
      }

      // 更新本地缓存（只更新元数据，不拉取消息）
      for (const cloudSession of cloudSessions as CloudSession[]) {
        const localSession = db.getSession(cloudSession.id, { includeDeleted: true });

        if (cloudSession.is_deleted) {
          if (localSession && cloudSession.updated_at > localSession.updatedAt) {
            db.deleteSession(cloudSession.id, {
              deletedAt: cloudSession.updated_at,
              syncOrigin: 'remote',
            });
            this.sessionCache.delete(cloudSession.id);
          }
          continue;
        }

        if (!localSession) {
          // 本地不存在，创建会话元数据（消息稍后按需拉取）
          // model_provider 从云端来是 string，需要断言为 ModelProvider
          db.createSessionWithId(cloudSession.id, {
            title: cloudSession.title,
            modelConfig: {
              provider: cloudSession.model_provider as ModelConfig['provider'],
              model: cloudSession.model_name,
            },
            workingDirectory: cloudSession.working_directory,
            createdAt: cloudSession.created_at,
            updatedAt: cloudSession.updated_at,
          }, {
            syncOrigin: 'remote',
          });
          didMutate = true;
        } else if (cloudSession.updated_at > localSession.updatedAt) {
          // 云端更新，更新本地元数据（保留云端原始时间戳）
          db.updateSession(cloudSession.id, {
            title: cloudSession.title,
            modelConfig: {
              provider: cloudSession.model_provider as ModelConfig['provider'],
              model: cloudSession.model_name,
            },
            workingDirectory: cloudSession.working_directory,
            updatedAt: cloudSession.updated_at,
          }, {
            syncOrigin: 'remote',
            isDeleted: false,
          });
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
  async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
    const db = getDatabase();
    db.updateSession(sessionId, updates);

    // 更新缓存
    if (this.sessionCache.has(sessionId)) {
      const cached = this.sessionCache.get(sessionId)!;
      Object.assign(cached, updates, { updatedAt: updates.updatedAt ?? Date.now() });
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
      win.webContents.send(IPC_CHANNELS.SESSION_UPDATED, { sessionId, updates });
    }
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<void> {
    const db = getDatabase();
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

    // 归档会话
    db.archiveSession(sessionId);

    // 清除缓存
    this.sessionCache.delete(sessionId);

    // 通知前端
    this.notifySessionListUpdated();

    // 获取更新后的会话
    const session = db.getSession(sessionId);

    // 记录审计日志
    db.logAuditEvent('session_archived', { sessionId }, sessionId);

    return session;
  }

  /**
   * 取消归档会话
   */
  async unarchiveSession(sessionId: string): Promise<Session | null> {
    const db = getDatabase();

    // 取消归档
    db.unarchiveSession(sessionId);

    // 清除缓存
    this.sessionCache.delete(sessionId);

    // 通知前端
    this.notifySessionListUpdated();

    // 获取更新后的会话
    const session = db.getSession(sessionId);

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
    // 如果有前一个会话，异步结束它（不阻塞）
    if (this.currentSessionId && this.currentSessionId !== sessionId) {
      const previousSessionId = this.currentSessionId;
      // 异步生成摘要，不阻塞会话切换
      this.endSession(previousSessionId).catch((error) => {
        logger.error('Failed to end previous session', { error, previousSessionId });
      });
    }

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
    if (message.role === 'user') {
      void this.maybeUpdateTitle(message.content).catch(() => { /* 静默降级 */ });
    }
  }

  /**
   * 添加消息到指定会话（支持多会话并发）
   */
  async addMessageToSession(sessionId: string, message: Message): Promise<void> {
    const db = getDatabase();
    db.addMessage(sessionId, message);
    const provenance = this.maybePersistWorkbenchProvenance(sessionId, message);

    // 更新缓存
    if (this.sessionCache.has(sessionId)) {
      const cached = this.sessionCache.get(sessionId)!;
      cached.messages.push(message);
      cached.messageCount++;
      cached.updatedAt = Date.now();
      if (provenance) {
        cached.workbenchProvenance = provenance;
      }
      this.updateCachedWorkbenchState(cached);
    }
  }

  /**
   * 更新消息
   */
  async updateMessage(messageId: string, updates: Partial<Message>): Promise<void> {
    const db = getDatabase();
    db.updateMessage(messageId, updates);

    // 更新缓存中的消息
    if (this.currentSessionId && this.sessionCache.has(this.currentSessionId)) {
      const cached = this.sessionCache.get(this.currentSessionId)!;
      const msgIndex = cached.messages.findIndex((m) => m.id === messageId);
      if (msgIndex !== -1) {
        cached.messages[msgIndex] = { ...cached.messages[msgIndex], ...updates };
        const provenance = this.maybePersistWorkbenchProvenance(this.currentSessionId, cached.messages[msgIndex]);
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
  async getMessages(sessionId: string, limit?: number): Promise<Message[]> {
    const db = getDatabase();
    return db.getMessages(sessionId, limit);
  }

  /**
   * 获取最近消息
   */
  async getRecentMessages(sessionId: string, count: number): Promise<Message[]> {
    const db = getDatabase();
    return db.getRecentMessages(sessionId, count);
  }

  /**
   * 加载更早的消息（分页）
   */
  async loadOlderMessages(sessionId: string, beforeTimestamp: number, limit: number = 30): Promise<{ messages: Message[]; hasMore: boolean }> {
    const db = getDatabase();
    const messages = db.getMessagesBefore(sessionId, beforeTimestamp, limit);
    return {
      messages,
      hasMore: messages.length === limit,
    };
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
    return db.getTodos(sessionId);
  }

  // --------------------------------------------------------------------------
  // Session Restoration
  // --------------------------------------------------------------------------

  /**
   * 恢复会话（加载消息和状态）
   */
  async restoreSession(sessionId: string): Promise<SessionWithMessages | null> {
    const session = await this.getSession(sessionId);
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

    logger.info('Ending session, generating summary', { sessionId: targetSessionId });

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

    const session = await this.getSession(this.currentSessionId);
    if (!session) return;

    // 只在标题是默认标题时更新
    const isDefaultTitle =
      session.title === 'New Chat' ||
      session.title === 'New Session' ||
      session.title.startsWith('Session ') ||
      session.title === '新对话';

    if (!(isDefaultTitle && session.messageCount <= 1)) return;

    // 1. 尝试用小模型生成标题
    let title = await this.generateSmartTitle(firstMessage);

    // 2. 降级：截取前 50 字符
    if (!title) {
      const firstLine = firstMessage.trim().split('\n')[0];
      title = firstLine.slice(0, 50);
      if (firstLine.length > 50) title += '...';
    }

    await this.updateSession(this.currentSessionId, { title });
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

      const result = await quickTask(
        `为以下用户消息生成一个简短的会话标题（10-25字，中文优先，不加引号不加标点）：\n\n${truncated}`
      );

      if (result.success && result.content) {
        // 清理：去引号、去标点、限长
        let title = result.content.trim()
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
      title: data.title,
      modelConfig: data.modelConfig,
      workingDirectory: data.workingDirectory,
      createdAt: now,
      updatedAt: now,
    };

    db.createSession(session);

    // 导入消息
    for (const message of data.messages) {
      const newMessage: Message = {
        ...message,
        id: `msg_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
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

    const sourceMessages = db.getMessages(sourceId);
    for (const message of sourceMessages) {
      const newMessage: Message = {
        ...message,
        id: `msg_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
      };
      db.addMessage(targetId, newMessage);
    }

    // 清除缓存
    this.sessionCache.delete(targetId);

    // 记录审计日志
    db.logAuditEvent(
      'sessions_merged',
      { targetId, sourceId, messagesMerged: sourceMessages.length },
      targetId
    );
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
