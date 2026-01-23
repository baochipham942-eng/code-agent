// ============================================================================
// CostDisplay - 显示累计费用
// ============================================================================

import React from 'react';
import { DollarSign } from 'lucide-react';
import type { CostDisplayProps } from './types';

/**
 * 格式化费用显示
 * - 小于 $0.01 显示 <$0.01
 * - 小于 $1 显示 2 位小数
 * - 大于等于 $1 显示 2 位小数
 */
function formatCost(cost: number): string {
  if (cost === 0) {
    return '$0.00';
  }
  if (cost < 0.01) {
    return '<$0.01';
  }
  return `$${cost.toFixed(2)}`;
}

export function CostDisplay({ cost }: CostDisplayProps) {
  return (
    <span
      className="flex items-center gap-0.5 text-emerald-400"
      title={`Session cost: $${cost.toFixed(4)}`}
    >
      <DollarSign size={12} />
      <span>{formatCost(cost)}</span>
    </span>
  );
}
