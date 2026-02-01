// ============================================================================
// Safe Injector - 安全注入器
// Gen 8: Self-Evolution - 分层注入机制，防止上下文污染
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type { Insight, InsightType } from './llmInsightExtractor';

const logger = createLogger('SafeInjector');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 注入层级定义
 * Layer 0: System Prompt（不可变，最高优先级）
 * Layer 1: 用户显式偏好（user_defined）
 * Layer 2: 项目配置（CLAUDE.md）
 * Layer 3: 高置信度学习（confidence > 0.8，经验证）
 * Layer 4: 低置信度学习（隔离区，不主动注入）
 * Layer 5: 实验性内容（沙箱，需审批）
 */
export enum InjectionLayer {
  SYSTEM = 0,
  USER_DEFINED = 1,
  PROJECT_CONFIG = 2,
  HIGH_CONFIDENCE = 3,
  LOW_CONFIDENCE = 4,
  EXPERIMENTAL = 5,
}

export interface InjectionConfig {
  minConfidenceForLayer3: number;  // 默认 0.8
  minConfidenceForLayer4: number;  // 默认 0.5
  decayHalfLifeDays: number;       // 默认 30
  maxInsightsPerLayer: number;     // 默认 10
  maxTotalTokens: number;          // 默认 2000
}

export interface Conflict {
  existingInsight: Insight;
  newInsight: Insight;
  conflictType: 'name_collision' | 'content_contradiction' | 'tool_conflict';
  description: string;
}

export interface InjectedContent {
  layer: InjectionLayer;
  content: string;
  sources: string[];  // Insight IDs
  totalTokens: number;
}

// 默认配置
const DEFAULT_CONFIG: InjectionConfig = {
  minConfidenceForLayer3: 0.8,
  minConfidenceForLayer4: 0.5,
  decayHalfLifeDays: 30,
  maxInsightsPerLayer: 10,
  maxTotalTokens: 2000,
};

// 数据库行类型
type SQLiteRow = Record<string, unknown>;

// ----------------------------------------------------------------------------
// Safe Injector Service
// ----------------------------------------------------------------------------

export class SafeInjector {
  private config: InjectionConfig;

  constructor(config: Partial<InjectionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 获取当前可注入的洞察（按层级过滤）
   */
  async getInjectableInsights(
    projectPath: string,
    maxLayer: InjectionLayer = InjectionLayer.HIGH_CONFIDENCE
  ): Promise<Insight[]> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return [];

    // 只注入已验证的或高置信度的洞察
    const rows = dbInstance.prepare(`
      SELECT * FROM insights
      WHERE injection_layer <= ?
        AND (validation_status = 'validated' OR (confidence >= ? AND validation_status = 'pending'))
        AND (project_path = ? OR project_path IS NULL)
      ORDER BY injection_layer ASC, confidence DESC, updated_at DESC
      LIMIT ?
    `).all(
      maxLayer,
      this.config.minConfidenceForLayer3,
      projectPath,
      this.config.maxInsightsPerLayer * (maxLayer + 1)
    ) as SQLiteRow[];

    // 应用衰减
    const insights = rows.map(row => this.applyDecay(this.rowToInsight(row)));

    // 过滤掉衰减后置信度过低的
    return insights.filter(i => i.confidence * i.decayFactor >= this.config.minConfidenceForLayer4);
  }

  /**
   * 应用衰减函数
   * 衰减公式: decay = 0.5 ^ (daysSinceLastUse / halfLifeDays)
   */
  private applyDecay(insight: Insight): Insight {
    const now = Date.now();
    const lastUse = insight.lastUsed || insight.updatedAt;
    const daysSinceLastUse = (now - lastUse) / (24 * 60 * 60 * 1000);

    const decay = Math.pow(0.5, daysSinceLastUse / this.config.decayHalfLifeDays);
    const newDecayFactor = Math.max(0.1, decay); // 最小衰减因子 0.1

    return {
      ...insight,
      decayFactor: newDecayFactor,
    };
  }

  /**
   * 格式化为注入内容
   */
  formatForInjection(insights: Insight[]): InjectedContent {
    if (insights.length === 0) {
      return {
        layer: InjectionLayer.HIGH_CONFIDENCE,
        content: '',
        sources: [],
        totalTokens: 0,
      };
    }

    const sections: string[] = [];
    const sources: string[] = [];
    let totalTokens = 0;

    // 按类型分组
    const byType = new Map<InsightType, Insight[]>();
    for (const insight of insights) {
      const list = byType.get(insight.type) || [];
      list.push(insight);
      byType.set(insight.type, list);
    }

    // 格式化每种类型
    for (const [type, typeInsights] of byType) {
      const typeSection = this.formatTypeSection(type, typeInsights);
      const tokens = this.estimateTokens(typeSection);

      if (totalTokens + tokens <= this.config.maxTotalTokens) {
        sections.push(typeSection);
        sources.push(...typeInsights.map(i => i.id));
        totalTokens += tokens;
      } else {
        // 超出 token 限制，截断
        logger.warn('[SafeInjector] Token limit reached, truncating', {
          totalTokens,
          limit: this.config.maxTotalTokens,
        });
        break;
      }
    }

    const content = sections.length > 0
      ? `<learned-insights>\n${sections.join('\n\n')}\n</learned-insights>`
      : '';

    const minLayer = Math.min(...insights.map(i => i.injectionLayer));

    return {
      layer: minLayer as InjectionLayer,
      content,
      sources,
      totalTokens,
    };
  }

