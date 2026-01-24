// ============================================================================
// Skill Synthesizer - 将提取的模式合成为可复用技能
// ============================================================================

import type { ExtractedPattern, PatternType } from './patternExtractor';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SkillSynthesizer');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 合成技能的类型
 */
export type SkillType =
  | 'automation'      // 自动化工作流
  | 'template'        // 代码模板
  | 'guideline'       // 开发指南
  | 'troubleshoot';   // 故障排除

/**
 * 合成的技能
 */
export interface SynthesizedSkill {
  /** 技能 ID */
  id: string;
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 技能类型 */
  type: SkillType;
  /** 触发条件 */
  triggers: SkillTrigger[];
  /** 技能内容（可执行或参考） */
  content: SkillContent;
  /** 置信度 */
  confidence: number;
  /** 使用次数 */
  usageCount: number;
  /** 成功率 */
  successRate: number;
  /** 来源模式 */
  sourcePatterns: string[];
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/**
 * 技能触发条件
 */
export interface SkillTrigger {
  /** 触发类型 */
  type: 'keyword' | 'context' | 'file_pattern' | 'tool_pattern';
  /** 匹配模式 */
  pattern: string;
  /** 权重 */
  weight: number;
}

/**
 * 技能内容
 */
export interface SkillContent {
  /** 工具序列（用于 automation 类型） */
  toolSequence?: string[];
  /** 代码模板（用于 template 类型） */
  codeTemplate?: string;
  /** 指南文本（用于 guideline 类型） */
  guidelineText?: string;
  /** 解决方案（用于 troubleshoot 类型） */
  solution?: {
    problem: string;
    steps: string[];
  };
}

/**
 * 技能使用追踪
 */
export interface SkillUsageTracking {
  /** 技能 ID */
  skillId: string;
  /** 是否使用 */
  used: boolean;
  /** 是否成功 */
  successful: boolean;
  /** 用户反馈 */
  userFeedback?: 'helpful' | 'not_helpful' | 'incorrect';
  /** 时间戳 */
  timestamp: number;
}

/**
 * 合成配置
 */
export interface SynthesisConfig {
  /** 最小模式数量（需要多个模式才能合成） */
  minPatternsForSynthesis: number;
  /** 最小置信度 */
  minConfidence: number;
  /** 合并相似模式的阈值 */
  similarityThreshold: number;
  /** 最大技能数量 */
  maxSkills: number;
}

// ----------------------------------------------------------------------------
// Default Config
// ----------------------------------------------------------------------------

const DEFAULT_CONFIG: SynthesisConfig = {
  minPatternsForSynthesis: 1,
  minConfidence: 0.6,
  similarityThreshold: 0.7,
  maxSkills: 50,
};

// ----------------------------------------------------------------------------
// Skill Synthesizer
// ----------------------------------------------------------------------------

/**
 * 技能合成器
 *
 * 将从会话中提取的模式合成为可复用的技能。
 */
export class SkillSynthesizer {
  private config: SynthesisConfig;
  private skills: Map<string, SynthesizedSkill> = new Map();
  private usageHistory: SkillUsageTracking[] = [];

