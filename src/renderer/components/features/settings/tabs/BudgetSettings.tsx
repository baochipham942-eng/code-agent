// ============================================================================
// BudgetSettings - 预算告警设置（上限 / 阈值 / 周期）
// ============================================================================
import React, { useEffect, useState } from 'react';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import { invokeDomain } from '../../../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';
import { toast } from '../../../../hooks/useToast';

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

export function BudgetSettings() {
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
        if (!cancelled) toast.error('加载预算设置失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await invokeDomain(IPC_DOMAINS.SETTINGS, 'setBudgetConfig', { budget: form });
      toast.success('预算设置已保存');
    } catch (error) {
      toast.error(`保存预算设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-xs text-zinc-500">加载中…</div>;
  }

  const inputClass =
    'w-32 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:border-sky-500 focus:outline-none';

  return (
    <SettingsPage
      title="预算告警"
      description="设定费用上限和告警阈值。预算为事后记账有滞后，定位为「逼近预警」而非硬性即时拦截。"
    >
      <SettingsSection title="启用预算告警" description="关闭时不做任何费用监控与染色。">
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
          />
          启用
        </label>
      </SettingsSection>

      <SettingsSection title="费用上限" description="单个周期内的最大费用（美元）。">
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          上限 $
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
          重置周期（小时）
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

      <SettingsSection title="告警阈值" description="到达警告阈值时 StatusBar 染琥珀，到达拦截阈值染红并提示。">
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          警告阈值 %
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
          拦截阈值 %
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
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </SettingsPage>
  );
}