  /**
   * 格式化单个类型的洞察
   */
  private formatTypeSection(type: InsightType, insights: Insight[]): string {
    const header = this.getTypeHeader(type);
    const items = insights.map(i => this.formatInsight(i)).join('\n');
    return `## ${header}\n${items}`;
  }

  /**
   * 获取类型标题
   */
  private getTypeHeader(type: InsightType): string {
    switch (type) {
      case 'strategy': return '学习到的策略';
      case 'tool_sequence': return '有效的工具序列';
      case 'workflow': return '工作流模式';
      case 'knowledge': return '项目知识';
      case 'skill': return '可用技能';
      default: return '其他洞察';
    }
  }

  /**
   * 格式化单个洞察
   */
  private formatInsight(insight: Insight): string {
    const confidence = (insight.confidence * insight.decayFactor * 100).toFixed(0);
    const usage = insight.usageCount > 0
      ? ` (使用 ${insight.usageCount} 次, 成功率 ${(insight.successRate * 100).toFixed(0)}%)`
      : '';

    return `- **${insight.name}** [置信度: ${confidence}%${usage}]\n  ${insight.content.substring(0, 200)}${insight.content.length > 200 ? '...' : ''}`;
  }

  /**
   * 估算 token 数（简单估算，每 4 个字符约 1 token）
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * 验证安全性
   */
  validateSafety(insight: Insight): { safe: boolean; reasons: string[] } {
    const reasons: string[] = [];

    // 1. 检查置信度
    if (insight.confidence < this.config.minConfidenceForLayer4) {
      reasons.push(`置信度过低 (${insight.confidence} < ${this.config.minConfidenceForLayer4})`);
    }

    // 2. 检查衰减后的有效置信度
    const effectiveConfidence = insight.confidence * insight.decayFactor;
    if (effectiveConfidence < 0.3) {
      reasons.push(`有效置信度过低 (${effectiveConfidence.toFixed(2)} < 0.3)`);
    }

    // 3. 检查成功率（如果有足够使用次数）
    if (insight.usageCount >= 5 && insight.successRate < 0.5) {
      reasons.push(`成功率过低 (${insight.successRate} < 0.5, 使用 ${insight.usageCount} 次)`);
    }

    // 4. 检查内容是否包含潜在危险模式
    const dangerousPatterns = [
      /rm\s+-rf/i,
      /sudo/i,
      /password/i,
      /secret/i,
      /api[_-]?key/i,
      /token/i,
    ];

    const content = typeof insight.content === 'string' ? insight.content : JSON.stringify(insight.content);
    for (const pattern of dangerousPatterns) {
      if (pattern.test(content)) {
        reasons.push(`内容可能包含敏感信息 (匹配: ${pattern})`);
        break;
      }
    }

    return {
      safe: reasons.length === 0,
      reasons,
    };
  }

