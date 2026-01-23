// ============================================================================
// TokenUsage - 显示输入/输出 token 使用量
// ============================================================================

import React from 'react';
import type { TokenUsageProps } from './types';

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

export function TokenUsage({ input, output }: TokenUsageProps) {
  return (
    <span
      className="text-gray-400"
      title={`Input: ${input.toLocaleString()} tokens, Output: ${output.toLocaleString()} tokens`}
    >
      <span className="text-blue-400">{formatTokens(input)}</span>
      <span className="text-gray-600">/</span>
      <span className="text-green-400">{formatTokens(output)}</span>
    </span>
  );
}
