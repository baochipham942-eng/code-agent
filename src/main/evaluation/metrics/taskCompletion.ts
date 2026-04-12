// ============================================================================
// Task Completion Evaluator - 任务完成度评测
// ============================================================================

import {
  EvaluationDimension,
  DIMENSION_WEIGHTS,
  type EvaluationMetric,
} from '../../../shared/contract/evaluation';
import type { SessionSnapshot, DimensionEvaluator } from '../types';

/**
 * 任务完成度评测器
 * 评估指标：
 * - 工具调用成功率
 * - 会话轮次效率
 * - 多信号完成度评估（替代关键词匹配）
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

    // 3. 多信号完成度评估
    const completionScore = this.assessCompletion(snapshot);
    subMetrics.push({ name: '任务状态', value: completionScore, unit: '' });

    // 计算综合分数（权重调整：成功率 0.35，轮次 0.25，完成度 0.40）
    const weights = [0.35, 0.25, 0.40];
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

  /**
   * 多信号完成度评估（替代简单关键词匹配）
   */
  private assessCompletion(snapshot: SessionSnapshot): number {
    let signals = 0;
    let maxSignals = 0;

    // 信号1: 最后一条是 assistant（不是用户在追问）
    const lastMsg = snapshot.messages[snapshot.messages.length - 1];
    maxSignals++;
    if (lastMsg?.role === 'assistant') signals++;

    // 信号2: 有文件产出（如果任务涉及文件操作）
    const writeTools = ['write_file', 'edit_file'];
    const hasFileOutput = snapshot.toolCalls.some(
      (c) => writeTools.some((t) => c.name.toLowerCase().includes(t)) && c.success
    );
    const hasFileTask = snapshot.toolCalls.some(
      (c) => writeTools.some((t) => c.name.toLowerCase().includes(t))
    );
    if (hasFileTask) {
      maxSignals++;
      if (hasFileOutput) signals++;
    }

    // 信号3: 最后几个工具调用成功（不是以失败结尾）
    const lastCalls = snapshot.toolCalls.slice(-3);
    maxSignals++;
    if (lastCalls.length === 0 || lastCalls.some((c) => c.success)) signals++;

    // 信号4: 没有未恢复的错误
    let lastFailedIdx = -1;
    for (let i = snapshot.toolCalls.length - 1; i >= 0; i--) {
      if (!snapshot.toolCalls[i].success) { lastFailedIdx = i; break; }
    }
    const hasRecovery =
      lastFailedIdx === -1 ||
      snapshot.toolCalls.slice(lastFailedIdx + 1).some((c) => c.success);
    maxSignals++;
    if (hasRecovery) signals++;

    return maxSignals > 0 ? Math.round((signals / maxSignals) * 100) : 70;
  }
}
