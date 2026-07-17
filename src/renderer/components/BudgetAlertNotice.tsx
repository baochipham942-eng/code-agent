// ============================================================================
// BudgetAlertNotice - 预算告警 toast（headless，复用 ProviderStatusNotice 范式）
// ============================================================================
import { useEffect } from 'react';
import { toast } from '../hooks/useToast';
import { ipcService } from '../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import type { BudgetAlertEvent } from '@shared/ipc/handlers';
import { useI18n } from '../hooks/useI18n';
import type { Translations } from '../i18n';

function safeNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatBudgetToast(event: BudgetAlertEvent, t: Translations): string {
  // Codex audit F6：畸形 IPC payload（NaN/undefined）不能让 .toFixed 崩掉 toast handler
  const pct = Math.round(safeNum(event.usagePercentage) * 100);
  const spent = `$${safeNum(event.currentCost).toFixed(2)} / $${safeNum(event.maxBudget).toFixed(2)}`;
  const template = event.level === 'blocked' ? t.notices.budget.blocked : t.notices.budget.warning;
  return template.replace('{pct}', String(pct)).replace('{spent}', spent);
}

/**
 * 订阅 budget:alert 事件并弹 toast。warning→warning toast，blocked→error toast。
 */
export function BudgetAlertNotice(): null {
  const { t } = useI18n();
  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.BUDGET_ALERT, (event: BudgetAlertEvent) => {
      const message = formatBudgetToast(event, t);
      if (event.level === 'blocked') {
        toast.error(message);
      } else {
        toast.warning(message);
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [t]);

  return null;
}