  /**
   * 冲突检测
   */
  async detectConflicts(newInsight: Insight, projectPath?: string): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];
    const existingInsights = await this.getInjectableInsights(
      projectPath || '',
      InjectionLayer.EXPERIMENTAL
    );

    for (const existing of existingInsights) {
      // 1. 名称冲突
      if (existing.name.toLowerCase() === newInsight.name.toLowerCase() && existing.id !== newInsight.id) {
        conflicts.push({
          existingInsight: existing,
          newInsight,
          conflictType: 'name_collision',
          description: `名称重复: "${existing.name}"`,
        });
      }

      // 2. 类型相同且内容相似（简单检测）
      if (existing.type === newInsight.type && existing.id !== newInsight.id) {
        const existingContent = existing.content.toLowerCase();
        const newContent = newInsight.content.toLowerCase();

        // 简单的相似度检测
        const words1 = new Set(existingContent.split(/\s+/));
        const words2 = new Set(newContent.split(/\s+/));
        const intersection = [...words1].filter(w => words2.has(w));
        const similarity = intersection.length / Math.max(words1.size, words2.size);

        if (similarity > 0.7) {
          conflicts.push({
            existingInsight: existing,
            newInsight,
            conflictType: 'content_contradiction',
            description: `内容高度相似 (${(similarity * 100).toFixed(0)}%)，可能冲突`,
          });
        }
      }

      // 3. 工具序列冲突（如果都是 tool_sequence 类型）
      if (existing.type === 'tool_sequence' && newInsight.type === 'tool_sequence') {
        try {
          const existingSeq = JSON.parse(existing.content).sequence || [];
          const newSeq = JSON.parse(newInsight.content).sequence || [];

          // 检查是否有相同的起始工具但不同的后续
          if (existingSeq[0] === newSeq[0] && existingSeq.length > 1 && newSeq.length > 1) {
            if (existingSeq[1] !== newSeq[1]) {
              conflicts.push({
                existingInsight: existing,
                newInsight,
                conflictType: 'tool_conflict',
                description: `工具序列起始相同但后续不同: ${existingSeq[0]} → ${existingSeq[1]} vs ${newSeq[1]}`,
              });
            }
          }
        } catch {
          // 解析失败，忽略
        }
      }
    }

    return conflicts;
  }

  /**
   * 记录洞察使用
   */
  async recordUsage(insightId: string, success: boolean): Promise<void> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return;

    try {
      // 获取当前值
      const row = dbInstance.prepare(`
        SELECT usage_count, success_rate FROM insights WHERE id = ?
      `).get(insightId) as SQLiteRow | undefined;

      if (!row) return;

      const usageCount = ((row.usage_count as number) || 0) + 1;
      const oldSuccessRate = (row.success_rate as number) || 0;
      const oldSuccessCount = Math.round(oldSuccessRate * ((row.usage_count as number) || 0));
      const newSuccessCount = oldSuccessCount + (success ? 1 : 0);
      const newSuccessRate = newSuccessCount / usageCount;

      dbInstance.prepare(`
        UPDATE insights
        SET usage_count = ?, success_rate = ?, last_used = ?, updated_at = ?
        WHERE id = ?
      `).run(usageCount, newSuccessRate, Date.now(), Date.now(), insightId);

      logger.debug('[SafeInjector] Usage recorded', {
        insightId,
        usageCount,
        successRate: newSuccessRate,
      });
    } catch (error) {
      logger.error('[SafeInjector] Failed to record usage:', error);
    }
  }

  /**
   * 更新洞察层级（基于验证和使用情况）
   */
  async updateInsightLayer(insightId: string): Promise<void> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return;

    const row = dbInstance.prepare(`SELECT * FROM insights WHERE id = ?`).get(insightId) as SQLiteRow | undefined;
    if (!row) return;

    const insight = this.rowToInsight(row);
    let newLayer = insight.injectionLayer;

    // 根据验证状态和成功率调整层级
    if (insight.validationStatus === 'validated') {
      if (insight.usageCount >= 5 && insight.successRate >= 0.9) {
        newLayer = InjectionLayer.HIGH_CONFIDENCE;
      } else if (insight.successRate >= 0.7) {
        newLayer = InjectionLayer.HIGH_CONFIDENCE;
      }
    } else if (insight.validationStatus === 'rejected') {
      newLayer = InjectionLayer.EXPERIMENTAL;
    } else if (insight.confidence >= this.config.minConfidenceForLayer3) {
      // pending 状态但高置信度
      if (insight.usageCount >= 3 && insight.successRate >= 0.8) {
        newLayer = InjectionLayer.HIGH_CONFIDENCE;
      } else {
        newLayer = InjectionLayer.LOW_CONFIDENCE;
      }
    }

    if (newLayer !== insight.injectionLayer) {
      dbInstance.prepare(`
        UPDATE insights SET injection_layer = ?, updated_at = ? WHERE id = ?
      `).run(newLayer, Date.now(), insightId);

      logger.info('[SafeInjector] Insight layer updated', {
        insightId,
        oldLayer: insight.injectionLayer,
        newLayer,
      });
    }
  }

  /**
   * 定期清理过期洞察
   */
  async cleanupStaleInsights(): Promise<number> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return 0;

    // 删除衰减严重且长期未使用的洞察
    const cutoffDays = this.config.decayHalfLifeDays * 3; // 3 个半衰期
    const cutoffTime = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;

    const result = dbInstance.prepare(`
      DELETE FROM insights
      WHERE last_used < ?
        AND validation_status != 'validated'
        AND usage_count < 3
    `).run(cutoffTime);

    if (result.changes > 0) {
      logger.info('[SafeInjector] Cleaned up stale insights', { count: result.changes });
    }

    return result.changes;
  }

  /**
   * 行数据转 Insight
   */
  private rowToInsight(row: SQLiteRow): Insight {
    return {
      id: row.id as string,
      type: row.type as InsightType,
      name: row.name as string,
      content: row.content as string,
      sourceTraces: JSON.parse((row.source_traces as string) || '[]'),
      confidence: row.confidence as number,
      validationStatus: row.validation_status as 'pending' | 'validated' | 'rejected',
      usageCount: (row.usage_count as number) || 0,
      successRate: (row.success_rate as number) || 0,
      injectionLayer: (row.injection_layer as number) || InjectionLayer.LOW_CONFIDENCE,
      decayFactor: (row.decay_factor as number) || 1.0,
      lastUsed: row.last_used as number | undefined,
      projectPath: row.project_path as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let safeInjectorInstance: SafeInjector | null = null;

export function getSafeInjector(config?: Partial<InjectionConfig>): SafeInjector {
  if (!safeInjectorInstance) {
    safeInjectorInstance = new SafeInjector(config);
  }
  return safeInjectorInstance;
}

// 导出用于测试
export { SafeInjector as SafeInjectorClass };
