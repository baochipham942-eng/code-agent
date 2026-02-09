// ============================================================================
// Task Completion Evaluator - 任务完成度评测
// ============================================================================

import {
  EvaluationDimension,
  DIMENSION_WEIGHTS,
  type EvaluationMetric,
} from '../../../shared/types/evaluation';
import type { SessionSnapshot, DimensionEvaluator } from '../types';

/**
 * 任务完成度评测器
 * 评估指标：
 * - Todo 完成率
 * - 工具调用成功率
 * - 用户确认次数
 */
export class TaskCompletionEvaluator implements DimensionEvaluator {
  dimension = EvaluationDimension.TASK_COMPLETION;

  async evaluate(snapshot: SessionSnapshot): Promise<EvaluationMetric> {
    const subMetrics: { name: string; value: number; unit?: string }[] = [];
    const suggestions: string[] = [];

    // 1. 工具调用成功率
    const totalCalls = snapshot.toolCalls.length;
    const successCalls = snapshot.toolCalls.filter((c) => c.success).length;
    const successRate = totalCalls > 0 ? (successCalls / totalCalls) * 100 : 100;
    subMetrics.push({ name: '工具成功率', value: Math.round(successRate), unit: '%' });

    if (successRate < 80) {
      suggestions.push('较多工具调用失败，建议检查参数或命令格式');
    }

    // 2. 会话轮次效率（越少越好，最优 3-5 轮）
    const userMessages = snapshot.messages.filter((m) => m.role === 'user').length;
    const turnEfficiency = Math.max(0, 100 - Math.abs(userMessages - 4) * 10);
    subMetrics.push({ name: '交互轮次', value: userMessages, unit: '轮' });

    if (userMessages > 10) {
      suggestions.push('会话轮次较多，考虑一次性提供更完整的需求描述');
    }

    // 3. 最终状态（基于最后几条消息判断）
    const lastAssistantMsg = [...snapshot.messages]
      .reverse()
      .find((m) => m.role === 'assistant');
    const hasCompletion =
      lastAssistantMsg?.content.includes('完成') ||
      lastAssistantMsg?.content.includes('已') ||
      lastAssistantMsg?.content.includes('done') ||
      lastAssistantMsg?.content.includes('成功');
    const completionScore = hasCompletion ? 100 : 60;
    subMetrics.push({ name: '任务状态', value: completionScore, unit: '' });

    // 计算综合分数
    const weights = [0.4, 0.3, 0.3];
    const scores = [successRate, turnEfficiency, completionScore];
    const score = Math.round(
      scores.reduce((acc, s, i) => acc + s * weights[i], 0)
    );

    return {
      dimension: this.dimension,
      score: Math.min(100, Math.max(0, score)),
      weight: DIMENSION_WEIGHTS[this.dimension] ?? 0,
      subMetrics,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }
}
