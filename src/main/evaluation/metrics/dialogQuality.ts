// ============================================================================
// Dialog Quality Evaluator - 对话质量评测
// ============================================================================

import {
  EvaluationDimension,
  DIMENSION_WEIGHTS,
  type EvaluationMetric,
} from '../../../shared/types/evaluation';
import type { SessionSnapshot, DimensionEvaluator } from '../types';

/**
 * 对话质量评测器
 * 评估指标：
 * - 轮次效率
 * - 响应完整性
 * - 澄清提问质量
 */
export class DialogQualityEvaluator implements DimensionEvaluator {
  dimension = EvaluationDimension.DIALOG_QUALITY;

  async evaluate(snapshot: SessionSnapshot): Promise<EvaluationMetric> {
    const subMetrics: { name: string; value: number; unit?: string }[] = [];
    const suggestions: string[] = [];

    const userMessages = snapshot.messages.filter((m) => m.role === 'user');
    const assistantMessages = snapshot.messages.filter((m) => m.role === 'assistant');

    // 1. 轮次效率（理想 3-7 轮）
    const turns = userMessages.length;
    let turnScore: number;
    if (turns >= 3 && turns <= 7) {
      turnScore = 100;
    } else if (turns < 3) {
      turnScore = 70; // 可能太简单
    } else {
      turnScore = Math.max(50, 100 - (turns - 7) * 5);
    }
    subMetrics.push({ name: '轮次评分', value: turnScore, unit: '' });

    // 2. 响应长度均衡性（避免过短或过长）
    const avgAssistantLength =
      assistantMessages.length > 0
        ? assistantMessages.reduce((sum, m) => sum + m.content.length, 0) /
          assistantMessages.length
        : 0;
    let lengthScore: number;
    if (avgAssistantLength >= 100 && avgAssistantLength <= 2000) {
      lengthScore = 100;
    } else if (avgAssistantLength < 100) {
      lengthScore = 60; // 响应太短
      suggestions.push('响应内容偏短，可能信息不够完整');
    } else {
      lengthScore = Math.max(60, 100 - (avgAssistantLength - 2000) / 100);
      suggestions.push('响应内容较长，可以考虑更简洁');
    }
    subMetrics.push({
      name: '平均响应长度',
      value: Math.round(avgAssistantLength),
      unit: '字符',
    });

    // 3. 对话连贯性（基于时间间隔）
    let continuityScore = 100;
    if (snapshot.messages.length > 1) {
      const gaps: number[] = [];
      for (let i = 1; i < snapshot.messages.length; i++) {
        gaps.push(
          snapshot.messages[i].timestamp - snapshot.messages[i - 1].timestamp
        );
      }
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      // 超过 5 分钟的间隔降低分数
      if (avgGap > 300000) {
        continuityScore = 70;
      }
    }
    subMetrics.push({ name: '连贯性', value: continuityScore, unit: '' });

    // 计算综合分数
    const score = Math.round(
      turnScore * 0.4 + lengthScore * 0.3 + continuityScore * 0.3
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
