// ============================================================================
// Fork Detector - 会话 Fork 检测器
// ============================================================================
// 检索与当前任务相关的历史会话，支持用户选择 Fork 继承上下文。
// 实现 Smart Forking 的核心检索逻辑。
// ============================================================================

import { getVectorStore, type SearchResult } from './vectorStore';
import { createLogger } from '../services/infra/logger';
import type { SessionSummary } from './sessionSummarizer';

const logger = createLogger('ForkDetector');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 相关会话信息
 */
export interface RelevantSession {
  /** 会话 ID */
  sessionId: string;
  /** 会话标题 */
  title: string;
  /** 会话摘要 */
  summary: string;
  /** 相关性得分 (0-1) */
  relevanceScore: number;
  /** 创建时间 */
  createdAt: number;
  /** 项目路径 */
  projectPath?: string;
  /** 消息数量 */
  messageCount: number;
  /** 讨论主题 */
  topics?: string[];
}

/**
 * Fork 检测结果
 */
export interface ForkDetectionResult {
  /** 相关会话列表 */
  relevantSessions: RelevantSession[];
  /** 建议的操作 */
  suggestedAction: 'fork' | 'new' | 'ask';
  /** 建议理由 */
  reason: string;
}

/**
 * Fork 检测配置
 */
export interface ForkDetectorConfig {
  /** 最大返回结果数 */
  maxResults: number;
  /** 高相关性阈值（自动建议 fork） */
  highRelevanceThreshold: number;
  /** 中相关性阈值（展示列表） */
  mediumRelevanceThreshold: number;
  /** 时间衰减半衰期（天） */
  decayHalfLifeDays: number;
  /** 时间衰减权重 */
  recencyWeight: number;
  /** 同项目加权 */
  sameProjectBonus: number;
}

// ----------------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------------

const DEFAULT_CONFIG: ForkDetectorConfig = {
  maxResults: 5,
  highRelevanceThreshold: 0.8,
  mediumRelevanceThreshold: 0.5,
  decayHalfLifeDays: 30,
  recencyWeight: 0.3,
  sameProjectBonus: 0.2,
};

// ----------------------------------------------------------------------------
// Fork Detector Class
// ----------------------------------------------------------------------------

export class ForkDetector {
  private config: ForkDetectorConfig;

  constructor(config?: Partial<ForkDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检测相关历史会话
   *
   * @param query - 用户查询或任务描述
   * @param projectPath - 当前项目路径（可选）
   * @returns Fork 检测结果
   */
  async detectRelevantSessions(
    query: string,
    projectPath?: string
  ): Promise<ForkDetectionResult> {
    logger.info('Detecting relevant sessions', { query, projectPath });

    const vectorStore = getVectorStore();

    // 1. 向量检索会话摘要
    const searchResults = await vectorStore.search(query, {
      topK: this.config.maxResults * 2, // 多检索一些，后面过滤
      filter: { type: 'session_summary' },
    });

    if (searchResults.length === 0) {
      logger.debug('No relevant sessions found');
      return {
        relevantSessions: [],
        suggestedAction: 'new',
        reason: '没有找到相关的历史会话',
      };
    }

    // 2. 计算综合得分（语义 + 时间 + 项目）
    const scoredSessions = this.calculateScores(searchResults, projectPath);

    // 3. 过滤并排序
    const relevantSessions = scoredSessions
      .filter((s) => s.relevanceScore >= this.config.mediumRelevanceThreshold)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, this.config.maxResults);

    // 4. 确定建议操作
    const { suggestedAction, reason } = this.determineSuggestedAction(relevantSessions);

    logger.info('Fork detection completed', {
      found: relevantSessions.length,
      suggestedAction,
    });

    return {
      relevantSessions,
      suggestedAction,
      reason,
    };
  }

