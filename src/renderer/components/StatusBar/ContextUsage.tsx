// ============================================================================
// ContextUsage - 上下文使用率显示（带进度条和颜色编码）
// ============================================================================

import React from 'react';
import type { ContextUsageProps } from './types';

/**
 * 获取文本颜色类名
 * - <70%: 绿色
 * - 70-90%: 黄色
 * - >=90%: 红色
 */
function getTextColor(percent: number): string {
  if (percent >= 90) return 'text-red-400';
  if (percent >= 70) return 'text-yellow-400';
  return 'text-green-400';
}

/**
 * 获取进度条颜色类名
 */
function getBarColor(percent: number): string {
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 70) return 'bg-yellow-500';
  return 'bg-green-500';
}

export function ContextUsage({ percent }: ContextUsageProps) {
  // 确保百分比在 0-100 范围内
  const normalizedPercent = Math.min(100, Math.max(0, percent));
  const displayPercent = Math.round(normalizedPercent);

  return (
    <div
      className="flex items-center gap-2"
      title={`Context usage: ${displayPercent}% of available context window`}
    >
      {/* 进度条 */}
      <div className="flex h-2 w-20 bg-gray-700 rounded overflow-hidden">
        <div
          className={`${getBarColor(normalizedPercent)} transition-all duration-300`}
          style={{ width: `${normalizedPercent}%` }}
        />
      </div>
      {/* 百分比 */}
      <span className={getTextColor(normalizedPercent)}>
        {displayPercent}%
      </span>
    </div>
  );
}
