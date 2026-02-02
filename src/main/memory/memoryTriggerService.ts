// ============================================================================
// Memory Trigger Service - 会话开始自动触发记忆检索
// Gen5 Memory System: Automatically retrieves relevant context when session starts
// ============================================================================

import { getMemoryService } from './memoryService';
import { getProactiveContextService, type ProactiveContextResult } from './proactiveContext';
import { getVectorStore } from './vectorStore';
import { createLogger } from '../services/infra/logger';
import { withTimeout } from '../services/infra/timeoutController';

const logger = createLogger('MemoryTrigger');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 会话开始时检索的记忆上下文
 */
export interface SessionMemoryContext {
  // 项目相关
  projectKnowledge: Array<{
    key: string;
    value: unknown;
    source: string;
    confidence: number;
  }>;

  // 最近相关代码
  relevantCode: Array<{
    content: string;
    filePath?: string;
    score: number;
  }>;

  // 最近对话历史摘要
  recentConversations: Array<{
    content: string;
    sessionId?: string;
    score: number;
  }>;

  // 用户偏好
  userPreferences: Record<string, unknown>;

  // 统计信息
  stats: {
    projectKnowledgeCount: number;
    relevantCodeCount: number;
    conversationCount: number;
    retrievalTimeMs: number;
  };
}

/**
 * 触发器配置
 */
export interface MemoryTriggerConfig {
  // 是否启用自动触发
  enabled: boolean;

  // 项目知识检索数量
  maxProjectKnowledge: number;

  // 相关代码检索数量
  maxRelevantCode: number;

  // 对话历史检索数量
  maxConversations: number;

  // 最小相似度阈值
  minSimilarityThreshold: number;

  // 超时时间（毫秒）
  timeoutMs: number;
}

const DEFAULT_CONFIG: MemoryTriggerConfig = {
  enabled: true,
  maxProjectKnowledge: 5,
  maxRelevantCode: 3,
  maxConversations: 3,
  minSimilarityThreshold: 0.5,
  timeoutMs: 5000,
};

// ----------------------------------------------------------------------------
// Memory Trigger Service
// ----------------------------------------------------------------------------

export class MemoryTriggerService {
  private config: MemoryTriggerConfig;
  private lastTriggerTime: number = 0;
  private debounceMs: number = 1000; // 防抖间隔

