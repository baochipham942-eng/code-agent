// ============================================================================
// Tool Efficiency Evaluator - 工具效率评测
// ============================================================================

import {
  EvaluationDimension,
  DIMENSION_WEIGHTS,
  type EvaluationMetric,
} from '../../../shared/types/evaluation';
import type { SessionSnapshot, DimensionEvaluator, ToolCallStats, ToolCallRecord } from '../types';

/**
 * 工具效率评测器
 * 评估指标：
 * - 调用成功率
 * - 冗余调用检测（基于签名匹配）
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

    const window: string[] = [];

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

      // 改进冗余检测：按工具名+关键参数判断
      const key = this.getCallSignature(call);
      if (window.includes(key) && call.success) {
        // 成功后再次调用同签名 = 冗余
        stats.redundantCalls++;
      }
      window.push(key);
      if (window.length > 5) window.shift();
    }

    return stats;
  }

  /**
   * 提取工具调用签名（工具名+关键参数）
   */
  private getCallSignature(call: ToolCallRecord): string {
    const path = (call.args.path || call.args.file_path || '') as string;
    if (call.name.includes('read') || call.name.includes('Read') || call.name.includes('write') || call.name.includes('Write') || call.name.includes('edit') || call.name.includes('Edit')) {
      return `${call.name}:${path}`;
    }
    if (call.name === 'bash' || call.name === 'Bash') {
      const cmd = String(call.args.command || '').slice(0, 50);
      return `bash:${cmd}`;
    }
    return `${call.name}:${JSON.stringify(call.args).slice(0, 50)}`;
  }
}
