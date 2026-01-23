// ============================================================================
// Session Manager - 会话管理和恢复（中期记忆）
// 支持云端优先的渐进加载策略
// ============================================================================

import { BrowserWindow } from 'electron';
import { getDatabase, type StoredSession } from '../core';
import { getToolCache } from './toolCache';
import { getAuthService } from '../auth';
import { getSupabase, isSupabaseInitialized } from './supabaseService';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type {
  Session,
  Message,
  GenerationId,
  ModelConfig,
  TodoItem,
} from '../../../shared/types';
import { createLogger } from './logger';

const logger = createLogger('SessionManager');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SessionWithMessages extends Session {
  messages: Message[];
  todos: TodoItem[];
  messageCount: number;
}

export interface SessionCreateOptions {
  title?: string;
  generationId: GenerationId;
  modelConfig: ModelConfig;
  workingDirectory?: string;
}

export interface SessionListOptions {
  limit?: number;
  offset?: number;
  searchQuery?: string;
}

// ----------------------------------------------------------------------------
// Session Manager
// ----------------------------------------------------------------------------

export class SessionManager {
  private currentSessionId: string | null = null;
  private sessionCache: Map<string, SessionWithMessages> = new Map();

  // --------------------------------------------------------------------------
  // Session CRUD
  // --------------------------------------------------------------------------

  /**
   * 创建新会话
   */
  async createSession(options: SessionCreateOptions): Promise<Session> {
    const db = getDatabase();
    const now = Date.now();

    const session: Session = {
      id: `session_${now}_${crypto.randomUUID().split('-')[0]}`,
      title: options.title || this.generateSessionTitle(),
      generationId: options.generationId,
      modelConfig: options.modelConfig,
      workingDirectory: options.workingDirectory,
      createdAt: now,
      updatedAt: now,
    };

    db.createSession(session);

    // 记录审计日志
    db.logAuditEvent('session_created', { sessionId: session.id }, session.id);

    return session;
  }

  /**
   * 获取会话（带消息）
   * 策略：如果本地没有消息，从云端按需拉取
   */
  async getSession(sessionId: string): Promise<SessionWithMessages | null> {
    // 检查缓存
    if (this.sessionCache.has(sessionId)) {
      return this.sessionCache.get(sessionId)!;
    }

    const db = getDatabase();
    const storedSession = db.getSession(sessionId);
    if (!storedSession) return null;

    // 检查本地是否有消息缓存
    let messages = db.getMessages(sessionId);

    // 如果本地没有消息，尝试从云端拉取
    if (messages.length === 0) {
      const cloudMessages = await this.pullMessagesFromCloud(sessionId);
      if (cloudMessages.length > 0) {
        // 缓存到本地
        for (const msg of cloudMessages) {
          db.addMessage(sessionId, msg);
        }
        messages = cloudMessages;
      }
    }

    const todos = db.getTodos(sessionId);

    const sessionWithMessages: SessionWithMessages = {
      ...storedSession,
      messages,
      todos,
    };

    // 缓存
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
    const { limit = 50, offset = 0 } = options;

    let sessions = db.listSessions(limit, offset);

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

    return sessions;
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
        .select('id, title, generation_id, model_provider, model_name, working_directory, created_at, updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(100);

      if (error) {
        logger.error('Cloud session list error', { error });
        return;
      }

      if (!cloudSessions || cloudSessions.length === 0) return;

      const db = getDatabase();

      // 定义云端会话结构
      interface CloudSession {
        id: string;
        title: string;
        generation_id: GenerationId;
        model_provider: string;
        model_name: string;
        working_directory?: string;
        created_at: string;
        updated_at: number;
      }

      // 更新本地缓存（只更新元数据，不拉取消息）
      for (const cloudSession of cloudSessions as CloudSession[]) {
        const localSession = db.getSession(cloudSession.id);

        if (!localSession) {
          // 本地不存在，创建会话元数据（消息稍后按需拉取）
          // model_provider 从云端来是 string，需要断言为 ModelProvider
          db.createSessionWithId(cloudSession.id, {
            title: cloudSession.title,
            generationId: cloudSession.generation_id,
            modelConfig: {
              provider: cloudSession.model_provider as ModelConfig['provider'],
              model: cloudSession.model_name,
            },
            workingDirectory: cloudSession.working_directory,
          });
        } else if (cloudSession.updated_at > localSession.updatedAt) {
          // 云端更新，更新本地元数据
          db.updateSession(cloudSession.id, {
            title: cloudSession.title,
            generationId: cloudSession.generation_id,
            modelConfig: {
              provider: cloudSession.model_provider as ModelConfig['provider'],
              model: cloudSession.model_name,
            },
          });
        }
      }

      // 通知前端刷新会话列表
      this.notifySessionListUpdated();
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
      Object.assign(cached, updates, { updatedAt: Date.now() });
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

    // 记录审计日志
    db.logAuditEvent('session_deleted', { sessionId });
  }

  // --------------------------------------------------------------------------
  // Current Session Management
  // --------------------------------------------------------------------------

  /**
   * 设置当前会话
   */
  setCurrentSession(sessionId: string): void {
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

    const db = getDatabase();
    db.addMessage(this.currentSessionId, message);

    // 更新缓存
    if (this.sessionCache.has(this.currentSessionId)) {
      const cached = this.sessionCache.get(this.currentSessionId)!;
      cached.messages.push(message);
      cached.messageCount++;
      cached.updatedAt = Date.now();
    }

    // 自动更新会话标题（如果是第一条用户消息）
    if (message.role === 'user') {
      await this.maybeUpdateTitle(message.content);
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
      session.title.startsWith('Session ') ||
      session.title === '新对话';

    if (isDefaultTitle && session.messageCount <= 1) {
      // 从第一条消息提取标题
      // 去掉换行符，取第一行
      const firstLine = firstMessage.trim().split('\n')[0];
      let title = firstLine.slice(0, 50);
      if (firstLine.length > 50) {
        title += '...';
      }

      await this.updateSession(this.currentSessionId, { title });
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
      generationId: data.generationId,
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
