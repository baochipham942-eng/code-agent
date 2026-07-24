// ============================================================================
// RoleModelTab - 专家详情「模型」页
// ============================================================================
// 两层：上层「智能选择」三档（跨厂商，稳），下层「指定具体模型」（只列用户
// 真配了 key 的模型，与输入框的模型切换同一份取数逻辑）。留空即跟随档位。

import React, { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import type { RolePanelDetail } from '@shared/contract/roleAssets';
import { buildRuntimeModelOptions, groupRuntimeModelOptionsByProvider } from '@shared/modelRuntime';
import { useI18n } from '../../../hooks/useI18n';
import { SettingsSection } from '../settings/SettingsLayout';

type Equipment = NonNullable<RolePanelDetail['equipment']>;
type Tier = Equipment['model'];
type ModelOverride = { provider: string; model: string };

const TIERS: Tier[] = ['fast', 'balanced', 'powerful'];

interface RoleModelTabProps {
  equipment: Equipment;
  busy?: boolean;
  onSave: (next: { model: Tier; modelOverride: ModelOverride | null }) => Promise<void>;
}

export const RoleModelTab: React.FC<RoleModelTabProps> = ({ equipment, busy, onSave }) => {
  const { t } = useI18n();
  const text = t.expert.roleModel;
  const [tier, setTier] = useState<Tier>(equipment.model);
  const [override, setOverride] = useState<ModelOverride | null>(equipment.modelOverride ?? null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.domainAPI?.invoke<AppSettings>(IPC_DOMAINS.SETTINGS, 'get', {})
      .then((res) => { if (res?.success && res.data) setSettings(res.data); })
      .catch(() => { /* 读不到设置就只显示档位，指定模型区留空态 */ });
  }, []);

  const groups = useMemo(
    () => groupRuntimeModelOptionsByProvider(buildRuntimeModelOptions(settings)),
    [settings],
  );

  const commit = async (next: { model: Tier; modelOverride: ModelOverride | null }) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setTier(next.model);
      setOverride(next.modelOverride);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const disabled = Boolean(busy) || saving;

  return (
    <section data-testid="role-detail-model-tab" className="space-y-6">
      <SettingsSection title={text.tierTitle} description={text.tierDescription}>
        <div className="space-y-2" data-testid="role-model-tiers">
          {TIERS.map((key) => {
            const selected = !override && tier === key;
            return (
              <button /* ds-allow:button: 档位单选卡，全宽左对齐含单选圈+多行说明 */
                key={key}
                type="button"
                disabled={disabled}
                data-testid={`role-model-tier-${key}`}
                aria-pressed={selected}
                onClick={() => void commit({ model: key, modelOverride: null })}
                className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${selected ? 'border-emerald-600/70 bg-emerald-900/20' : 'border-zinc-700/70 bg-zinc-900/40 hover:border-zinc-500'} ${disabled ? 'opacity-60' : ''}`}
              >
                <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-emerald-500' : 'border-zinc-600'}`}>
                  {selected ? <div className="h-2 w-2 rounded-full bg-emerald-500" /> : null}
                </div>
                <div className="min-w-0">
                  <div className={`text-sm ${selected ? 'text-emerald-300' : 'text-zinc-300'}`}>{text.tiers[key].label}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">{text.tiers[key].hint}</div>
                </div>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title={text.overrideTitle} description={text.overrideDescription}>
        {groups.length === 0 ? (
          <div data-testid="role-model-override-empty" className="rounded-lg border border-dashed border-zinc-700/70 p-4 text-center text-xs text-zinc-500">
            {text.overrideEmpty}
          </div>
        ) : (
          <div className="max-h-96 space-y-3 overflow-y-auto" data-testid="role-model-override-list">
            {groups.map((group) => (
              <div key={group.provider}>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">{group.providerLabel}</div>
                <div className="space-y-1">
                  {group.options.map((option) => {
                    const selected = override?.provider === option.provider && override?.model === option.model;
                    return (
                      <button /* ds-allow:button: 模型行需左对齐紧凑列表样式，primitive 会改变布局 */
                        key={`${option.provider}:${option.model}`}
                        type="button"
                        disabled={disabled}
                        data-testid={`role-model-option-${option.provider}-${option.model}`}
                        aria-pressed={selected}
                        onClick={() => void commit({ model: tier, modelOverride: selected ? null : { provider: option.provider, model: option.model } })}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${selected ? 'bg-emerald-900/25 text-emerald-200' : 'text-zinc-300 hover:bg-zinc-800/60'} ${disabled ? 'opacity-60' : ''}`}
                      >
                        <Check className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-emerald-400' : 'text-transparent'}`} />
                        <span className="truncate">{option.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        {override ? (
          <button /* ds-allow:button: 取消指定是紧凑文本动作 */
            type="button"
            disabled={disabled}
            data-testid="role-model-override-clear"
            onClick={() => void commit({ model: tier, modelOverride: null })}
            className="mt-3 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
          >
            {text.overrideClear}
          </button>
        ) : null}
      </SettingsSection>

      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </section>
  );
};
