// ============================================================================
// Memory Service - 统一记忆管理服务
// ============================================================================

import { getDatabase, type ProjectKnowledge } from '../services/DatabaseService';
import { getToolCache } from '../services/ToolCache';
import { getSessionManager } from '../services/SessionManager';
import { getTokenManager } from '../services/TokenManager';
import { getVectorStore, type SearchResult } from './VectorStore';
import type { Message, TodoItem, ToolResult } from '../../shared/types';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface MemoryContext {
  // 短期记忆
  recentMessages: Message[];
  currentTodos: TodoItem[];
  toolResults: Map<string, ToolResult>;

  // 中期记忆
  sessionHistory: Message[];
  userPreferences: Record<string, unknown>;

  // 长期记忆
  projectKnowledge: ProjectKnowledge[];
  relevantCode: SearchResult[];
  relevantConversations: SearchResult[];
}

export interface MemoryConfig {
  // 短期记忆配置
  maxRecentMessages: number;
  toolCacheTTL: number;

  // 中期记忆配置
  maxSessionMessages: number;

  // 长期记忆配置
  maxRAGResults: number;
  ragTokenLimit: number;
}

// ----------------------------------------------------------------------------
// Memory Service
// ----------------------------------------------------------------------------

export class MemoryService {
  private config: MemoryConfig;
  private sessionId: string | null = null;
  private projectPath: string | null = null;

