// ============================================================================
// Memory Service - 统一记忆管理服务
// ============================================================================

import {
  getDatabase,
  type ProjectKnowledge,
  getToolCache,
  getSessionManager,
  getTokenManager,
} from '../services';
import {
  getVectorStore,
  type SearchResult,
} from './vectorStore';
import type { Message, TodoItem, ToolResult } from '../../shared/types';
import { MEMORY_TIMEOUTS } from '../../shared/constants';
import { getMemoryDecayManager, type MemoryRecord as DecayMemoryRecord } from './memoryDecay';
import { getErrorLearningService } from './errorLearning';

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

  // 云端搜索配置
  enableCloudSearch: boolean;
  crossProjectSearch: boolean;
  cloudSearchTimeout: number;
}

// 搜索选项
export interface SearchOptions {
  topK?: number;
  includeCloud?: boolean;
  crossProject?: boolean;
  threshold?: number;
}

// 增强的搜索结果（包含来源信息）
export interface EnhancedSearchResult extends SearchResult {
  isFromCloud?: boolean;
  projectPath?: string | null;
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
      enableCloudSearch: true,
      crossProjectSearch: false,
      cloudSearchTimeout: MEMORY_TIMEOUTS.CLOUD_SEARCH,
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
   * 搜索相关代码（同步版本，仅本地）
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
   * 搜索相关代码（异步版本，支持云端混合搜索）
   */
  async searchRelevantCodeAsync(
    query: string,
    options?: SearchOptions
  ): Promise<EnhancedSearchResult[]> {
    const {
      topK = this.config.maxRAGResults,
      includeCloud = this.config.enableCloudSearch,
      crossProject = this.config.crossProjectSearch,
      threshold = 0.6,
    } = options || {};

    const vectorStore = getVectorStore();

    // 使用混合搜索
    const results = await vectorStore.searchHybridAsync(query, {
      topK,
      threshold,
      includeCloud,
      projectPath: this.projectPath || undefined,
      crossProject,
      filter: { source: 'file' },
    });

    // 标记结果来源
    return results.map((r) => ({
      ...r,
      isFromCloud: false, // 混合搜索内部已处理
    }));
  }

  /**
   * 搜索相关对话（同步版本，仅本地）
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
   * 搜索相关对话（异步版本，支持云端混合搜索）
   */
  async searchRelevantConversationsAsync(
    query: string,
    options?: SearchOptions
  ): Promise<EnhancedSearchResult[]> {
    const {
      topK = this.config.maxRAGResults,
      includeCloud = this.config.enableCloudSearch,
      crossProject = this.config.crossProjectSearch,
      threshold = 0.6,
    } = options || {};

    const vectorStore = getVectorStore();

    // 使用混合搜索
    const results = await vectorStore.searchHybridAsync(query, {
      topK,
      threshold,
      includeCloud,
      projectPath: this.projectPath || undefined,
      crossProject,
      filter: { source: 'conversation' },
    });

    return results.map((r) => ({
      ...r,
      isFromCloud: false,
    }));
  }

  /**
   * 添加知识条目
   */
  async addKnowledge(content: string, category: string): Promise<void> {
    const vectorStore = getVectorStore();
    await vectorStore.addKnowledge(content, category, this.projectPath || undefined);
  }

  /**
   * 搜索知识库（同步版本，仅本地）
   */
  searchKnowledge(query: string, category?: string, topK?: number): SearchResult[] {
    const vectorStore = getVectorStore();
    return vectorStore.searchKnowledge(query, category, topK || this.config.maxRAGResults);
  }

