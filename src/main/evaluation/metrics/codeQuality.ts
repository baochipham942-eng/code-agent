// ============================================================================
// Code Quality Evaluator - 代码质量评测
// ============================================================================

import {
  EvaluationDimension,
  DIMENSION_WEIGHTS,
  type EvaluationMetric,
} from '../../../shared/types/evaluation';
import type { SessionSnapshot, DimensionEvaluator } from '../types';

/**
 * 代码质量评测器
 * 评估指标：
 * - 文件操作成功率
 * - 编辑合理性
 * - 代码风格一致性
 */
export class CodeQualityEvaluator implements DimensionEvaluator {
  dimension = EvaluationDimension.CODE_QUALITY;

  async evaluate(snapshot: SessionSnapshot): Promise<EvaluationMetric> {
    const subMetrics: { name: string; value: number; unit?: string }[] = [];
    const suggestions: string[] = [];

    // 筛选代码相关的工具调用
    const codeTools = ['write_file', 'edit_file', 'read_file', 'bash'];
    const codeToolCalls = snapshot.toolCalls.filter((c) =>
      codeTools.some((t) => c.name.toLowerCase().includes(t))
    );

    // 1. 代码操作成功率
    const totalCodeOps = codeToolCalls.length;
    const successCodeOps = codeToolCalls.filter((c) => c.success).length;
    const codeSuccessRate =
      totalCodeOps > 0 ? (successCodeOps / totalCodeOps) * 100 : 100;
    subMetrics.push({ name: '操作成功率', value: Math.round(codeSuccessRate), unit: '%' });

    if (codeSuccessRate < 70) {
      suggestions.push('代码操作失败率较高，建议检查文件路径和编辑内容');
    }

    // 2. 编辑操作数量
    const editCalls = codeToolCalls.filter((c) =>
      c.name.toLowerCase().includes('edit')
    );
    subMetrics.push({ name: '编辑操作', value: editCalls.length, unit: '次' });

    // 3. 写入操作数量
    const writeCalls = codeToolCalls.filter((c) =>
      c.name.toLowerCase().includes('write')
    );
    subMetrics.push({ name: '写入操作', value: writeCalls.length, unit: '次' });

    // 4. 读取 vs 写入比例（理想是先读后写）
    const readCalls = codeToolCalls.filter((c) =>
      c.name.toLowerCase().includes('read')
    );
    const readWriteRatio =
      writeCalls.length > 0 ? readCalls.length / writeCalls.length : 1;
    let ratioScore: number;
    if (readWriteRatio >= 0.5) {
      ratioScore = 100; // 有足够的读取操作
    } else if (writeCalls.length === 0) {
      ratioScore = 100; // 没有写操作，不扣分
    } else {
      ratioScore = 70;
      suggestions.push('建议在修改文件前先读取内容，避免覆盖错误');
    }

    // 计算综合分数
    const hasCodeOps = totalCodeOps > 0;
    const score = hasCodeOps
      ? Math.round(codeSuccessRate * 0.6 + ratioScore * 0.4)
      : 85; // 没有代码操作给默认分

    return {
      dimension: this.dimension,
      score: Math.min(100, Math.max(0, score)),
      weight: DIMENSION_WEIGHTS[this.dimension],
      subMetrics,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }
}
