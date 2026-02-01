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
 * - 响应时间
 * - Token 效率
 * - 成本效益
 */
export class PerformanceEvaluator implements DimensionEvaluator {
  dimension = EvaluationDimension.PERFORMANCE;

  async evaluate(snapshot: SessionSnapshot): Promise<EvaluationMetric> {
    const subMetrics: { name: string; value: number; unit?: string }[] = [];
    const suggestions: string[] = [];

    // 1. 会话时长评分（理想 1-10 分钟）
    const durationMs = snapshot.endTime - snapshot.startTime;
    const durationMin = durationMs / 60000;
    let durationScore: number;
    if (durationMin >= 1 && durationMin <= 10) {
      durationScore = 100;
    } else if (durationMin < 1) {
      durationScore = 90; // 太快可能任务简单
    } else {
      durationScore = Math.max(50, 100 - (durationMin - 10) * 2);
      if (durationMin > 30) {
        suggestions.push('会话时间较长，可考虑拆分为多个子任务');
      }
    }
    subMetrics.push({
      name: '时长',
      value: Math.round(durationMin * 10) / 10,
      unit: '分钟',
    });

    // 2. Token 效率（输出/输入比，理想 1-3）
    const tokenRatio =
      snapshot.inputTokens > 0
        ? snapshot.outputTokens / snapshot.inputTokens
        : 1;
    let tokenScore: number;
    if (tokenRatio >= 0.5 && tokenRatio <= 3) {
      tokenScore = 100;
    } else if (tokenRatio > 3) {
      tokenScore = 80;
      suggestions.push('输出 Token 较多，可以考虑更简洁的回复');
    } else {
      tokenScore = 70;
    }
    const totalTokens = snapshot.inputTokens + snapshot.outputTokens;
    subMetrics.push({ name: 'Token 总量', value: totalTokens, unit: '' });

    // 3. 成本效益
    const costPer1kTokens =
      totalTokens > 0 ? (snapshot.totalCost / totalTokens) * 1000 : 0;
    subMetrics.push({
      name: '成本',
      value: Math.round(snapshot.totalCost * 10000) / 10000,
      unit: 'USD',
    });

    // 基于绝对成本的评分
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
      weight: DIMENSION_WEIGHTS[this.dimension],
      subMetrics,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }
}
