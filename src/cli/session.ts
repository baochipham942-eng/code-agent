// ============================================================================
// CLI Session Manager - 独立于 Electron 的会话管理
// ============================================================================

import { getCLIDatabase, type StoredSession, type CLIDatabaseService } from './database';
import type {
  Session,
  Message,
  GenerationId,
  ModelConfig,
  TodoItem,
} from '../shared/types';
import crypto from 'crypto';

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

// ----------------------------------------------------------------------------
// CLI Session Manager
// ----------------------------------------------------------------------------

export class CLISessionManager {
  private currentSessionId: string | null = null;
  private sessionCache: Map<string, SessionWithMessages> = new Map();
  private db: CLIDatabaseService;

  constructor() {
    this.db = getCLIDatabase();
  }

  // --------------------------------------------------------------------------
  // Session CRUD
  // --------------------------------------------------------------------------

  /**
   * 创建新会话
   */
  async createSession(options: SessionCreateOptions): Promise<Session> {
    const now = Date.now();

    const session: Session = {
      id: `cli_session_${now}_${crypto.randomUUID().split('-')[0]}`,
      title: options.title || this.generateSessionTitle(),
      generationId: options.generationId,
      modelConfig: options.modelConfig,
      workingDirectory: options.workingDirectory,
      createdAt: now,
      updatedAt: now,
    };

    this.db.createSession(session);
    return session;
  }

  /**
   * 获取会话（带消息）
   */
  async getSession(sessionId: string, messageLimit: number = 100): Promise<SessionWithMessages | null> {
    // 检查缓存
    if (this.sessionCache.has(sessionId)) {
      return this.sessionCache.get(sessionId)!;
    }

    const storedSession = this.db.getSession(sessionId);
    if (!storedSession) return null;

    // 加载消息
    const messages = this.db.getRecentMessages(sessionId, messageLimit);
    const todos = this.db.getTodos(sessionId);

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
  async listSessions(limit: number = 50, offset: number = 0): Promise<StoredSession[]> {
    return this.db.listSessions(limit, offset);
  }

  /**
   * 更新会话
   */
  async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
    this.db.updateSession(sessionId, updates);

    // 更新缓存
    if (this.sessionCache.has(sessionId)) {
      const cached = this.sessionCache.get(sessionId)!;
      Object.assign(cached, updates, { updatedAt: Date.now() });
    }
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<void> {
    this.db.deleteSession(sessionId);
    this.sessionCache.delete(sessionId);
  }

  // --------------------------------------------------------------------------
  // Current Session Management
  // --------------------------------------------------------------------------

  /**
   * 设置当前会话
   */
  setCurrentSession(sessionId: string): void {
    this.currentSessionId = sessionId;
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

  /**
   * 创建或获取当前会话
   * 如果没有当前会话，则创建一个新的
   */
  async getOrCreateCurrentSession(options: SessionCreateOptions): Promise<Session> {
    if (this.currentSessionId) {
      const existing = await this.getSession(this.currentSessionId);
      if (existing) {
        return existing;
      }
    }

    // 创建新会话
    const session = await this.createSession(options);
    this.setCurrentSession(session.id);
    return session;
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

    this.db.addMessage(this.currentSessionId, message);

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
    return this.db.getMessages(sessionId, limit);
  }

  /**
   * 获取最近消息
   */
  async getRecentMessages(sessionId: string, count: number): Promise<Message[]> {
    return this.db.getRecentMessages(sessionId, count);
  }

  // --------------------------------------------------------------------------
  // Todo Management
  // --------------------------------------------------------------------------

  /**
   * 保存待办事项
   */
  async saveTodos(todos: TodoItem[]): Promise<void> {
    if (!this.currentSessionId) return;

    this.db.saveTodos(this.currentSessionId, todos);

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
    return this.db.getTodos(sessionId);
  }

  // --------------------------------------------------------------------------
  // Session Restoration
  // --------------------------------------------------------------------------

  /**
   * 恢复会话
   */
  async restoreSession(sessionId: string): Promise<SessionWithMessages | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    this.setCurrentSession(sessionId);
    return session;
  }

  /**
   * 获取最近的会话（用于自动恢复）
   */
  async getMostRecentSession(): Promise<StoredSession | null> {
    const sessions = await this.listSessions(1);
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
    return `CLI Session ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
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
      session.title.startsWith('CLI Session ') ||
      session.title === 'New Chat' ||
      session.title === '新对话';

    if (isDefaultTitle && session.messageCount <= 1) {
      // 从第一条消息提取标题
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
   * 导出会话
   */
  async exportSession(sessionId: string): Promise<SessionWithMessages | null> {
    return this.getSession(sessionId);
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let sessionManagerInstance: CLISessionManager | null = null;

export function getCLISessionManager(): CLISessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new CLISessionManager();
  }
  return sessionManagerInstance;
}
