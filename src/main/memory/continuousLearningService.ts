// ============================================================================
// Continuous Learning Service - 持续学习服务
// 整合模式提取和技能合成，实现会话级别的持续学习
// ============================================================================

import type { Message } from '../../shared/types';
import { getPatternExtractor, type ExtractedPattern, type ToolExecution } from './patternExtractor';
import { getSkillSynthesizer, type SynthesizedSkill, type SkillUsageTracking } from './skillSynthesizer';
import { getMemoryService } from './memoryService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ContinuousLearning');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 学习结果
 */
export interface LearningResult {
  /** 提取的模式数量 */
  patternsExtracted: number;
  /** 合成的技能数量 */
  skillsSynthesized: number;
  /** 知识条目数量 */
  knowledgeStored: number;
  /** 学习耗时 */
  duration: number;
  /** 详细的模式列表 */
  patterns: ExtractedPattern[];
  /** 详细的技能列表 */
  skills: SynthesizedSkill[];
}

/**
 * 学习配置
 */
export interface LearningConfig {
  /** 是否启用持续学习 */
  enabled: boolean;
  /** 最小消息数量（触发学习的阈值）*/
  minMessagesForLearning: number;
  /** 最小工具执行数量 */
  minToolExecutionsForLearning: number;
  /** 是否自动合成技能 */
  autoSynthesizeSkills: boolean;
  /** 是否持久化到长期记忆 */
  persistToLongTermMemory: boolean;
  /** 学习间隔（毫秒）*/
  learningIntervalMs: number;
}

/**
 * 推荐的技能
 */
export interface SkillRecommendation {
  /** 技能 */
  skill: SynthesizedSkill;
  /** 匹配分数 */
  matchScore: number;
  /** 推荐原因 */
  reason: string;
}

// ----------------------------------------------------------------------------
// Default Config
// ----------------------------------------------------------------------------

const DEFAULT_CONFIG: LearningConfig = {
  enabled: true,
  minMessagesForLearning: 4,
  minToolExecutionsForLearning: 2,
  autoSynthesizeSkills: true,
  persistToLongTermMemory: true,
  learningIntervalMs: 60000, // 1 minute
};

// ----------------------------------------------------------------------------
// Continuous Learning Service
// ----------------------------------------------------------------------------

/**
 * 持续学习服务
 *
 * 整合模式提取器和技能合成器，提供：
 * - 会话结束时的自动学习
 * - 实时的技能推荐
 * - 学习成果的持久化
 */
export class ContinuousLearningService {
  private config: LearningConfig;
  private lastLearningTime: number = 0;
  private sessionLearnings: Map<string, LearningResult> = new Map();

