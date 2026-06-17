// ============================================================================
// BudgetAlertNotice - 预算告警 toast（headless，复用 ProviderStatusNotice 范式）
// ============================================================================
import { useEffect } from 'react';
import { toast } from '../hooks/useToast';
import { ipcService } from '../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import type { BudgetAlertEvent } from '@shared/ipc/handlers';

function safeNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatBudgetToast(event: BudgetAlertEvent): string {
  // Codex audit F6：畸形 IPC payload（NaN/undefined）不能让 .toFixed 崩掉 toast handler
  const pct = Math.round(safeNum(event.usagePercentage) * 100);
  const spent = `$${safeNum(event.currentCost).toFixed(2)} / $${safeNum(event.maxBudget).toFixed(2)}`;
  return event.level === 'blocked'
    ? `预算已超限（${pct}%，${spent}）。建议收窄任务范围或调高上限。`
    : `预算逼近上限（${pct}%，${spent}）。`;
}

/**
 * 订阅 budget:alert 事件并弹 toast。warning→warning toast，blocked→error toast。
 */
export function BudgetAlertNotice(): null {
  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.BUDGET_ALERT, (event: BudgetAlertEvent) => {
      const message = formatBudgetToast(event);
      if (event.level === 'blocked') {
        toast.error(message);
      } else {
        toast.warning(message);
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  return null;
}
