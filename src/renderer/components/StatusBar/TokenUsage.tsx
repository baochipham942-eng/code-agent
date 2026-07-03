// ============================================================================
// TokenUsage - 显示输入/输出 token 使用量
// ============================================================================

import React from 'react';
import type { TokenUsageProps } from './types';
import type { BudgetStatusView } from '../../hooks/useBudgetStatus';

/**
 * 格式化 token 数量
 * - 小于 1000 显示原数字
 * - 大于等于 1000 显示 k 格式
 */
function formatTokens(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return n.toString();
}

/**
 * 从 host 侧真实记账解析显示值（WP-2：STATUS_TOKEN_UPDATE 推送通道已死，改经 BudgetStatus 拉活值）。
 * input 显示口径 = 非缓存输入 + 缓存读 + 缓存写，与 provider 报告的提交总量对齐。纯函数便于单测。
 */
export function resolveDisplayTokens(budget?: BudgetStatusView | null): { input: number; output: number } {
  const usage = budget?.tokenUsage;
  if (!usage) return { input: 0, output: 0 };
  return {
    input: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
    output: usage.outputTokens,
  };
}

export function TokenUsage({ input, output, isStreaming }: TokenUsageProps) {
  return (
    <span
      className={`text-gray-400 ${isStreaming ? 'animate-pulse' : ''}`}
      title={`Input: ${input.toLocaleString()} tokens, Output: ${output.toLocaleString()} tokens`}
    >
      <span className="text-blue-400">{formatTokens(input)}</span>
      <span className="text-gray-600">/</span>
      <span className="text-green-400">{formatTokens(output)}{isStreaming ? ' \u25B2' : ''}</span>
    </span>
  );
}
