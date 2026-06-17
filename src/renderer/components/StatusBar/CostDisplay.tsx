// ============================================================================
// CostDisplay - 显示累计费用 + 预算用量染色
// ============================================================================

import React from 'react';
import { DollarSign } from 'lucide-react';
import type { CostDisplayProps } from './types';
import type { BudgetAlertTone } from '../../hooks/useBudgetStatus';

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

/**
 * 按预算告警级别决定染色。纯函数便于单测。
 * - blocked (>=100%) → 红
 * - warning (85-90%) → 琥珀
 * - 其余（含未启用/低用量）→ 默认 emerald
 */
export function budgetCostColorClass(alertLevel?: BudgetAlertTone): string {
  switch (alertLevel) {
    case 'blocked':
      return 'text-red-400';
    case 'warning':
      return 'text-amber-400';
    default:
      return 'text-emerald-400';
  }
}

export function CostDisplay({ cost, isStreaming, budget }: CostDisplayProps) {
  const colorClass = budgetCostColorClass(budget?.enabled ? budget.alertLevel : undefined);

  // 启用预算时，tooltip 显示 用量/上限 (百分比)；否则只显累计成本
  const title = budget?.enabled
    ? `预算用量: $${cost.toFixed(2)} / $${budget.maxBudget.toFixed(2)} (${Math.round(budget.usagePercentage * 100)}%)`
    : `Session cost: $${cost.toFixed(4)}`;

  return (
    <span
      className={`flex items-center gap-0.5 ${colorClass} ${isStreaming ? 'animate-pulse' : ''}`}
      title={title}
    >
      <DollarSign size={12} />
      <span>{formatCost(cost)}</span>
      {budget?.enabled && budget.maxBudget > 0 && (
        <span className="opacity-70">/ ${budget.maxBudget.toFixed(0)}</span>
      )}
    </span>
  );
}
