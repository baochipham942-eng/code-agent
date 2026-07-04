// ============================================================================
// useBudgetStatus - 拉取运行时预算状态供 StatusBar 染色 / 预算 UI 回填
// ============================================================================
import { useEffect, useState } from 'react';
import { invokeDomain } from '../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';

export type BudgetAlertTone = 'none' | 'silent' | 'warning' | 'blocked';

interface CacheSavingsView {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  netSavedUsd: number;
}

interface TokenUsageView {
  /** 非缓存输入 tokens（归一化口径） */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface BudgetStatusView {
  enabled: boolean;
  currentCost: number;
  maxBudget: number;
  /** 0-1 的用量比例 */
  usagePercentage: number;
  alertLevel: BudgetAlertTone;
  /** 缓存节省汇总（cache-aware 记账，WP2-2a） */
  cacheSavings?: CacheSavingsView;
  /** token 用量汇总（WP-2 token 状态栏活值） */
  tokenUsage?: TokenUsageView;
}

interface RawBudgetStatus {
  currentCost?: number;
  maxBudget?: number;
  usagePercentage?: number;
  alertLevel?: string;
  config?: { enabled?: boolean };
  cacheSavings?: { cacheReadTokens?: number; cacheCreationTokens?: number; netSavedUsd?: number };
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

/** 只接受有限非负数，挡住后端异常值（NaN/Infinity/负数）流到 UI（Codex audit F4）。 */
function finiteNonNeg(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function normalizeBudgetStatus(raw: RawBudgetStatus | null): BudgetStatusView | null {
  if (!raw) return null;
  const level = raw.alertLevel;
  const alertLevel: BudgetAlertTone =
    level === 'silent' || level === 'warning' || level === 'blocked' ? level : 'none';
  return {
    enabled: raw.config?.enabled ?? false,
    currentCost: finiteNonNeg(raw.currentCost),
    maxBudget: finiteNonNeg(raw.maxBudget),
    // 用量比例钳到 [0, 10]（>1000% 无意义，挡住 Infinity 渲染垃圾）
    usagePercentage: Math.min(finiteNonNeg(raw.usagePercentage), 10),
    alertLevel,
    ...(raw.cacheSavings
      ? {
          cacheSavings: {
            cacheReadTokens: finiteNonNeg(raw.cacheSavings.cacheReadTokens),
            cacheCreationTokens: finiteNonNeg(raw.cacheSavings.cacheCreationTokens),
            netSavedUsd: finiteNonNeg(raw.cacheSavings.netSavedUsd),
          },
        }
      : {}),
    ...(raw.tokenUsage
      ? {
          tokenUsage: {
            inputTokens: finiteNonNeg(raw.tokenUsage.inputTokens),
            outputTokens: finiteNonNeg(raw.tokenUsage.outputTokens),
            cacheReadTokens: finiteNonNeg(raw.tokenUsage.cacheReadTokens),
            cacheCreationTokens: finiteNonNeg(raw.tokenUsage.cacheCreationTokens),
          },
        }
      : {}),
  };
}

/**
 * 拉取预算状态。cost 变化（会话累计成本前进）或流式结束（refreshSignal 翻转）时重新拉，
 * 保证染色与成本数字随真实记账（host 侧 cache-aware 口径）更新。
 * IPC 不可用 / 出错时返回 null（StatusBar 退回不染色）。
 */
export function useBudgetStatus(cost: number, refreshSignal?: boolean): BudgetStatusView | null {
  const [status, setStatus] = useState<BudgetStatusView | null>(null);

  useEffect(() => {
    let cancelled = false;
    invokeDomain<RawBudgetStatus>(IPC_DOMAINS.SETTINGS, 'getBudgetStatus')
      .then((raw) => {
        if (!cancelled) setStatus(normalizeBudgetStatus(raw));
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cost, refreshSignal]);

  return status;
}