  constructor(config?: Partial<SynthesisConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 从模式合成技能
   */
  async synthesizeFromPatterns(patterns: ExtractedPattern[]): Promise<SynthesizedSkill[]> {
    const startTime = Date.now();
    const newSkills: SynthesizedSkill[] = [];

    logger.info(`Synthesizing skills from ${patterns.length} patterns`);

    try {
      // 按类型分组模式
      const patternsByType = this.groupPatternsByType(patterns);

      // 合成工作流技能
      if (patternsByType.workflow && patternsByType.workflow.length > 0) {
        const workflowSkills = this.synthesizeWorkflowSkills(patternsByType.workflow);
        newSkills.push(...workflowSkills);
      }

      // 合成代码模板技能
      if (patternsByType.code_pattern && patternsByType.code_pattern.length > 0) {
        const templateSkills = this.synthesizeTemplateSkills(patternsByType.code_pattern);
        newSkills.push(...templateSkills);
      }

      // 合成故障排除技能
      if (patternsByType.error_recovery && patternsByType.error_recovery.length > 0) {
        const troubleshootSkills = this.synthesizeTroubleshootSkills(patternsByType.error_recovery);
        newSkills.push(...troubleshootSkills);
      }

      // 合成指南技能
      if (patternsByType.preference && patternsByType.preference.length > 0) {
        const guidelineSkills = this.synthesizeGuidelineSkills(patternsByType.preference);
        newSkills.push(...guidelineSkills);
      }

      // 过滤低置信度技能
      const filteredSkills = newSkills.filter(s => s.confidence >= this.config.minConfidence);

      // 合并到现有技能库
      for (const skill of filteredSkills) {
        this.mergeOrAddSkill(skill);
      }

      logger.info(`Synthesized ${filteredSkills.length} skills`, {
        duration: Date.now() - startTime,
        totalSkills: this.skills.size,
      });

      return filteredSkills;
    } catch (error) {
      logger.error('Skill synthesis failed:', error);
      return [];
    }
  }

  /**
   * 获取匹配的技能
   */
  findMatchingSkills(context: {
    query?: string;
    tools?: string[];
    files?: string[];
  }): SynthesizedSkill[] {
    const matches: Array<{ skill: SynthesizedSkill; score: number }> = [];

    for (const skill of this.skills.values()) {
      let score = 0;

      for (const trigger of skill.triggers) {
        switch (trigger.type) {
          case 'keyword':
            if (context.query?.toLowerCase().includes(trigger.pattern.toLowerCase())) {
              score += trigger.weight;
            }
            break;

          case 'tool_pattern':
            if (context.tools?.some(t => t.includes(trigger.pattern))) {
              score += trigger.weight;
            }
            break;

          case 'file_pattern':
            if (context.files?.some(f => f.includes(trigger.pattern))) {
              score += trigger.weight;
            }
            break;
        }
      }

      if (score > 0) {
        matches.push({ skill, score });
      }
    }

    // 按分数排序
    return matches
      .sort((a, b) => b.score - a.score)
      .map(m => m.skill)
      .slice(0, 5);
  }

  /**
   * 记录技能使用
   */
  trackUsage(tracking: SkillUsageTracking): void {
    this.usageHistory.push(tracking);

    // 更新技能统计
    const skill = this.skills.get(tracking.skillId);
    if (skill) {
      skill.usageCount++;
      skill.updatedAt = Date.now();

      if (tracking.successful) {
        skill.successRate =
          (skill.successRate * (skill.usageCount - 1) + 1) / skill.usageCount;
      } else {
        skill.successRate =
          (skill.successRate * (skill.usageCount - 1)) / skill.usageCount;
      }

      // 根据反馈调整置信度
      if (tracking.userFeedback === 'helpful') {
        skill.confidence = Math.min(1, skill.confidence + 0.05);
      } else if (tracking.userFeedback === 'incorrect') {
        skill.confidence = Math.max(0, skill.confidence - 0.2);
      } else if (tracking.userFeedback === 'not_helpful') {
        skill.confidence = Math.max(0, skill.confidence - 0.1);
      }

      // 清理低置信度技能
      if (skill.confidence < 0.2 && skill.usageCount > 3) {
        this.skills.delete(tracking.skillId);
        logger.info(`Removed low-confidence skill: ${tracking.skillId}`);
      }
    }
  }

  /**
   * 获取所有技能
   */
  getAllSkills(): SynthesizedSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 获取技能统计
   */
  getStats(): {
    totalSkills: number;
    byType: Record<string, number>;
    averageConfidence: number;
    averageSuccessRate: number;
  } {
    const skills = Array.from(this.skills.values());
    const byType: Record<string, number> = {};

    for (const skill of skills) {
      byType[skill.type] = (byType[skill.type] || 0) + 1;
    }

    const avgConfidence =
      skills.length > 0
        ? skills.reduce((sum, s) => sum + s.confidence, 0) / skills.length
        : 0;

    const avgSuccessRate =
      skills.length > 0
        ? skills.reduce((sum, s) => sum + s.successRate, 0) / skills.length
        : 0;

    return {
      totalSkills: skills.length,
      byType,
      averageConfidence: avgConfidence,
      averageSuccessRate: avgSuccessRate,
    };
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * 按类型分组模式
   */
  private groupPatternsByType(patterns: ExtractedPattern[]): Record<PatternType, ExtractedPattern[]> {
    const grouped: Record<PatternType, ExtractedPattern[]> = {
      workflow: [],
      code_pattern: [],
      preference: [],
      knowledge: [],
      error_recovery: [],
    };

    for (const pattern of patterns) {
      grouped[pattern.type].push(pattern);
    }

    return grouped;
  }

  /**
   * 合成工作流技能
   */
  private synthesizeWorkflowSkills(patterns: ExtractedPattern[]): SynthesizedSkill[] {
    const skills: SynthesizedSkill[] = [];

    for (const pattern of patterns) {
      const toolSequence = pattern.context.toolsUsed;
      if (toolSequence.length < 2) continue;

      const skill: SynthesizedSkill = {
        id: `workflow-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        name: `自动化: ${toolSequence.slice(0, 3).join(' -> ')}`,
        description: pattern.content,
        type: 'automation',
        triggers: [
          ...toolSequence.map(tool => ({
            type: 'tool_pattern' as const,
            pattern: tool,
            weight: 0.3,
          })),
        ],
        content: {
          toolSequence,
        },
        confidence: pattern.confidence,
        usageCount: 0,
        successRate: 1,
        sourcePatterns: [pattern.content],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      skills.push(skill);
    }

    return skills;
  }

  /**
   * 合成代码模板技能
   */
  private synthesizeTemplateSkills(patterns: ExtractedPattern[]): SynthesizedSkill[] {
    const skills: SynthesizedSkill[] = [];

    // 合并相似的代码模式
    const mergedPatterns = this.mergeSimilarPatterns(patterns);

    for (const pattern of mergedPatterns) {
      // 从模式内容中提取关键词
      const keywords = this.extractKeywords(pattern.content);

      const skill: SynthesizedSkill = {
        id: `template-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        name: `代码模式: ${pattern.content.substring(0, 30)}`,
        description: pattern.content,
        type: 'template',
        triggers: keywords.map(kw => ({
          type: 'keyword' as const,
          pattern: kw,
          weight: 0.4,
        })),
        content: {
          codeTemplate: pattern.content,
        },
        confidence: pattern.confidence,
        usageCount: 0,
        successRate: 1,
        sourcePatterns: [pattern.content],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      skills.push(skill);
    }

    return skills;
  }

  /**
   * 合成故障排除技能
   */
  private synthesizeTroubleshootSkills(patterns: ExtractedPattern[]): SynthesizedSkill[] {
    const skills: SynthesizedSkill[] = [];

    for (const pattern of patterns) {
      // 解析错误和恢复信息
      const parts = pattern.content.split('\n');
      const problem = parts[0]?.replace('错误: ', '') || '';
      const solution = parts[1]?.replace('恢复: ', '') || '';

      if (!problem || !solution) continue;

      const skill: SynthesizedSkill = {
        id: `troubleshoot-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        name: `故障排除: ${problem.substring(0, 30)}`,
        description: pattern.content,
        type: 'troubleshoot',
        triggers: [
          {
            type: 'keyword',
            pattern: 'error',
            weight: 0.3,
          },
          ...this.extractKeywords(problem).map(kw => ({
            type: 'keyword' as const,
            pattern: kw,
            weight: 0.4,
          })),
        ],
        content: {
          solution: {
            problem,
            steps: [solution],
          },
        },
        confidence: pattern.confidence,
        usageCount: 0,
        successRate: 1,
        sourcePatterns: [pattern.content],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      skills.push(skill);
    }

    return skills;
  }

  /**
   * 合成指南技能
   */
  private synthesizeGuidelineSkills(patterns: ExtractedPattern[]): SynthesizedSkill[] {
    const skills: SynthesizedSkill[] = [];

    // 合并相同类别的偏好
    const preferenceGroups = new Map<string, ExtractedPattern[]>();
    for (const pattern of patterns) {
      const category = pattern.content.split('偏好')[0] || 'general';
      const existing = preferenceGroups.get(category) || [];
      existing.push(pattern);
      preferenceGroups.set(category, existing);
    }

    for (const [category, categoryPatterns] of preferenceGroups) {
      const combinedConfidence =
        categoryPatterns.reduce((sum, p) => sum + p.confidence, 0) / categoryPatterns.length;

      const indicators = categoryPatterns
        .flatMap(p => p.context.successIndicators)
        .filter((v, i, a) => a.indexOf(v) === i);

      const skill: SynthesizedSkill = {
        id: `guideline-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        name: `开发指南: ${category}`,
        description: categoryPatterns.map(p => p.content).join('\n'),
        type: 'guideline',
        triggers: indicators.map(ind => ({
          type: 'keyword' as const,
          pattern: ind,
          weight: 0.5,
        })),
        content: {
          guidelineText: `用户偏好 - ${category}:\n${indicators.join(', ')}`,
        },
        confidence: combinedConfidence,
        usageCount: 0,
        successRate: 1,
        sourcePatterns: categoryPatterns.map(p => p.content),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      skills.push(skill);
    }

    return skills;
  }

  /**
   * 合并相似模式
   */
  private mergeSimilarPatterns(patterns: ExtractedPattern[]): ExtractedPattern[] {
    // 简单实现：按内容前 50 字符分组
    const groups = new Map<string, ExtractedPattern[]>();

    for (const pattern of patterns) {
      const key = pattern.content.substring(0, 50);
      const existing = groups.get(key) || [];
      existing.push(pattern);
      groups.set(key, existing);
    }

    // 每组取置信度最高的
    return Array.from(groups.values()).map(group =>
      group.reduce((best, current) =>
        current.confidence > best.confidence ? current : best
      )
    );
  }

  /**
   * 提取关键词
   */
  private extractKeywords(text: string): string[] {
    const words = text
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3)
      .filter(w => !['this', 'that', 'with', 'from', 'have'].includes(w));

    return [...new Set(words)].slice(0, 5);
  }

  /**
   * 合并或添加技能
   */
  private mergeOrAddSkill(skill: SynthesizedSkill): void {
    // 检查是否有相似技能
    for (const [id, existing] of this.skills) {
      if (this.areSimilarSkills(skill, existing)) {
        // 合并技能
        existing.confidence = Math.max(existing.confidence, skill.confidence);
        existing.sourcePatterns.push(...skill.sourcePatterns);
        existing.updatedAt = Date.now();
        return;
      }
    }

    // 添加新技能
    if (this.skills.size < this.config.maxSkills) {
      this.skills.set(skill.id, skill);
    }
  }

  /**
   * 检查两个技能是否相似
   */
  private areSimilarSkills(a: SynthesizedSkill, b: SynthesizedSkill): boolean {
    if (a.type !== b.type) return false;

    // 简单的名称相似度检查
    const aWords = a.name.toLowerCase().split(/\W+/);
    const bWords = b.name.toLowerCase().split(/\W+/);
    const common = aWords.filter(w => bWords.includes(w)).length;
    const similarity = (2 * common) / (aWords.length + bWords.length);

    return similarity > this.config.similarityThreshold;
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let synthesizerInstance: SkillSynthesizer | null = null;

/**
 * 获取 SkillSynthesizer 单例
 */
export function getSkillSynthesizer(): SkillSynthesizer {
  if (!synthesizerInstance) {
    synthesizerInstance = new SkillSynthesizer();
  }
  return synthesizerInstance;
}

/**
 * 创建新的 SkillSynthesizer 实例
 */
export function createSkillSynthesizer(config?: Partial<SynthesisConfig>): SkillSynthesizer {
  return new SkillSynthesizer(config);
}
