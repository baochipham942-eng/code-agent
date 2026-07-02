// ============================================================================
// CostDisplay - 显示累计费用 + 预算用量染色（cache-aware 口径，WP2-2a）
// ============================================================================

import React from 'react';
import { DollarSign } from 'lucide-react';
import type { CostDisplayProps } from './types';
import type { BudgetAlertTone, BudgetStatusView } from '../../hooks/useBudgetStatus';
import { useI18n } from '../../hooks/useI18n';
import type { Translations } from '../../i18n';

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

/**
 * 展示成本取 host 侧真实记账（cache-aware）与 renderer 累计的较大者。
 * 纯函数便于单测。
 */
export function resolveDisplayCost(cost: number, budget?: BudgetStatusView | null): number {
  return Math.max(cost, budget?.currentCost ?? 0);
}

/** 构建 tooltip 文案（含缓存节省行，净省 <$0.005 不显示）。纯函数便于单测。 */
export function buildCostTitle(
  t: Translations['statusBar'],
  cost: number,
  budget?: BudgetStatusView | null,
): string {
  const base = budget?.enabled
    ? t.budgetUsageTitle
        .replace('{cost}', `$${cost.toFixed(2)}`)
        .replace('{max}', `$${budget.maxBudget.toFixed(2)}`)
        .replace('{percent}', String(Math.round(budget.usagePercentage * 100)))
    : t.sessionCostTitle.replace('{cost}', `$${cost.toFixed(4)}`);
  const saved = budget?.cacheSavings?.netSavedUsd ?? 0;
  if (saved >= 0.005) {
    return `${base}\n${t.cacheSavedLine.replace('{saved}', `$${saved.toFixed(2)}`)}`;
  }
  return base;
}

export function CostDisplay({ cost, isStreaming, budget }: CostDisplayProps) {
  const { t } = useI18n();
  const colorClass = budgetCostColorClass(budget?.enabled ? budget.alertLevel : undefined);
  const displayCost = resolveDisplayCost(cost, budget);
  const title = buildCostTitle(t.statusBar, displayCost, budget);

  return (
    <span
      className={`flex items-center gap-0.5 ${colorClass} ${isStreaming ? 'animate-pulse' : ''}`}
      title={title}
    >
      <DollarSign size={12} />
      <span>{formatCost(displayCost)}</span>
      {budget?.enabled && budget.maxBudget > 0 && (
        <span className="opacity-70">/ ${budget.maxBudget.toFixed(0)}</span>
      )}
    </span>
  );
}
