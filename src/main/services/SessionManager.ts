// ============================================================================
// Session Manager - 会话管理和恢复（中期记忆）
// ============================================================================

import { getDatabase, type StoredSession } from './DatabaseService';
import { getToolCache } from './ToolCache';
import type {
  Session,
  Message,
  GenerationId,
  ModelConfig,
  TodoItem,
} from '../../shared/types';

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
      id: `session_${now}_${Math.random().toString(36).substr(2, 9)}`,
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
   */
  async getSession(sessionId: string): Promise<SessionWithMessages | null> {
    // 检查缓存
    if (this.sessionCache.has(sessionId)) {
      return this.sessionCache.get(sessionId)!;
    }

    const db = getDatabase();
    const storedSession = db.getSession(sessionId);
    if (!storedSession) return null;

    const messages = db.getMessages(sessionId);
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
   * 列出所有会话
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

    return sessions;
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

    // 记录审计日志
    db.logAuditEvent('session_updated', { sessionId, updates }, sessionId);
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
    if (session.title.startsWith('Session ') && session.messageCount <= 1) {
      // 从第一条消息提取标题（取前 50 个字符）
      let title = firstMessage.trim().slice(0, 50);
      if (firstMessage.length > 50) {
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
    const newId = `session_${now}_${Math.random().toString(36).substr(2, 9)}`;

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
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
