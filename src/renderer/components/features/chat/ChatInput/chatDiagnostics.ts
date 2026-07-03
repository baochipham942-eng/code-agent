// ============================================================================
// /status //cost 诊断命令的数据拉取与文本构建（从 SlashCommandPopover 平移）
// ============================================================================
// 数据源：host 真实记账（settings domain getBudgetStatus，WP-2 token 状态栏活值）。
// statusStore 的 token 推送通道已死，这里不读 statusStore。

import { invokeDomain } from '../../../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';

// 诊断命令格式化 helper（与 newCommands.ts 的 CLI 版对齐）
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(n: number): string {
  return `$${n.toFixed(3)}`;
}

export interface BudgetStatusRaw {
  currentCost?: number;
  maxBudget?: number;
  usagePercentage?: number;
  config?: { enabled?: boolean };
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

async function fetchBudgetStatus(): Promise<BudgetStatusRaw | null> {
  try {
    return await invokeDomain<BudgetStatusRaw>(IPC_DOMAINS.SETTINGS, 'getBudgetStatus');
  } catch {
    return null;
  }
}

/** input 显示口径 = 非缓存输入 + 缓存读 + 缓存写（与 provider 报告的提交总量对齐） */
function totalInputTokens(usage: BudgetStatusRaw['tokenUsage']): number {
  return (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheCreationTokens ?? 0);
}

export async function buildStatusText(): Promise<string> {
  const app = useAppStore.getState();
  const sessionId = useSessionStore.getState().currentSessionId ?? 'N/A';
  const health = app.contextHealth;
  const contextLine = health && health.currentTokens > 0
    ? `\n  Context:  ${health.usagePercent.toFixed(1)}% (~${health.estimatedTurnsRemaining} turns remaining)`
    : '';
  let tokenLine = 'N/A';
  let costLine = '';
  const budget = await fetchBudgetStatus();
  if (budget) {
    const total = totalInputTokens(budget.tokenUsage) + (budget.tokenUsage?.outputTokens ?? 0);
    if (total > 0) tokenLine = fmtTokens(total);
    if ((budget.currentCost ?? 0) > 0) costLine = ` (${fmtCost(budget.currentCost!)})`;
  }
  return (
    `Status\n` +
    `  Model:    ${app.modelConfig.provider}/${app.modelConfig.model}\n` +
    `  Session:  ${sessionId}\n` +
    `  Tokens:   ${tokenLine}${costLine}${contextLine}`
  );
}

export async function buildCostText(): Promise<string> {
  const app = useAppStore.getState();
  // 口径：BudgetService 是全局预算周期账本（与状态栏 CostDisplay 同源），不是单会话
  const lines = [
    'Cost (budget period)',
    `  Model:    ${app.modelConfig.provider}/${app.modelConfig.model}`,
  ];
  const budget = await fetchBudgetStatus();
  if (!budget) {
    lines.push('  (cost data unavailable)');
    return lines.join('\n');
  }
  const usage = budget.tokenUsage;
  lines.push(`  Input:    ${fmtTokens(totalInputTokens(usage))} tokens`);
  lines.push(`  Output:   ${fmtTokens(usage?.outputTokens ?? 0)} tokens`);
  if ((usage?.cacheReadTokens ?? 0) > 0) {
    lines.push(`  Cached:   ${fmtTokens(usage!.cacheReadTokens!)} tokens (read)`);
  }
  // Total 用 host cache-aware 真实记账，不再用单价×token 的本地估算
  lines.push(`  Total:    ${fmtCost(budget.currentCost ?? 0)}`);
  if (budget.config?.enabled && (budget.maxBudget ?? 0) > 0) {
    lines.push(
      `  Budget:   ${fmtCost(budget.currentCost ?? 0)} / ${fmtCost(budget.maxBudget!)} (${((budget.usagePercentage ?? 0) * 100).toFixed(1)}%)`,
    );
  }
  return lines.join('\n');
}
