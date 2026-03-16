// ============================================================================
// Continuous Learning Service - 持续学习服务
// 整合模式提取和技能合成，实现会话级别的持续学习
// ============================================================================

import type { Message } from '../../shared/types';
import { getMemoryService } from './memoryService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ContinuousLearning');

// ----------------------------------------------------------------------------
// Types (stubs — old pattern/skill system removed)
// ----------------------------------------------------------------------------

/** Stub: extracted pattern (old system removed) */
export interface ExtractedPattern {
  type: string;
  content: string;
  confidence: number;
  context?: { filesModified?: string[]; toolsUsed?: string[] };
}

/** Stub: synthesized skill (old system removed) */
export interface SynthesizedSkill {
  name: string;
  description: string;
  type: string;
  confidence: number;
  successRate: number;
  usageCount: number;
  triggers: Array<{ type: string; pattern: string }>;
  content: { toolSequence?: string[] };
}

/** Stub: tool execution record */
export interface ToolExecution {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
  duration: number;
}

/** Stub: skill usage tracking */
export interface SkillUsageTracking {
  skillId: string;
  success: boolean;
  context?: Record<string, unknown>;
}

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

    // Old pattern extractor / skill synthesizer removed — return empty result
    const result = this.createEmptyResult();
    result.duration = Date.now() - startTime;
    this.sessionLearnings.set(sessionId, result);
    this.lastLearningTime = Date.now();
    return result;
  }

  /**
   * 获取技能推荐
   */
  getSkillRecommendations(_context: {
    query?: string;
    currentTools?: string[];
    currentFiles?: string[];
  }): SkillRecommendation[] {
    // Old skill synthesizer removed — no recommendations
    return [];
  }

  /**
   * 记录技能使用
   */
  trackSkillUsage(_tracking: SkillUsageTracking): void {
    // Old skill synthesizer removed — no-op
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
    skillStats: Record<string, never>;
  } {
    let totalPatterns = 0;
    let totalSkills = 0;

    for (const result of this.sessionLearnings.values()) {
      totalPatterns += result.patternsExtracted;
      totalSkills += result.skillsSynthesized;
    }

    return {
      totalSessions: this.sessionLearnings.size,
      totalPatternsExtracted: totalPatterns,
      totalSkillsSynthesized: totalSkills,
      skillStats: {},
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