  /**
   * 搜索知识库（异步版本，支持云端混合搜索）
   */
  async searchKnowledgeAsync(
    query: string,
    options?: SearchOptions & { category?: string }
  ): Promise<EnhancedSearchResult[]> {
    const {
      topK = this.config.maxRAGResults,
      includeCloud = this.config.enableCloudSearch,
      crossProject = this.config.crossProjectSearch,
      threshold = 0.6,
      category,
    } = options || {};

    const vectorStore = getVectorStore();

    // 使用混合搜索
    const filter: Partial<{ source: string; category: string }> = { source: 'knowledge' };
    if (category) {
      filter.category = category;
    }

    const results = await vectorStore.searchHybridAsync(query, {
      topK,
      threshold,
      includeCloud,
      projectPath: this.projectPath || undefined,
      crossProject,
      filter,
    });

    return results.map((r) => ({
      ...r,
      isFromCloud: false,
    }));
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

  /**
   * 获取 RAG 增强的上下文（异步版本，支持云端搜索）
   */
  async getRAGContextAsync(
    query: string,
    options: {
      includeCode?: boolean;
      includeConversations?: boolean;
      includeKnowledge?: boolean;
      includeCloud?: boolean;
      crossProject?: boolean;
      maxTokens?: number;
    } = {}
  ): Promise<{ context: string; sources: Array<{ type: string; path?: string; score: number; fromCloud: boolean }> }> {
    const {
      includeCode = true,
      includeConversations = true,
      includeKnowledge = true,
      includeCloud = this.config.enableCloudSearch,
      crossProject = this.config.crossProjectSearch,
      maxTokens = this.config.ragTokenLimit,
    } = options;

    const vectorStore = getVectorStore();

    // 使用增强的 RAG 上下文获取方法
    return vectorStore.getEnhancedRAGContext(query, {
      maxTokens,
      sources: [
        ...(includeCode ? ['file' as const] : []),
        ...(includeConversations ? ['conversation' as const] : []),
        ...(includeKnowledge ? ['knowledge' as const] : []),
      ],
      projectPath: this.projectPath || undefined,
      includeCloud,
      crossProject,
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
   * 构建增强的 system prompt（同步版本，仅本地）
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

  /**
   * 构建增强的 system prompt（云端增强版本）
   * 支持云端搜索和跨项目知识检索
   */
  async buildEnhancedSystemPromptWithCloud(
    basePrompt: string,
    userQuery: string,
    options: {
      includeCloud?: boolean;
      crossProject?: boolean;
      maxTokens?: number;
    } = {}
  ): Promise<{
    prompt: string;
    sources: Array<{ type: string; path?: string; score: number; fromCloud: boolean }>;
  }> {
    const {
      includeCloud = this.config.enableCloudSearch,
      crossProject = this.config.crossProjectSearch,
      maxTokens = this.config.ragTokenLimit,
    } = options;

    let enhancedPrompt = basePrompt;
    const allSources: Array<{ type: string; path?: string; score: number; fromCloud: boolean }> = [];

    // 使用云端增强的 RAG 上下文
    const { context: ragContext, sources } = await this.getRAGContextAsync(userQuery, {
      includeCloud,
      crossProject,
      maxTokens,
    });

    if (ragContext) {
      enhancedPrompt += `\n\n## Relevant Context\n${ragContext}`;
      allSources.push(...sources);
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

    // 添加云端来源归因（如果有）
    const cloudSources = allSources.filter((s) => s.fromCloud);
    if (cloudSources.length > 0) {
      const sourceStr = cloudSources
        .slice(0, 3)
        .map((s) => `- [${s.type}] ${s.path || 'unknown'}`)
        .join('\n');
      enhancedPrompt += `\n\n## Context Sources (from cloud)\n${sourceStr}`;
    }

    return {
      prompt: enhancedPrompt,
      sources: allSources,
    };
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
   * 会话结束时自动学习
   * 从会话消息中提取知识并存储
   */
  async learnFromSession(messages: Message[]): Promise<{
    knowledgeExtracted: number;
    codeStylesLearned: number;
    toolPreferencesUpdated: number;
  }> {
    let knowledgeExtracted = 0;
    let codeStylesLearned = 0;
    let toolPreferencesUpdated = 0;

    // 分析对话中的模式
    const toolUsage: Record<string, number> = {};
    const codeSnippets: string[] = [];

    for (const message of messages) {
      // 统计工具使用情况
      if (message.toolCalls) {
        for (const tc of message.toolCalls) {
          toolUsage[tc.name] = (toolUsage[tc.name] || 0) + 1;
        }
      }

      // 提取代码片段
      const codeMatches = message.content.match(/```[\s\S]*?```/g);
      if (codeMatches) {
        codeSnippets.push(...codeMatches.map(m => m.replace(/```\w*\n?/g, '')));
      }

      // 提取可能的知识点（用户明确陈述的偏好或需求）
      if (message.role === 'user') {
        // 检测用户偏好陈述
        const preferencePatterns = [
          /(?:我(?:喜欢|倾向于|习惯|偏好|想要)|please use|i prefer|i like)\s+(.+)/gi,
          /(?:不要|不用|don't|avoid)\s+(.+)/gi,
        ];

        for (const pattern of preferencePatterns) {
          const matches = message.content.match(pattern);
          if (matches) {
            for (const match of matches) {
              await this.addKnowledge(match, 'user_preference');
              knowledgeExtracted++;
            }
          }
        }
      }
    }

    // 更新工具偏好
    if (Object.keys(toolUsage).length > 0) {
      const currentPrefs = this.getUserPreference<Record<string, number>>('tool_preferences', {}) || {};
      for (const [tool, count] of Object.entries(toolUsage)) {
        currentPrefs[tool] = (currentPrefs[tool] || 0) + count;
        toolPreferencesUpdated++;
      }
      this.setUserPreference('tool_preferences', currentPrefs);
    }

    // 学习代码风格
    for (const snippet of codeSnippets.slice(0, 5)) { // 限制处理数量
      if (snippet.length > 50) { // 只处理有意义的代码片段
        this.learnCodeStyle(snippet);
        codeStylesLearned++;
      }
    }

    return {
      knowledgeExtracted,
      codeStylesLearned,
      toolPreferencesUpdated,
    };
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
  // Memory CRUD (Gen5 记忆可视化)
  // --------------------------------------------------------------------------

  /**
   * 创建记忆记录
   */
  createMemory(memory: {
    type: 'user_preference' | 'code_pattern' | 'project_knowledge' | 'conversation' | 'tool_usage';
    category: string;
    content: string;
    summary: string;
    source?: 'auto_learned' | 'user_defined' | 'session_extracted';
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): import('../services').MemoryRecord {
    const db = getDatabase();
    return db.createMemory({
      type: memory.type,
      category: memory.category,
      content: memory.content,
      summary: memory.summary,
      source: memory.source || 'auto_learned',
      projectPath: this.projectPath || undefined,
      sessionId: this.sessionId || undefined,
      confidence: memory.confidence ?? 1.0,
      metadata: memory.metadata || {},
    });
  }

  /**
   * 获取单个记忆
   */
  getMemoryById(id: string): import('../services').MemoryRecord | null {
    const db = getDatabase();
    return db.getMemory(id);
  }

  /**
   * 列出记忆（支持过滤）
   */
  listMemories(options: {
    type?: 'user_preference' | 'code_pattern' | 'project_knowledge' | 'conversation' | 'tool_usage';
    category?: string;
    source?: 'auto_learned' | 'user_defined' | 'session_extracted';
    currentProjectOnly?: boolean;
    currentSessionOnly?: boolean;
    limit?: number;
    offset?: number;
    orderBy?: 'created_at' | 'updated_at' | 'access_count' | 'confidence';
    orderDir?: 'ASC' | 'DESC';
  } = {}): import('../services').MemoryRecord[] {
    const db = getDatabase();
    return db.listMemories({
      type: options.type,
      category: options.category,
      source: options.source,
      projectPath: options.currentProjectOnly ? this.projectPath || undefined : undefined,
      sessionId: options.currentSessionOnly ? this.sessionId || undefined : undefined,
      limit: options.limit,
      offset: options.offset,
      orderBy: options.orderBy,
      orderDir: options.orderDir,
    });
  }

  /**
   * 更新记忆
   */
  updateMemory(
    id: string,
    updates: {
      category?: string;
      content?: string;
      summary?: string;
      confidence?: number;
      metadata?: Record<string, unknown>;
    }
  ): import('../services').MemoryRecord | null {
    const db = getDatabase();
    return db.updateMemory(id, updates);
  }

  /**
   * 删除记忆
   */
  deleteMemory(id: string): boolean {
    const db = getDatabase();
    return db.deleteMemory(id);
  }

  /**
   * 批量删除记忆
   */
  deleteMemories(filter: {
    type?: 'user_preference' | 'code_pattern' | 'project_knowledge' | 'conversation' | 'tool_usage';
    category?: string;
    source?: 'auto_learned' | 'user_defined' | 'session_extracted';
    currentProjectOnly?: boolean;
    currentSessionOnly?: boolean;
  }): number {
    const db = getDatabase();
    return db.deleteMemories({
      type: filter.type,
      category: filter.category,
      source: filter.source,
      projectPath: filter.currentProjectOnly ? this.projectPath || undefined : undefined,
      sessionId: filter.currentSessionOnly ? this.sessionId || undefined : undefined,
    });
  }

  /**
   * 搜索记忆
   */
  searchMemories(
    query: string,
    options: {
      type?: 'user_preference' | 'code_pattern' | 'project_knowledge' | 'conversation' | 'tool_usage';
      category?: string;
      limit?: number;
    } = {}
  ): import('../services').MemoryRecord[] {
    const db = getDatabase();
    return db.searchMemories(query, options);
  }

  /**
   * 获取记忆统计
   */
  getMemoryStats(): {
    total: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
    byCategory: Record<string, number>;
  } {
    const db = getDatabase();
    return db.getMemoryStats();
  }

  /**
   * 记录记忆访问
   */
  recordMemoryAccess(id: string): void {
    const db = getDatabase();
    db.recordMemoryAccess(id);
  }

  // --------------------------------------------------------------------------
  // Memory Decay Integration
  // --------------------------------------------------------------------------

  /**
   * 获取记忆的衰减后置信度
   */
  getDecayedConfidence(memory: import('../services').MemoryRecord): number {
    const decayManager = getMemoryDecayManager();

    // 将 DB MemoryRecord 转换为 DecayMemoryRecord
    const decayRecord: DecayMemoryRecord = {
      id: memory.id,
      content: memory.content,
      createdAt: memory.createdAt,
      lastAccessedAt: memory.lastAccessedAt ?? memory.updatedAt,
      accessCount: memory.accessCount,
      confidence: memory.confidence,
      category: memory.category,
      metadata: memory.metadata,
    };

    return decayManager.calculateDecayedConfidence(decayRecord);
  }

  /**
   * 列出记忆（带衰减置信度）
   */
  listMemoriesWithDecay(options: {
    type?: 'user_preference' | 'code_pattern' | 'project_knowledge' | 'conversation' | 'tool_usage';
    category?: string;
    source?: 'auto_learned' | 'user_defined' | 'session_extracted';
    currentProjectOnly?: boolean;
    currentSessionOnly?: boolean;
    limit?: number;
    offset?: number;
    orderBy?: 'created_at' | 'updated_at' | 'access_count' | 'confidence';
    orderDir?: 'ASC' | 'DESC';
    minConfidence?: number;
  } = {}): Array<import('../services').MemoryRecord & { decayedConfidence: number }> {
    const memories = this.listMemories(options);
    const decayManager = getMemoryDecayManager();

    // 计算衰减后的置信度并过滤
    const result = memories.map((memory) => {
      const decayRecord: DecayMemoryRecord = {
        id: memory.id,
        content: memory.content,
        createdAt: memory.createdAt,
        lastAccessedAt: memory.lastAccessedAt ?? memory.updatedAt,
        accessCount: memory.accessCount,
        confidence: memory.confidence,
        category: memory.category,
        metadata: memory.metadata,
      };

      return {
        ...memory,
        decayedConfidence: decayManager.calculateDecayedConfidence(decayRecord),
      };
    });

    // 如果指定了最小置信度，则过滤
    if (options.minConfidence !== undefined) {
      return result.filter((m) => m.decayedConfidence >= options.minConfidence!);
    }

    return result;
  }

  /**
   * 获取需要清理的记忆（置信度过低）
   */
  getMemoriesToCleanup(): import('../services').MemoryRecord[] {
    const memories = this.listMemories({ limit: 1000 });
    const decayManager = getMemoryDecayManager();

    return memories.filter((memory) => {
      const decayRecord: DecayMemoryRecord = {
        id: memory.id,
        content: memory.content,
        createdAt: memory.createdAt,
        lastAccessedAt: memory.lastAccessedAt ?? memory.updatedAt,
        accessCount: memory.accessCount,
        confidence: memory.confidence,
        category: memory.category,
        metadata: memory.metadata,
      };

      return decayManager.shouldCleanup(decayRecord);
    });
  }

  /**
   * 清理低置信度记忆
   */
  cleanupDecayedMemories(): number {
    const toCleanup = this.getMemoriesToCleanup();
    let deleted = 0;

    for (const memory of toCleanup) {
      if (this.deleteMemory(memory.id)) {
        deleted++;
      }
    }

    return deleted;
  }

  /**
   * 强化记忆（记录访问并更新置信度）
   */
  reinforceMemory(id: string): import('../services').MemoryRecord | null {
    const memory = this.getMemoryById(id);
    if (!memory) return null;

    const decayManager = getMemoryDecayManager();
    const decayRecord: DecayMemoryRecord = {
      id: memory.id,
      content: memory.content,
      createdAt: memory.createdAt,
      lastAccessedAt: memory.lastAccessedAt ?? memory.updatedAt,
      accessCount: memory.accessCount,
      confidence: memory.confidence,
      category: memory.category,
      metadata: memory.metadata,
    };

    // 计算强化后的记录
    const reinforced = decayManager.recordAccess(decayRecord);

    // 更新数据库中的记忆
    return this.updateMemory(id, {
      confidence: reinforced.confidence,
    });
  }

  /**
   * 获取记忆衰减统计
   */
  getMemoryDecayStats(): {
    total: number;
    valid: number;
    needsCleanup: number;
    avgConfidence: number;
    avgAccessCount: number;
    byCategory: Record<string, { count: number; avgConfidence: number }>;
  } {
    const memories = this.listMemories({ limit: 1000 });
    const decayManager = getMemoryDecayManager();

    const decayRecords: DecayMemoryRecord[] = memories.map((memory) => ({
      id: memory.id,
      content: memory.content,
      createdAt: memory.createdAt,
      lastAccessedAt: memory.lastAccessedAt ?? memory.updatedAt,
      accessCount: memory.accessCount,
      confidence: memory.confidence,
      category: memory.category,
      metadata: memory.metadata,
    }));

    return decayManager.getStats(decayRecords);
  }

  // --------------------------------------------------------------------------
  // Error Learning Integration
  // --------------------------------------------------------------------------

  /**
   * 记录错误到学习服务
   */
  recordError(message: string, context: Record<string, unknown> = {}, toolName?: string): void {
    const errorLearning = getErrorLearningService();
    errorLearning.recordError(message, context, toolName);
  }

  /**
   * 记录错误解决方案
   */
  recordErrorResolution(errorSignature: string, action: string, success: boolean): void {
    const errorLearning = getErrorLearningService();
    errorLearning.recordResolution(errorSignature, action, success);
  }

  /**
   * 获取错误的建议修复方案
   */
  getSuggestedErrorFixes(message: string, toolName?: string): string[] {
    const errorLearning = getErrorLearningService();
    return errorLearning.getSuggestedFixes(message, toolName);
  }

  /**
   * 获取错误学习统计
   */
  getErrorLearningStats(): {
    totalPatterns: number;
    totalErrors: number;
    byCategory: Record<string, number>;
    topPatterns: Array<{
      signature: string;
      frequency: number;
      category: string;
      resolutionRate: number;
    }>;
  } {
    const errorLearning = getErrorLearningService();
    return errorLearning.getPatternStats();
  }

  /**
   * 获取特定工具的错误模式
   */
  getErrorPatternsForTool(toolName: string): import('./errorLearning').ErrorPattern[] {
    const errorLearning = getErrorLearningService();
    return errorLearning.getPatternsForTool(toolName);
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