  constructor(config?: Partial<MemoryConfig>) {
    this.config = {
      maxRecentMessages: 10,
      toolCacheTTL: 5 * 60 * 1000,
      maxSessionMessages: 100,
      maxRAGResults: 5,
      ragTokenLimit: 2000,
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Context Management
  // --------------------------------------------------------------------------

  setContext(sessionId: string, projectPath?: string): void {
    this.sessionId = sessionId;
    this.projectPath = projectPath || null;

    const toolCache = getToolCache();
    toolCache.setSessionId(sessionId);

    const sessionManager = getSessionManager();
    sessionManager.setCurrentSession(sessionId);
  }

  // --------------------------------------------------------------------------
  // Short-term Memory (Working Memory)
  // --------------------------------------------------------------------------

  /**
   * 获取最近消息
   */
  async getRecentMessages(count?: number): Promise<Message[]> {
    if (!this.sessionId) return [];

    const sessionManager = getSessionManager();
    return sessionManager.getRecentMessages(
      this.sessionId,
      count || this.config.maxRecentMessages
    );
  }

  /**
   * 获取/设置工具缓存
   */
  getCachedToolResult(toolName: string, args: Record<string, unknown>): ToolResult | null {
    const toolCache = getToolCache();
    return toolCache.get(toolName, args);
  }

  cacheToolResult(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult
  ): void {
    const toolCache = getToolCache();
    toolCache.set(toolName, args, result);
  }

  /**
   * 文件修改时使缓存失效
   */
  invalidateCacheForFile(filePath: string): void {
    const toolCache = getToolCache();
    toolCache.invalidateForPath(filePath);
  }

  // --------------------------------------------------------------------------
  // Mid-term Memory (Session Memory)
  // --------------------------------------------------------------------------

  /**
   * 保存消息到会话
   */
  async saveMessage(message: Message): Promise<void> {
    if (!this.sessionId) return;

    const sessionManager = getSessionManager();
    await sessionManager.addMessage(message);

    // 同时保存到向量存储（用于长期检索）
    const vectorStore = getVectorStore();
    await vectorStore.saveConversation(this.sessionId, message.content, message.role);
  }

  /**
   * 保存待办事项
   */
  async saveTodos(todos: TodoItem[]): Promise<void> {
    if (!this.sessionId) return;

    const sessionManager = getSessionManager();
    await sessionManager.saveTodos(todos);
  }

  /**
   * 获取用户偏好
   */
  getUserPreference<T>(key: string, defaultValue?: T): T | undefined {
    const db = getDatabase();
    return db.getPreference(key, defaultValue);
  }

  /**
   * 设置用户偏好
   */
  setUserPreference(key: string, value: unknown): void {
    const db = getDatabase();
    db.setPreference(key, value);
  }

  // --------------------------------------------------------------------------
  // Long-term Memory (Knowledge Memory)
  // --------------------------------------------------------------------------

  /**
   * 保存项目知识
   */
  saveProjectKnowledge(
    key: string,
    value: unknown,
    source: 'learned' | 'explicit' | 'inferred' = 'learned',
    confidence: number = 1.0
  ): void {
    if (!this.projectPath) return;

    const db = getDatabase();
    db.saveProjectKnowledge(this.projectPath, key, value, source, confidence);
  }

  /**
   * 获取项目知识
   */
  getProjectKnowledge(key?: string): ProjectKnowledge[] {
    if (!this.projectPath) return [];

    const db = getDatabase();
    return db.getProjectKnowledge(this.projectPath, key);
  }

  /**
   * 索引代码文件
   */
  async indexCodeFile(filePath: string, content: string): Promise<void> {
    if (!this.projectPath) return;

    const vectorStore = getVectorStore();
    await vectorStore.indexFile(this.projectPath, filePath, content);
  }

  /**
   * 搜索相关代码
   */
  searchRelevantCode(query: string, topK?: number): SearchResult[] {
    if (!this.projectPath) return [];

    const vectorStore = getVectorStore();
    return vectorStore.searchProject(
      this.projectPath,
      query,
      topK || this.config.maxRAGResults
    );
  }

  /**
   * 搜索相关对话
   */
  searchRelevantConversations(query: string, topK?: number): SearchResult[] {
    const vectorStore = getVectorStore();
    return vectorStore.searchConversations(
      query,
      this.sessionId || undefined,
      topK || this.config.maxRAGResults
    );
  }

  /**
   * 添加知识条目
   */
  async addKnowledge(content: string, category: string): Promise<void> {
    const vectorStore = getVectorStore();
    await vectorStore.addKnowledge(content, category, this.projectPath || undefined);
  }

  /**
   * 搜索知识库
   */
  searchKnowledge(query: string, category?: string, topK?: number): SearchResult[] {
    const vectorStore = getVectorStore();
    return vectorStore.searchKnowledge(query, category, topK || this.config.maxRAGResults);
  }

  // --------------------------------------------------------------------------
  // RAG (Retrieval Augmented Generation)
  // --------------------------------------------------------------------------

  /**
   * 获取 RAG 增强的上下文
   */
  getRAGContext(
    query: string,
    options: {
      includeCode?: boolean;
      includeConversations?: boolean;
      includeKnowledge?: boolean;
      maxTokens?: number;
    } = {}
  ): string {
    const {
      includeCode = true,
      includeConversations = true,
      includeKnowledge = true,
      maxTokens = this.config.ragTokenLimit,
    } = options;

    const sources: ('file' | 'conversation' | 'knowledge')[] = [];
    if (includeCode) sources.push('file');
    if (includeConversations) sources.push('conversation');
    if (includeKnowledge) sources.push('knowledge');

    const vectorStore = getVectorStore();
    return vectorStore.getRAGContext(query, {
      maxTokens,
      sources,
      projectPath: this.projectPath || undefined,
    });
  }

  // --------------------------------------------------------------------------
  // Context Building
  // --------------------------------------------------------------------------

  /**
   * 构建完整的记忆上下文
   */
  async buildMemoryContext(query?: string): Promise<MemoryContext> {
    const context: MemoryContext = {
      recentMessages: [],
      currentTodos: [],
      toolResults: new Map(),
      sessionHistory: [],
      userPreferences: {},
      projectKnowledge: [],
      relevantCode: [],
      relevantConversations: [],
    };

    // 短期记忆
    context.recentMessages = await this.getRecentMessages();

    if (this.sessionId) {
      const sessionManager = getSessionManager();
      const todos = await sessionManager.getTodos(this.sessionId);
      context.currentTodos = todos;
    }

    // 中期记忆
    if (this.sessionId) {
      const sessionManager = getSessionManager();
      context.sessionHistory = await sessionManager.getMessages(
        this.sessionId,
        this.config.maxSessionMessages
      );
    }

    const db = getDatabase();
    context.userPreferences = db.getAllPreferences();

    // 长期记忆 (需要查询)
    if (query) {
      context.projectKnowledge = this.getProjectKnowledge();
      context.relevantCode = this.searchRelevantCode(query);
      context.relevantConversations = this.searchRelevantConversations(query);
    }

    return context;
  }

  /**
   * 构建增强的 system prompt
   */
  async buildEnhancedSystemPrompt(
    basePrompt: string,
    userQuery: string
  ): Promise<string> {
    let enhancedPrompt = basePrompt;

    // 添加 RAG 上下文
    const ragContext = this.getRAGContext(userQuery);
    if (ragContext) {
      enhancedPrompt += `\n\n## Relevant Context\n${ragContext}`;
    }

    // 添加项目知识
    const knowledge = this.getProjectKnowledge();
    if (knowledge.length > 0) {
      const knowledgeStr = knowledge
        .slice(0, 5)
        .map((k) => `- ${k.key}: ${JSON.stringify(k.value)}`)
        .join('\n');
      enhancedPrompt += `\n\n## Project Knowledge\n${knowledgeStr}`;
    }

    // 添加用户偏好
    const prefs = this.getUserPreference<Record<string, unknown>>('coding_style');
    if (prefs) {
      enhancedPrompt += `\n\n## User Preferences\n${JSON.stringify(prefs, null, 2)}`;
    }

    return enhancedPrompt;
  }

  // --------------------------------------------------------------------------
  // Token Management Integration
  // --------------------------------------------------------------------------

  /**
   * 根据 token 限制裁剪消息
   */
  pruneMessagesForContext(
    messages: Message[],
    systemPrompt: string,
    model: string
  ): Message[] {
    const tokenManager = getTokenManager(model);

    if (!tokenManager.needsPruning(messages, systemPrompt)) {
      return messages;
    }

    const { messages: prunedMessages } = tokenManager.pruneMessages(
      messages,
      systemPrompt,
      {
        keepFirstN: 1, // 保留第一条消息
        keepLastN: 6, // 保留最后 6 条
        targetUtilization: 0.8,
      }
    );

    return prunedMessages;
  }

  // --------------------------------------------------------------------------
  // Learning
  // --------------------------------------------------------------------------

  /**
   * 从用户反馈中学习
   */
  learnFromFeedback(
    type: 'positive' | 'negative',
    context: { query: string; response: string; toolUsed?: string }
  ): void {
    const db = getDatabase();

    // 记录到审计日志
    db.logAuditEvent('user_feedback', {
      type,
      ...context,
    }, this.sessionId || undefined);

    // 根据正面反馈调整偏好
    if (type === 'positive' && context.toolUsed) {
      const toolPrefs = this.getUserPreference<Record<string, number>>('tool_preferences', {}) || {};
      toolPrefs[context.toolUsed] = (toolPrefs[context.toolUsed] || 0) + 1;
      this.setUserPreference('tool_preferences', toolPrefs);
    }
  }

  /**
   * 学习代码风格
   */
  learnCodeStyle(codeSnippet: string): void {
    // 简单的代码风格检测
    const style: Record<string, unknown> = {};

    // 检测缩进
    const indentMatch = codeSnippet.match(/^( +|\t)/m);
    if (indentMatch) {
      style.indent = indentMatch[0].includes('\t') ? 'tab' : `${indentMatch[0].length}spaces`;
    }

    // 检测引号风格
    if (codeSnippet.includes("'")) {
      style.quotes = 'single';
    } else if (codeSnippet.includes('"')) {
      style.quotes = 'double';
    }

    // 检测分号
    style.semicolons = codeSnippet.includes(';');

    // 保存到偏好
    const currentStyle = this.getUserPreference<Record<string, unknown>>('coding_style', {});
    this.setUserPreference('coding_style', { ...currentStyle, ...style });
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  /**
   * 清理过期数据
   */
  async cleanup(): Promise<void> {
    // 清理工具缓存
    const toolCache = getToolCache();
    toolCache.cleanExpired();

    // 保存向量存储
    const vectorStore = getVectorStore();
    await vectorStore.save();
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let memoryServiceInstance: MemoryService | null = null;

export function getMemoryService(): MemoryService {
  if (!memoryServiceInstance) {
    memoryServiceInstance = new MemoryService();
  }
  return memoryServiceInstance;
}

export function initMemoryService(config?: Partial<MemoryConfig>): MemoryService {
  memoryServiceInstance = new MemoryService(config);
  return memoryServiceInstance;
}
