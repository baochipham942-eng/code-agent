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
 * - 读写比例合理性
 * - 代码块语法检查
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
      ratioScore = 100;
    } else if (writeCalls.length === 0) {
      ratioScore = 100;
    } else {
      ratioScore = 70;
      suggestions.push('建议在修改文件前先读取内容，避免覆盖错误');
    }

    // 5. 代码块语法检查
    const syntaxResult = this.checkCodeSyntax(snapshot);
    let syntaxScore = 85; // 默认分（无代码块时）
    if (syntaxResult.total > 0) {
      syntaxScore = Math.round((syntaxResult.valid / syntaxResult.total) * 100);
      subMetrics.push({
        name: '语法正确率',
        value: syntaxScore,
        unit: `% (${syntaxResult.valid}/${syntaxResult.total})`,
      });
      if (syntaxScore < 80) {
        suggestions.push('部分代码块存在语法问题（如括号不匹配），建议检查');
      }
    }

    // 计算综合分数（操作成功率 0.45，读写比 0.25，语法 0.30）
    const hasCodeOps = totalCodeOps > 0 || syntaxResult.total > 0;
    const score = hasCodeOps
      ? Math.round(codeSuccessRate * 0.45 + ratioScore * 0.25 + syntaxScore * 0.30)
      : 85;

    return {
      dimension: this.dimension,
      score: Math.min(100, Math.max(0, score)),
      weight: DIMENSION_WEIGHTS[this.dimension] ?? 0,
      subMetrics,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }

  /**
   * 从 assistant 消息提取代码块并做基础语法检查
   */
  private checkCodeSyntax(snapshot: SessionSnapshot): { valid: number; total: number } {
    const codeBlocks: { lang: string; code: string }[] = [];

    // 优先从 turns，fallback 到 messages
    const sources =
      snapshot.turns.length > 0
        ? snapshot.turns.map((t) => t.assistantResponse)
        : snapshot.messages.filter((m) => m.role === 'assistant').map((m) => m.content);

    for (const content of sources) {
      const matches = content.matchAll(/```(\w*)\n([\s\S]*?)```/g);
      for (const match of matches) {
        if (match[2]?.trim()) {
          codeBlocks.push({ lang: match[1] || 'unknown', code: match[2].trim() });
        }
      }
    }

    if (codeBlocks.length === 0) return { valid: 0, total: 0 };

    let valid = 0;
    for (const block of codeBlocks) {
      if (this.basicSyntaxCheck(block.lang, block.code)) valid++;
    }
    return { valid, total: codeBlocks.length };
  }

  /**
   * 基础语法检查（括号匹配、明显语法错误）
   */
  private basicSyntaxCheck(_lang: string, code: string): boolean {
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const closers = new Set(Object.values(pairs));
    const stack: string[] = [];
    let inString = false;
    let stringChar = '';
    let prevChar = '';

    for (const ch of code) {
      if (inString) {
        if (ch === stringChar && prevChar !== '\\') inString = false;
        prevChar = ch;
        continue;
      }
      if ((ch === '"' || ch === "'" || ch === '`') && prevChar !== '\\') {
        inString = true;
        stringChar = ch;
        prevChar = ch;
        continue;
      }
      if (ch in pairs) stack.push(pairs[ch]);
      else if (closers.has(ch)) {
        if (stack.pop() !== ch) return false;
      }
      prevChar = ch;
    }
    return stack.length === 0;
  }
}