  /**
   * 计算综合得分
   */
  private calculateScores(
    searchResults: SearchResult[],
    currentProjectPath?: string
  ): RelevantSession[] {
    const now = Date.now();
    const halfLifeMs = this.config.decayHalfLifeDays * 24 * 60 * 60 * 1000;

    return searchResults.map((result) => {
      const doc = result.document;
      const metadata = doc.metadata || {};
      const createdAt = (metadata as Record<string, unknown>).createdAt as number || now;

      // 语义相似度得分
      const semanticScore = result.score || 0;

      // 时间衰减得分
      const age = now - createdAt;
      const recencyScore = Math.exp(-age / halfLifeMs);

      // 同项目加分
      const metaProjectPath = (metadata as Record<string, unknown>).projectPath as string | undefined;
      const isSameProject =
        currentProjectPath &&
        metaProjectPath &&
        metaProjectPath === currentProjectPath;
      const projectBonus = isSameProject ? this.config.sameProjectBonus : 0;

      // 综合得分
      const relevanceScore = Math.min(
        1,
        (1 - this.config.recencyWeight) * semanticScore +
          this.config.recencyWeight * recencyScore +
          projectBonus
      );

      const metaSessionId = (metadata as Record<string, unknown>).sessionId as string | undefined;
      const metaTitle = (metadata as Record<string, unknown>).title as string | undefined;
      const metaMessageCount = (metadata as Record<string, unknown>).messageCount as number | undefined;
      const metaTopics = (metadata as Record<string, unknown>).topics as string[] | undefined;

      return {
        sessionId: metaSessionId || doc.id,
        title: metaTitle || '未命名会话',
        summary: doc.content,
        relevanceScore,
        createdAt,
        projectPath: metaProjectPath,
        messageCount: metaMessageCount || 0,
        topics: metaTopics,
      };
    });
  }

  /**
   * 确定建议操作
   */
  private determineSuggestedAction(sessions: RelevantSession[]): {
    suggestedAction: 'fork' | 'new' | 'ask';
    reason: string;
  } {
    if (sessions.length === 0) {
      return {
        suggestedAction: 'new',
        reason: '没有找到相关的历史会话',
      };
    }

    const topSession = sessions[0];

    // 高相关性 - 建议 fork
    if (topSession.relevanceScore >= this.config.highRelevanceThreshold) {
      return {
        suggestedAction: 'fork',
        reason: `找到高度相关的历史会话: "${topSession.title}" (相关性: ${(topSession.relevanceScore * 100).toFixed(0)}%)`,
      };
    }

    // 中相关性 - 让用户选择
    if (topSession.relevanceScore >= this.config.mediumRelevanceThreshold) {
      return {
        suggestedAction: 'ask',
        reason: `找到 ${sessions.length} 个可能相关的历史会话，请选择是否继承上下文`,
      };
    }

    // 低相关性 - 新会话
    return {
      suggestedAction: 'new',
      reason: '历史会话相关性较低，建议开始新会话',
    };
  }

  /**
   * 按项目路径检索会话
   */
  async getSessionsByProject(
    projectPath: string,
    limit = 10
  ): Promise<RelevantSession[]> {
    const vectorStore = getVectorStore();

    const results = await vectorStore.search('', {
      topK: limit,
      filter: {
        type: 'session_summary',
        projectPath,
      },
    });

    return this.calculateScores(results, projectPath)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 获取最近的会话列表
   */
  async getRecentSessions(limit = 10): Promise<RelevantSession[]> {
    const vectorStore = getVectorStore();

    // 使用空查询获取所有会话摘要
    const results = await vectorStore.search('session', {
      topK: limit * 2,
      filter: { type: 'session_summary' },
    });

    return this.calculateScores(results)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /**
   * 格式化检测结果为用户友好的文本
   */
  formatResultForUser(result: ForkDetectionResult): string {
    const lines: string[] = [];

    if (result.relevantSessions.length === 0) {
      return '没有找到相关的历史会话。将开始新会话。';
    }

    lines.push(`找到 ${result.relevantSessions.length} 个相关历史会话：\n`);

    result.relevantSessions.forEach((session, index) => {
      const date = new Date(session.createdAt).toLocaleDateString('zh-CN');
      const score = (session.relevanceScore * 100).toFixed(0);

      lines.push(`${index + 1}. **${session.title}**`);
      lines.push(`   - 相关性: ${score}%`);
      lines.push(`   - 时间: ${date}`);
      lines.push(`   - 消息数: ${session.messageCount}`);
      if (session.topics && session.topics.length > 0) {
        lines.push(`   - 主题: ${session.topics.slice(0, 5).join(', ')}`);
      }
      lines.push('');
    });

    lines.push(`\n建议: ${result.reason}`);

    return lines.join('\n');
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let detectorInstance: ForkDetector | null = null;

export function getForkDetector(): ForkDetector {
  if (!detectorInstance) {
    detectorInstance = new ForkDetector();
  }
  return detectorInstance;
}

export function initForkDetector(
  config?: Partial<ForkDetectorConfig>
): ForkDetector {
  detectorInstance = new ForkDetector(config);
  return detectorInstance;
}