  constructor(config?: Partial<LearningConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 会话结束时学习
   */
  async learnFromSession(
    sessionId: string,
    messages: Message[],
    toolExecutions?: ToolExecution[]
  ): Promise<LearningResult> {
    const startTime = Date.now();

    if (!this.config.enabled) {
      logger.debug('Continuous learning is disabled');
      return this.createEmptyResult();
    }

    // 检查是否满足学习条件
    if (messages.length < this.config.minMessagesForLearning) {
      logger.debug(`Not enough messages for learning: ${messages.length}`);
      return this.createEmptyResult();
    }

    if (toolExecutions && toolExecutions.length < this.config.minToolExecutionsForLearning) {
      logger.debug(`Not enough tool executions for learning: ${toolExecutions.length}`);
      return this.createEmptyResult();
    }

    logger.info(`Starting continuous learning for session ${sessionId}`, {
      messageCount: messages.length,
      toolExecutionCount: toolExecutions?.length || 0,
    });

    try {
      // 1. 提取模式
      const patternExtractor = getPatternExtractor();
      const patterns = await patternExtractor.extractFromSession(
        sessionId,
        messages,
        toolExecutions
      );

      // 2. 合成技能（如果启用）
      let skills: SynthesizedSkill[] = [];
      if (this.config.autoSynthesizeSkills && patterns.length > 0) {
        const skillSynthesizer = getSkillSynthesizer();
        skills = await skillSynthesizer.synthesizeFromPatterns(patterns);
      }

      // 3. 持久化到长期记忆（如果启用）
      let knowledgeStored = 0;
      if (this.config.persistToLongTermMemory) {
        knowledgeStored = await this.persistToMemory(sessionId, patterns, skills);
      }

      const result: LearningResult = {
        patternsExtracted: patterns.length,
        skillsSynthesized: skills.length,
        knowledgeStored,
        duration: Date.now() - startTime,
        patterns,
        skills,
      };

      // 缓存学习结果
      this.sessionLearnings.set(sessionId, result);
      this.lastLearningTime = Date.now();

      logger.info(`Continuous learning completed for session ${sessionId}`, {
        patternsExtracted: result.patternsExtracted,
        skillsSynthesized: result.skillsSynthesized,
        knowledgeStored: result.knowledgeStored,
        duration: result.duration,
      });

      return result;
    } catch (error) {
      logger.error('Continuous learning failed:', error);
      return this.createEmptyResult();
    }
  }

  /**
   * 获取技能推荐
   */
  getSkillRecommendations(context: {
    query?: string;
    currentTools?: string[];
    currentFiles?: string[];
  }): SkillRecommendation[] {
    if (!this.config.enabled) {
      return [];
    }

    const skillSynthesizer = getSkillSynthesizer();
    const matchingSkills = skillSynthesizer.findMatchingSkills({
      query: context.query,
      tools: context.currentTools,
      files: context.currentFiles,
    });

    return matchingSkills.map(skill => ({
      skill,
      matchScore: skill.confidence * skill.successRate,
      reason: this.generateRecommendationReason(skill, context),
    }));
  }

  /**
   * 记录技能使用
   */
  trackSkillUsage(tracking: SkillUsageTracking): void {
    const skillSynthesizer = getSkillSynthesizer();
    skillSynthesizer.trackUsage(tracking);
  }

  /**
   * 获取会话学习结果
   */
  getSessionLearning(sessionId: string): LearningResult | undefined {
    return this.sessionLearnings.get(sessionId);
  }

  /**
   * 获取学习统计
   */
  getStats(): {
    totalSessions: number;
    totalPatternsExtracted: number;
    totalSkillsSynthesized: number;
    skillStats: ReturnType<typeof getSkillSynthesizer>['getStats'] extends () => infer R ? R : never;
  } {
    let totalPatterns = 0;
    let totalSkills = 0;

    for (const result of this.sessionLearnings.values()) {
      totalPatterns += result.patternsExtracted;
      totalSkills += result.skillsSynthesized;
    }

    const skillSynthesizer = getSkillSynthesizer();

    return {
      totalSessions: this.sessionLearnings.size,
      totalPatternsExtracted: totalPatterns,
      totalSkillsSynthesized: totalSkills,
      skillStats: skillSynthesizer.getStats(),
    };
  }

  /**
   * 清除会话学习缓存
   */
  clearSessionLearnings(): void {
    this.sessionLearnings.clear();
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * 持久化到长期记忆
   */
  private async persistToMemory(
    sessionId: string,
    patterns: ExtractedPattern[],
    skills: SynthesizedSkill[]
  ): Promise<number> {
    let stored = 0;

    try {
      const memoryService = getMemoryService();

      // 存储高置信度模式
      for (const pattern of patterns) {
        if (pattern.confidence >= 0.7) {
          try {
            await memoryService.addKnowledge(
              pattern.content,
              `pattern:${pattern.type}`
            );
            stored++;
          } catch (e) {
            logger.warn('Failed to store pattern:', e);
          }
        }
      }

      // 存储高置信度技能
      for (const skill of skills) {
        if (skill.confidence >= 0.7) {
          try {
            await memoryService.addKnowledge(
              `${skill.name}: ${skill.description}`,
              `skill:${skill.type}`
            );
            stored++;
          } catch (e) {
            logger.warn('Failed to store skill:', e);
          }
        }
      }

      logger.debug(`Persisted ${stored} items to long-term memory`);
    } catch (error) {
      logger.error('Failed to persist to memory:', error);
    }

    return stored;
  }

  /**
   * 生成推荐原因
   */
  private generateRecommendationReason(
    skill: SynthesizedSkill,
    context: { query?: string; currentTools?: string[]; currentFiles?: string[] }
  ): string {
    const reasons: string[] = [];

    if (context.query && skill.triggers.some(t =>
      t.type === 'keyword' && context.query?.toLowerCase().includes(t.pattern.toLowerCase())
    )) {
      reasons.push('匹配关键词');
    }

    if (context.currentTools && skill.content.toolSequence?.some(t =>
      context.currentTools?.includes(t)
    )) {
      reasons.push('相似的工具使用');
    }

    if (skill.usageCount > 0) {
      reasons.push(`成功使用 ${skill.usageCount} 次`);
    }

    if (skill.confidence > 0.8) {
      reasons.push('高置信度');
    }

    return reasons.join(', ') || '基于历史模式';
  }

  /**
   * 创建空结果
   */
  private createEmptyResult(): LearningResult {
    return {
      patternsExtracted: 0,
      skillsSynthesized: 0,
      knowledgeStored: 0,
      duration: 0,
      patterns: [],
      skills: [],
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let serviceInstance: ContinuousLearningService | null = null;

/**
 * 获取 ContinuousLearningService 单例
 */
export function getContinuousLearningService(): ContinuousLearningService {
  if (!serviceInstance) {
    serviceInstance = new ContinuousLearningService();
  }
  return serviceInstance;
}

/**
 * 创建新的 ContinuousLearningService 实例
 */
export function createContinuousLearningService(
  config?: Partial<LearningConfig>
): ContinuousLearningService {
  return new ContinuousLearningService(config);
}
