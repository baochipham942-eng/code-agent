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
import { openBudgetSettings } from '../utils/budgetSettingsNavigation';

function safeNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatResetTime(value: unknown, fallback: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatBudgetToast(event: BudgetAlertEvent, t: Translations): string {
  // Codex audit F6：畸形 IPC payload（NaN/undefined）不能让 .toFixed 崩掉 toast handler
  const pct = Math.round(safeNum(event.usagePercentage) * 100);
  const spent = `$${safeNum(event.currentCost).toFixed(2)} / $${safeNum(event.maxBudget).toFixed(2)}`;
  const text = t.notices.budget;
  const scope = event.scope === 'unattended' ? text.unattendedScope : text.foregroundScope;
  const impact = event.scope === 'unattended' ? text.unattendedImpact : text.foregroundImpact;
  const template = event.level === 'blocked' ? text.blocked : text.warning;
  return template
    .replace('{scope}', scope)
    .replace('{impact}', impact)
    .replace('{pct}', String(pct))
    .replace('{spent}', spent)
    .replace('{resetAt}', formatResetTime(event.resetTime, text.resetUnknown));
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
        toast.error(message, {
          label: t.notices.budget.settingsAction,
          onClick: openBudgetSettings,
        });
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
