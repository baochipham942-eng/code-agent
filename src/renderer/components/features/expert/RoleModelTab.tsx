// ============================================================================
// RoleModelTab - 专家详情「模型」页
// ============================================================================
// 两层：上层「智能选择」三档（跨厂商，稳），下层「指定具体模型」（只列用户
// 真配了 key 的模型，与输入框的模型切换同一份取数逻辑）。留空即跟随档位。

import React, { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import type { AgentEngineDescriptor, AgentEngineKind } from '@shared/contract/agentEngine';
import type { RolePanelDetail } from '@shared/contract/roleAssets';
import { listExternalEngineManifests } from '@shared/externalEngineManifest';
import { buildRuntimeModelOptions, groupRuntimeModelOptionsByProvider } from '@shared/modelRuntime';
import { useI18n } from '../../../hooks/useI18n';
import { SettingsSection } from '../settings/SettingsLayout';

type Equipment = NonNullable<RolePanelDetail['equipment']>;
type Tier = Equipment['model'];
type ModelOverride = { provider: string; model: string };

const TIERS: Tier[] = ['fast', 'balanced', 'powerful'];

/** 可当子代理引擎的选项：manifest 顺序，native 在最前。显示名只取 manifest label。 */
const ENGINE_OPTIONS: ReadonlyArray<{ kind: AgentEngineKind; label: string }> = listExternalEngineManifests()
  .filter((manifest) => manifest.kind && manifest.capabilities.includes('execute'))
  .map((manifest) => ({ kind: manifest.kind as AgentEngineKind, label: manifest.label }));

interface RoleModelTabProps {
  equipment: Equipment;
  busy?: boolean;
  onSave: (next: { model: Tier; modelOverride: ModelOverride | null; engine?: AgentEngineKind }) => Promise<void>;
}

export const RoleModelTab: React.FC<RoleModelTabProps> = ({ equipment, busy, onSave }) => {
  const { t } = useI18n();
  const text = t.expert.roleModel;
  const [tier, setTier] = useState<Tier>(equipment.model);
  const [override, setOverride] = useState<ModelOverride | null>(equipment.modelOverride ?? null);
  const [engine, setEngine] = useState<AgentEngineKind>(equipment.engine ?? 'native');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // null = 还没拿到/获取失败（fail-closed：除 native 外一律不可选）。
  const [engineDescriptors, setEngineDescriptors] = useState<AgentEngineDescriptor[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.domainAPI?.invoke<AppSettings>(IPC_DOMAINS.SETTINGS, 'get', {})
      .then((res) => { if (res?.success && res.data) setSettings(res.data); })
      .catch(() => { /* 读不到设置就只显示档位，指定模型区留空态 */ });
  }, []);

  useEffect(() => {
    window.domainAPI?.invoke<AgentEngineDescriptor[]>(IPC_DOMAINS.AGENT_ENGINE, 'list', {})
      .then((res) => { if (res?.success && Array.isArray(res.data)) setEngineDescriptors(res.data); })
      .catch(() => { /* 取不到就保持 null，外部引擎全部灰显「状态未知」 */ });
  }, []);

  const groups = useMemo(
    () => groupRuntimeModelOptionsByProvider(buildRuntimeModelOptions(settings)),
    [settings],
  );

  /** 就绪判定只看描述符字段，不按引擎名枚举；任何一环缺失都 fail-closed。 */
  const engineAvailability = (kind: AgentEngineKind): { selectable: boolean; reason: string | null } => {
    if (kind === 'native') return { selectable: true, reason: null };
    const descriptor = engineDescriptors?.find((item) => item.kind === kind);
    if (!descriptor) return { selectable: false, reason: text.engineReason.unknown };
    if (descriptor.executable && descriptor.installState !== 'missing' && descriptor.runtimeState === 'ready') {
      return { selectable: true, reason: null };
    }
    if (descriptor.installState === 'missing') return { selectable: false, reason: text.engineReason.missing };
    if (descriptor.runtimeState === 'not_configured') return { selectable: false, reason: text.engineReason.notConfigured };
    const firstLine = descriptor.lastError?.split(/\r?\n/)[0]?.trim();
    return { selectable: false, reason: firstLine || text.engineReason.unavailable };
  };

  const commit = async (next: { model: Tier; modelOverride: ModelOverride | null; engine?: AgentEngineKind }) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setTier(next.model);
      setOverride(next.modelOverride);
      if (next.engine) setEngine(next.engine);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const disabled = Boolean(busy) || saving;

  return (
    <section data-testid="role-detail-model-tab" className="space-y-6">
      <SettingsSection title={text.engineTitle} description={text.engineDescription}>
        <div className="space-y-2" data-testid="role-model-engine">
          {ENGINE_OPTIONS.map((option) => {
            const selected = engine === option.kind;
            const availability = engineAvailability(option.kind);
            const optionDisabled = disabled || !availability.selectable;
            return (
              <button /* ds-allow:button: 引擎单选卡，与档位卡同一形状 */
                key={option.kind}
                type="button"
                disabled={optionDisabled}
                data-testid={`role-model-engine-${option.kind}`}
                aria-pressed={selected}
                onClick={() => void commit({ model: tier, modelOverride: override, engine: option.kind })}
                className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${selected ? 'border-badge-success/70 bg-emerald-900/20' : 'border-zinc-700/70 bg-zinc-900/40 hover:border-zinc-500'} ${optionDisabled ? 'opacity-60' : ''}`}
              >
                <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-badge-success' : 'border-zinc-600'}`}>
                  {selected ? <div className="h-2 w-2 rounded-full bg-emerald-500" /> : null}
                </div>
                <div className="min-w-0">
                  <div className={`text-sm ${selected ? 'text-badge-success' : 'text-zinc-300'}`}>
                    {option.kind === 'native' ? text.engineNative : option.label}
                    {availability.reason ? <span className="text-zinc-500"> · {availability.reason}</span> : null}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-zinc-500">{text.engineHelp}</p>
      </SettingsSection>

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
                className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${selected ? 'border-badge-success/70 bg-emerald-900/20' : 'border-zinc-700/70 bg-zinc-900/40 hover:border-zinc-500'} ${disabled ? 'opacity-60' : ''}`}
              >
                <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-badge-success' : 'border-zinc-600'}`}>
                  {selected ? <div className="h-2 w-2 rounded-full bg-emerald-500" /> : null}
                </div>
                <div className="min-w-0">
                  <div className={`text-sm ${selected ? 'text-badge-success' : 'text-zinc-300'}`}>{text.tiers[key].label}</div>
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
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${selected ? 'bg-emerald-900/25 text-badge-success' : 'text-zinc-300 hover:bg-zinc-800/60'} ${disabled ? 'opacity-60' : ''}`}
                      >
                        <Check className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-badge-success' : 'text-transparent'}`} />
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

      {error ? <div className="text-xs text-badge-danger">{error}</div> : null}
    </section>
  );
};
