// ============================================================================
// Performance Evaluator - 性能指标评测
// ============================================================================

import {
  EvaluationDimension,
  DIMENSION_WEIGHTS,
  type EvaluationMetric,
} from '../../../shared/types/evaluation';
import type { SessionSnapshot, DimensionEvaluator } from '../types';

/**
 * 性能评测器
 * 评估指标：
 * - 响应时间（自适应阈值）
 * - Token 效率（自适应阈值）
 * - 成本效益
 */
export class PerformanceEvaluator implements DimensionEvaluator {
  dimension = EvaluationDimension.PERFORMANCE;

  async evaluate(snapshot: SessionSnapshot): Promise<EvaluationMetric> {
    const subMetrics: { name: string; value: number; unit?: string }[] = [];
    const suggestions: string[] = [];

    // 获取自适应阈值
    const thresholds = this.getAdaptiveThresholds(snapshot);

    // 1. 会话时长评分（自适应）
    const durationMs = snapshot.endTime - snapshot.startTime;
    const durationMin = durationMs / 60000;
    let durationScore: number;
    if (durationMin >= thresholds.minDuration && durationMin <= thresholds.maxDuration) {
      durationScore = 100;
    } else if (durationMin < thresholds.minDuration) {
      durationScore = 90;
    } else {
      durationScore = Math.max(50, 100 - (durationMin - thresholds.maxDuration) * 2);
      if (durationMin > thresholds.maxDuration * 3) {
        suggestions.push('会话时间较长，可考虑拆分为多个子任务');
      }
    }
    subMetrics.push({
      name: '时长',
      value: Math.round(durationMin * 10) / 10,
      unit: '分钟',
    });

    // 2. Token 效率（自适应）
    const tokenRatio =
      snapshot.inputTokens > 0
        ? snapshot.outputTokens / snapshot.inputTokens
        : 1;
    let tokenScore: number;
    if (tokenRatio >= thresholds.tokenRatioMin && tokenRatio <= thresholds.tokenRatioMax) {
      tokenScore = 100;
    } else if (tokenRatio > thresholds.tokenRatioMax) {
      tokenScore = 80;
      suggestions.push('输出 Token 较多，可以考虑更简洁的回复');
    } else {
      tokenScore = 70;
    }
    const totalTokens = snapshot.inputTokens + snapshot.outputTokens;
    subMetrics.push({ name: 'Token 总量', value: totalTokens, unit: '' });

    // 3. 成本效益
    subMetrics.push({
      name: '成本',
      value: Math.round(snapshot.totalCost * 10000) / 10000,
      unit: 'USD',
    });

    let costScore: number;
    if (snapshot.totalCost <= 0.01) {
      costScore = 100;
    } else if (snapshot.totalCost <= 0.05) {
      costScore = 90;
    } else if (snapshot.totalCost <= 0.1) {
      costScore = 80;
    } else {
      costScore = Math.max(50, 100 - snapshot.totalCost * 100);
      suggestions.push('成本较高，可考虑使用更经济的模型');
    }

    // 计算综合分数
    const score = Math.round(
      durationScore * 0.3 + tokenScore * 0.35 + costScore * 0.35
    );

    return {
      dimension: this.dimension,
      score: Math.min(100, Math.max(0, score)),
      weight: DIMENSION_WEIGHTS[this.dimension] ?? 0,
      subMetrics,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }

  /**
   * 根据任务复杂度推断自适应阈值
   */
  private getAdaptiveThresholds(snapshot: SessionSnapshot) {
    const toolCount = snapshot.toolCalls.length;

    if (toolCount === 0) {
      // 简单问答：快更好
      return { minDuration: 0, maxDuration: 3, tokenRatioMin: 0.5, tokenRatioMax: 5 };
    } else if (toolCount <= 5) {
      // 轻量任务
      return { minDuration: 0.5, maxDuration: 10, tokenRatioMin: 0.3, tokenRatioMax: 4 };
    } else {
      // 复杂任务：允许更长时间
      return { minDuration: 1, maxDuration: 30, tokenRatioMin: 0.2, tokenRatioMax: 5 };
    }
  }
}
