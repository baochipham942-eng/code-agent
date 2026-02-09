// ============================================================================
// Tool Efficiency Evaluator - 工具效率评测
// ============================================================================

import {
  EvaluationDimension,
  DIMENSION_WEIGHTS,
  type EvaluationMetric,
} from '../../../shared/types/evaluation';
import type { SessionSnapshot, DimensionEvaluator, ToolCallStats } from '../types';

/**
 * 工具效率评测器
 * 评估指标：
 * - 调用成功率
 * - 冗余调用检测
 * - 工具选择合理性
 */
export class ToolEfficiencyEvaluator implements DimensionEvaluator {
  dimension = EvaluationDimension.TOOL_EFFICIENCY;

  async evaluate(snapshot: SessionSnapshot): Promise<EvaluationMetric> {
    const subMetrics: { name: string; value: number; unit?: string }[] = [];
    const suggestions: string[] = [];

    const stats = this.analyzeToolCalls(snapshot);

    // 1. 成功率
    const successRate =
      stats.total > 0 ? (stats.successful / stats.total) * 100 : 100;
    subMetrics.push({ name: '成功率', value: Math.round(successRate), unit: '%' });

    // 2. 冗余调用率
    const redundancyRate =
      stats.total > 0 ? (stats.redundantCalls / stats.total) * 100 : 0;
    subMetrics.push({ name: '冗余率', value: Math.round(redundancyRate), unit: '%' });

    if (redundancyRate > 20) {
      suggestions.push('存在较多重复工具调用，可能需要优化工具使用策略');
    }

    // 3. 工具多样性（使用不同工具的数量）
    const toolDiversity = Object.keys(stats.byTool).length;
    subMetrics.push({ name: '工具种类', value: toolDiversity, unit: '个' });

    // 4. 失败率
    const failRate = stats.total > 0 ? (stats.failed / stats.total) * 100 : 0;
    if (failRate > 30) {
      suggestions.push('工具调用失败率较高，建议检查工具参数');
    }

    // 计算综合分数
    const score = Math.round(
      successRate * 0.5 +
        (100 - redundancyRate) * 0.3 +
        Math.min(toolDiversity * 10, 100) * 0.2
    );

    return {
      dimension: this.dimension,
      score: Math.min(100, Math.max(0, score)),
      weight: DIMENSION_WEIGHTS[this.dimension] ?? 0,
      subMetrics,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }

  private analyzeToolCalls(snapshot: SessionSnapshot): ToolCallStats {
    const stats: ToolCallStats = {
      total: snapshot.toolCalls.length,
      successful: 0,
      failed: 0,
      byTool: {},
      redundantCalls: 0,
    };

    const recentCalls: string[] = [];

    for (const call of snapshot.toolCalls) {
      if (call.success) {
        stats.successful++;
      } else {
        stats.failed++;
      }

      if (!stats.byTool[call.name]) {
        stats.byTool[call.name] = { count: 0, successCount: 0 };
      }
      stats.byTool[call.name].count++;
      if (call.success) {
        stats.byTool[call.name].successCount++;
      }

      // 检测冗余调用（相同工具 + 相似参数）
      const callKey = `${call.name}:${JSON.stringify(call.args)}`;
      if (recentCalls.includes(callKey)) {
        stats.redundantCalls++;
      }
      recentCalls.push(callKey);
      if (recentCalls.length > 10) {
        recentCalls.shift();
      }
    }

    return stats;
  }
}
