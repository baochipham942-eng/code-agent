// ============================================================================
// useBudgetStatus - 拉取运行时预算状态供 StatusBar 染色 / 预算 UI 回填
// ============================================================================
import { useEffect, useState } from 'react';
import { invokeDomain } from '../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';

export type BudgetAlertTone = 'none' | 'silent' | 'warning' | 'blocked';

export interface BudgetStatusView {
  enabled: boolean;
  currentCost: number;
  maxBudget: number;
  /** 0-1 的用量比例 */
  usagePercentage: number;
  alertLevel: BudgetAlertTone;
}

interface RawBudgetStatus {
  currentCost?: number;
  maxBudget?: number;
  usagePercentage?: number;
  alertLevel?: string;
  config?: { enabled?: boolean };
}

function normalize(raw: RawBudgetStatus | null): BudgetStatusView | null {
  if (!raw) return null;
  const level = raw.alertLevel;
  const alertLevel: BudgetAlertTone =
    level === 'silent' || level === 'warning' || level === 'blocked' ? level : 'none';
  return {
    enabled: raw.config?.enabled ?? false,
    currentCost: raw.currentCost ?? 0,
    maxBudget: raw.maxBudget ?? 0,
    usagePercentage: raw.usagePercentage ?? 0,
    alertLevel,
  };
}

/**
 * 拉取预算状态。cost 变化（会话累计成本前进）时重新拉，保证染色随用量更新。
 * IPC 不可用 / 出错时返回 null（StatusBar 退回不染色）。
 */
export function useBudgetStatus(cost: number): BudgetStatusView | null {
  const [status, setStatus] = useState<BudgetStatusView | null>(null);

  useEffect(() => {
    let cancelled = false;
    invokeDomain<RawBudgetStatus>(IPC_DOMAINS.SETTINGS, 'getBudgetStatus')
      .then((raw) => {
        if (!cancelled) setStatus(normalize(raw));
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cost]);

  return status;
}