  constructor(config: Partial<MemoryTriggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 会话开始时触发记忆检索
   *
   * @param sessionId - 会话 ID
   * @param workingDirectory - 工作目录（项目路径）
   * @param initialQuery - 可选的初始查询（用于更精准的检索）
   * @returns 检索到的记忆上下文
   */
  async onSessionStart(
    sessionId: string,
    workingDirectory?: string,
    initialQuery?: string
  ): Promise<SessionMemoryContext> {
    const startTime = Date.now();

    // 防抖检查
    if (Date.now() - this.lastTriggerTime < this.debounceMs) {
      logger.debug('Memory trigger debounced');
      return this.createEmptyContext(0);
    }
    this.lastTriggerTime = Date.now();

    // 检查是否启用
    if (!this.config.enabled) {
      logger.debug('Memory trigger disabled');
      return this.createEmptyContext(0);
    }

    logger.info(`Memory trigger started for session ${sessionId}`);

    try {
      // 设置内存服务上下文
      const memoryService = getMemoryService();
      memoryService.setContext(sessionId, workingDirectory);

      // 并行执行所有检索操作（带超时）
      const [projectKnowledge, relevantCode, recentConversations, userPreferences] =
        await withTimeout(
          Promise.all([
            this.retrieveProjectKnowledge(workingDirectory),
            this.retrieveRelevantCode(workingDirectory, initialQuery),
            this.retrieveRecentConversations(sessionId, initialQuery),
            this.retrieveUserPreferences(),
          ]),
          this.config.timeoutMs,
          `Memory retrieval timeout (${this.config.timeoutMs}ms)`
        );

      const retrievalTimeMs = Date.now() - startTime;

      logger.info(
        `Memory retrieval completed in ${retrievalTimeMs}ms: ` +
        `${projectKnowledge.length} knowledge, ${relevantCode.length} code, ` +
        `${recentConversations.length} conversations`
      );

      return {
        projectKnowledge,
        relevantCode,
        recentConversations,
        userPreferences,
        stats: {
          projectKnowledgeCount: projectKnowledge.length,
          relevantCodeCount: relevantCode.length,
          conversationCount: recentConversations.length,
          retrievalTimeMs,
        },
      };
    } catch (error) {
      logger.error('Memory trigger failed:', error);
      return this.createEmptyContext(Date.now() - startTime);
    }
  }

  /**
   * 用户发送消息时触发主动上下文检索
   *
   * @param userMessage - 用户消息
   * @param workingDirectory - 工作目录
   * @returns 主动检索的上下文
   */
  async onUserMessage(
    userMessage: string,
    workingDirectory?: string
  ): Promise<ProactiveContextResult | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      const proactiveService = getProactiveContextService();
      return await proactiveService.analyzeAndFetchContext(userMessage, workingDirectory);
    } catch (error) {
      logger.error('Proactive context retrieval failed:', error);
      return null;
    }
  }

  /**
   * 检索项目知识
   */
  private async retrieveProjectKnowledge(
    projectPath?: string
  ): Promise<SessionMemoryContext['projectKnowledge']> {
    if (!projectPath) {
      return [];
    }

    try {
      const memoryService = getMemoryService();
      const knowledge = memoryService.getProjectKnowledge();

      return knowledge
        .slice(0, this.config.maxProjectKnowledge)
        .map((k) => ({
          key: k.key,
          value: k.value,
          source: k.source,
          confidence: k.confidence,
        }));
    } catch (error) {
      logger.warn('Failed to retrieve project knowledge:', error);
      return [];
    }
  }

  /**
   * 检索相关代码
   */
  private async retrieveRelevantCode(
    projectPath?: string,
    query?: string
  ): Promise<SessionMemoryContext['relevantCode']> {
    if (!projectPath) {
      return [];
    }

    try {
      const vectorStore = getVectorStore();

      // 使用查询或默认查询
      const searchQuery = query || 'project structure main entry point';

      const results = await vectorStore.searchAsync(searchQuery, {
        topK: this.config.maxRelevantCode,
        threshold: this.config.minSimilarityThreshold,
        filter: { source: 'file', projectPath },
      });

      return results.map((r) => ({
        content: r.document.content.slice(0, 500), // 限制内容长度
        filePath: r.document.metadata.filePath,
        score: r.score,
      }));
    } catch (error) {
      logger.warn('Failed to retrieve relevant code:', error);
      return [];
    }
  }

  /**
   * 检索最近对话
   */
  private async retrieveRecentConversations(
    sessionId: string,
    query?: string
  ): Promise<SessionMemoryContext['recentConversations']> {
    try {
      const vectorStore = getVectorStore();

      // 使用查询或默认查询
      const searchQuery = query || 'recent conversation context';

      const results = await vectorStore.searchAsync(searchQuery, {
        topK: this.config.maxConversations,
        threshold: this.config.minSimilarityThreshold,
        filter: { source: 'conversation' },
      });

      // 排除当前会话的对话
      return results
        .filter((r) => r.document.metadata.sessionId !== sessionId)
        .map((r) => ({
          content: r.document.content.slice(0, 300), // 限制内容长度
          sessionId: r.document.metadata.sessionId,
          score: r.score,
        }));
    } catch (error) {
      logger.warn('Failed to retrieve recent conversations:', error);
      return [];
    }
  }

  /**
   * 检索用户偏好
   */
  private async retrieveUserPreferences(): Promise<Record<string, unknown>> {
    try {
      const memoryService = getMemoryService();

      // 获取关键偏好
      const codingStyle = memoryService.getUserPreference<Record<string, unknown>>('coding_style');
      const toolPrefs = memoryService.getUserPreference<Record<string, number>>('tool_preferences');

      return {
        ...(codingStyle && { codingStyle }),
        ...(toolPrefs && { toolPreferences: toolPrefs }),
      };
    } catch (error) {
      logger.warn('Failed to retrieve user preferences:', error);
      return {};
    }
  }

  /**
   * 创建空的上下文
   */
  private createEmptyContext(retrievalTimeMs: number): SessionMemoryContext {
    return {
      projectKnowledge: [],
      relevantCode: [],
      recentConversations: [],
      userPreferences: {},
      stats: {
        projectKnowledgeCount: 0,
        relevantCodeCount: 0,
        conversationCount: 0,
        retrievalTimeMs,
      },
    };
  }

  /**
   * 格式化记忆上下文为 System Prompt 片段
   */
  formatContextForPrompt(context: SessionMemoryContext): string {
    const sections: string[] = [];

    // 项目知识
    if (context.projectKnowledge.length > 0) {
      sections.push('## 📚 Project Knowledge');
      for (const k of context.projectKnowledge) {
        sections.push(`- **${k.key}**: ${JSON.stringify(k.value)}`);
      }
      sections.push('');
    }

    // 相关代码
    if (context.relevantCode.length > 0) {
      sections.push('## 📄 Relevant Code');
      for (const code of context.relevantCode) {
        if (code.filePath) {
          sections.push(`**${code.filePath}** (relevance: ${(code.score * 100).toFixed(0)}%)`);
        }
        sections.push('```');
        sections.push(code.content);
        sections.push('```');
        sections.push('');
      }
    }

    // 用户偏好
    if (Object.keys(context.userPreferences).length > 0) {
      sections.push('## ⚙️ User Preferences');
      sections.push('```json');
      sections.push(JSON.stringify(context.userPreferences, null, 2));
      sections.push('```');
      sections.push('');
    }

    if (sections.length === 0) {
      return '';
    }

    return `
# 🧠 Memory Context (Auto-retrieved)

${sections.join('\n')}

---
*Retrieved in ${context.stats.retrievalTimeMs}ms*
`;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<MemoryTriggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): MemoryTriggerConfig {
    return { ...this.config };
  }

  /**
   * 启用/禁用触发器
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    logger.info(`Memory trigger ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let memoryTriggerInstance: MemoryTriggerService | null = null;

/**
 * 获取 MemoryTriggerService 单例
 */
export function getMemoryTriggerService(): MemoryTriggerService {
  if (!memoryTriggerInstance) {
    memoryTriggerInstance = new MemoryTriggerService();
  }
  return memoryTriggerInstance;
}

/**
 * 初始化 MemoryTriggerService
 */
export function initMemoryTriggerService(
  config?: Partial<MemoryTriggerConfig>
): MemoryTriggerService {
  memoryTriggerInstance = new MemoryTriggerService(config);
  return memoryTriggerInstance;
}
