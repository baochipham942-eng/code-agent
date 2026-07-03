// ============================================================================
// BudgetSettings - 预算告警设置（上限 / 阈值 / 周期）
// ============================================================================
import React, { useEffect, useState } from 'react';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import { invokeDomain } from '../../../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';

interface BudgetForm {
  enabled: boolean;
  maxBudget: number;
  warningThreshold: number; // 0-1
  blockThreshold: number; // 0-1
  resetPeriodHours: number;
}

const DEFAULT_FORM: BudgetForm = {
  enabled: false,
  maxBudget: 10,
  warningThreshold: 0.85,
  blockThreshold: 1.0,
  resetPeriodHours: 24,
};

/**
 * 保存前清洗，挡住无意义/倒置配置（Codex audit F5）：
 * - maxBudget 至少 0.01（0/负数会让用量比例恒为 0、永不告警）
 * - 阈值钳到 [0,N]，且拦截阈值不得低于警告阈值（否则"先 block 后 warn"语义倒置）
 * - 重置周期至少 1 小时
 */
export function sanitizeBudgetForm(form: BudgetForm): BudgetForm {
  const maxBudget = Math.max(0.01, Number.isFinite(form.maxBudget) ? form.maxBudget : DEFAULT_FORM.maxBudget);
  const warningThreshold = Math.min(Math.max(Number.isFinite(form.warningThreshold) ? form.warningThreshold : 0.85, 0), 1);
  const blockThresholdRaw = Math.max(Number.isFinite(form.blockThreshold) ? form.blockThreshold : 1, 0);
  const blockThreshold = Math.max(blockThresholdRaw, warningThreshold);
  const resetPeriodHours = Math.max(1, Math.floor(Number.isFinite(form.resetPeriodHours) ? form.resetPeriodHours : 24));
  return { enabled: form.enabled, maxBudget, warningThreshold, blockThreshold, resetPeriodHours };
}

export function BudgetSettings() {
  const { t } = useI18n();
  const budgetText = t.settings.budget;
  const [form, setForm] = useState<BudgetForm>(DEFAULT_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invokeDomain<{ config?: Partial<BudgetForm> }>(IPC_DOMAINS.SETTINGS, 'getBudgetStatus')
      .then((status) => {
        if (cancelled) return;
        const cfg = status?.config;
        if (cfg) {
          setForm({
            enabled: cfg.enabled ?? DEFAULT_FORM.enabled,
            maxBudget: cfg.maxBudget ?? DEFAULT_FORM.maxBudget,
            warningThreshold: cfg.warningThreshold ?? DEFAULT_FORM.warningThreshold,
            blockThreshold: cfg.blockThreshold ?? DEFAULT_FORM.blockThreshold,
            resetPeriodHours: cfg.resetPeriodHours ?? DEFAULT_FORM.resetPeriodHours,
          });
        }
      })
      .catch(() => {
        if (!cancelled) toast.error(budgetText.loadFailed);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [budgetText.loadFailed]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const sanitized = sanitizeBudgetForm(form);
      setForm(sanitized); // 回填清洗后的值，让用户看到被纠正的输入
      await invokeDomain(IPC_DOMAINS.SETTINGS, 'setBudgetConfig', { budget: sanitized });
      toast.success(budgetText.saveSuccess);
    } catch (error) {
      toast.error(`${budgetText.saveFailedPrefix}${error instanceof Error ? error.message : budgetText.unknownError}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-xs text-zinc-500">{budgetText.loading}</div>;
  }

  const inputClass =
    'w-32 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:border-sky-500 focus:outline-none';

  return (
    <SettingsPage
      title={budgetText.title}
      description={budgetText.description}
    >
      <SettingsSection title={budgetText.enableTitle} description={budgetText.enableDescription}>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
          />
          {budgetText.enabledLabel}
        </label>
      </SettingsSection>

      <SettingsSection title={budgetText.limitTitle} description={budgetText.limitDescription}>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          {budgetText.maxBudgetLabel}
          <input
            type="number"
            min={0}
            step={1}
            value={form.maxBudget}
            disabled={!form.enabled}
            onChange={(e) => setForm((f) => ({ ...f, maxBudget: Math.max(0, Number(e.target.value) || 0) }))}
            className={inputClass}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          {budgetText.resetPeriodLabel}
          <input
            type="number"
            min={1}
            step={1}
            value={form.resetPeriodHours}
            disabled={!form.enabled}
            onChange={(e) => setForm((f) => ({ ...f, resetPeriodHours: Math.max(1, Number(e.target.value) || 1) }))}
            className={inputClass}
          />
        </label>
      </SettingsSection>

      <SettingsSection title={budgetText.thresholdsTitle} description={budgetText.thresholdsDescription}>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          {budgetText.warningThresholdLabel}
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={Math.round(form.warningThreshold * 100)}
            disabled={!form.enabled}
            onChange={(e) =>
              setForm((f) => ({ ...f, warningThreshold: Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)) }))
            }
            className={inputClass}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          {budgetText.blockThresholdLabel}
          <input
            type="number"
            min={0}
            max={200}
            step={1}
            value={Math.round(form.blockThreshold * 100)}
            disabled={!form.enabled}
            onChange={(e) =>
              setForm((f) => ({ ...f, blockThreshold: Math.max(0, (Number(e.target.value) || 0) / 100) }))
            }
            className={inputClass}
          />
        </label>
      </SettingsSection>

      <div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-100 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
        >
          {saving ? budgetText.saving : budgetText.save}
        </button>
      </div>
    </SettingsPage>
  );
}
