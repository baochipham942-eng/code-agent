import React, { useEffect, useMemo } from 'react';
import { Brain } from 'lucide-react';
import type {
  AppSettings,
  ModelConfig,
  ModelProvider,
  ModelProviderSettings,
  TaskModelStrategySettings,
  TaskStrategyProfileId,
} from '@shared/contract';
import { PROVIDER_MODELS } from '@shared/constants';
import { buildRuntimeModelOptions } from '@shared/modelRuntime';
import { Button, Select, Toggle } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';

// 自动模式下四档都要可见可改：代码/文件/产物任务运行时走 profiles.main（modelDecision.applyStrategySlot），
// 它不跟随默认模型，藏起来就是一个看不见、改不了却在生效的配置。
// 主模型与另三档一样自愈：指向不可用模型时运行时本来就会失败，回到默认模型不冤枉；
// 记忆整理不同，它的「不可用」可能只是中转站提供了目录外模型，所以只提示不改写。
const AUTO_PROFILES: TaskStrategyProfileId[] = ['main', 'fast', 'deep', 'vision'];

function optionValue(provider: string, model: string): string {
  return `${provider}:::${model}`;
}

function parseOptionValue(value: string): { provider: ModelProvider; model: string } | null {
  const [provider, ...modelParts] = value.split(':::');
  const model = modelParts.join(':::');
  if (!provider || !model) return null;
  return { provider: provider as ModelProvider, model };
}

function modelLabel(provider: string, model: string): string {
  return `${provider}/${model}`;
}

// 记忆整理模型 Select 的「跟随快速模型」哨兵值：选中即清除 routing.memory 覆盖。
const FOLLOW_FAST_VALUE = '__follow_fast__';

export interface TaskStrategySettingsPanelProps {
  settings: AppSettings | null;
  providerConfigs: Partial<Record<string, ModelProviderSettings>>;
  config: ModelConfig;
  strategy: TaskModelStrategySettings | null;
  disabled?: boolean;
  /** 改动即存：开关 / 四档模型修改后立即调用持久化 */
  onChange: (strategy: TaskModelStrategySettings) => void;
  /** 记忆整理只有这一处配置入口；传 null 清除覆盖、回到跟随 routing.fast。 */
  onMemoryRouteChange: (route: { provider: ModelProvider; model: string } | null) => void;
}

export const TaskStrategySettingsPanel: React.FC<TaskStrategySettingsPanelProps> = ({
  settings,
  providerConfigs,
  config,
  strategy,
  disabled,
  onChange,
  onMemoryRouteChange,
}) => {
  const { t } = useI18n();
  const strategyText = t.settings.model.taskStrategy;
  const effectiveSettings = useMemo<AppSettings | null>(() => {
    if (!settings) return null;
    const providers = Object.fromEntries(
      Object.entries(providerConfigs).filter((entry): entry is [string, ModelProviderSettings] => Boolean(entry[1])),
    );
    return {
      ...settings,
      models: {
        ...settings.models,
        providers,
        ...(strategy ? { taskStrategy: strategy } : {}),
      },
    };
  }, [providerConfigs, settings, strategy]);

  const memoryRoute = settings?.models.routing.memory;
  const effectiveMemoryRoute = memoryRoute ?? settings?.models.routing.fast;
  const profileProviders = useMemo(
    () => [
      ...(strategy ? Object.values(strategy.profiles).map((slot) => slot.provider) : []),
      ...(effectiveMemoryRoute ? [effectiveMemoryRoute.provider] : []),
    ],
    [effectiveMemoryRoute, strategy],
  );

  const modelOptions = useMemo(() => buildRuntimeModelOptions(
    effectiveSettings,
    PROVIDER_MODELS.map((provider) => provider.id),
    { includeDisabledProviders: Array.from(new Set([...profileProviders, config.provider])), dedupeProviderGroups: false },
  ), [config.provider, effectiveSettings, profileProviders]);

  // 按 Provider 分组（optgroup）：避免所有已配模型平铺成一长串，effort 噪音靠分组收敛。
  const groupedOptions = useMemo(() => {
    const groups = new Map<string, { label: string; options: typeof modelOptions }>();
    for (const option of modelOptions) {
      const key = option.providerLabel || option.provider;
      const group = groups.get(key) ?? { label: key, options: [] as typeof modelOptions };
      group.options.push(option);
      groups.set(key, group);
    }
    return Array.from(groups.values());
  }, [modelOptions]);

  // 自愈：开启自动切换时，若某档位指向不可用模型，回退到当前默认模型（消除「不可用」）。
  useEffect(() => {
    if (strategy?.mode !== 'auto') return;
    const available = new Set(modelOptions.map((option) => optionValue(option.provider, option.model)));
    const fallback = optionValue(config.provider, config.model);
    if (!available.has(fallback)) return;
    let changed = false;
    const profiles = { ...strategy.profiles };
    for (const profile of AUTO_PROFILES) {
      const slot = strategy.profiles[profile];
      if (!available.has(optionValue(slot.provider, slot.model))) {
        profiles[profile] = { ...slot, provider: config.provider, model: config.model };
        changed = true;
      }
    }
    if (changed) onChange({ ...strategy, profiles });
  }, [strategy, modelOptions, config.provider, config.model, onChange]);

  if (!strategy) {
    return <div className="text-sm text-zinc-500">{strategyText.loading}</div>;
  }

  const patchStrategy = (patch: Partial<TaskModelStrategySettings>) => {
    onChange({ ...strategy, ...patch });
  };

  const patchProfile = (profile: TaskStrategyProfileId, patch: Partial<TaskModelStrategySettings['profiles'][TaskStrategyProfileId]>) => {
    onChange({
      ...strategy,
      profiles: {
        ...strategy.profiles,
        [profile]: {
          ...strategy.profiles[profile],
          ...patch,
        },
      },
    });
  };

  const selectedOptionSet = new Set(modelOptions.map((option) => optionValue(option.provider, option.model)));
  // 记忆整理不自愈（用户显式选过的路由不静默改写），但要说清原因并给一键回到跟随快速模型。
  const memoryRouteUnavailable = Boolean(memoryRoute && !selectedOptionSet.has(optionValue(memoryRoute.provider, memoryRoute.model)));
  return (
    <div className="space-y-4">
      <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            {strategyText.toggleTitle}
            {/* 本面板改动即存（persistTaskStrategy 立即落盘），与下方 staged Provider 表单区分 */}
            <span className="shrink-0 rounded border border-badge-success/30 bg-badge-success px-1 text-[10px] font-normal text-badge-success">
              {strategyText.autoSaveBadge}
            </span>
          </span>
          <span className="block text-xs text-zinc-500">{strategyText.toggleDescription}</span>
        </span>
        <Toggle
          checked={strategy.mode === 'auto'}
          onChange={(checked) => patchStrategy({ mode: checked ? 'auto' : 'manual' })}
          disabled={disabled}
          aria-label={strategyText.toggleAriaLabel}
        />
      </label>

      {strategy.mode === 'auto' && (
        <div className="grid gap-2 sm:grid-cols-2">
          {AUTO_PROFILES.map((profile) => {
            const slot = strategy.profiles[profile];
            const value = optionValue(slot.provider, slot.model);
            const unavailable = !selectedOptionSet.has(value);
            return (
              <div key={profile} className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
                  <Brain className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  <span className="truncate">{strategyText.profiles[profile].label}</span>
                  {unavailable ? (
                    <span className="shrink-0 rounded border border-badge-warning/30 bg-badge-warning px-1 text-[10px] text-badge-warning">
                      {strategyText.unavailableBadge}
                    </span>
                  ) : null}
                </div>
                <Select
                  value={value}
                  onChange={(event) => {
                    const parsed = parseOptionValue(event.target.value);
                    if (parsed) patchProfile(profile, parsed);
                  }}
                  disabled={disabled}
                  className="w-full"
                >
                  {unavailable ? <option value={value}>{modelLabel(slot.provider, slot.model)}{strategyText.unavailableSuffix}</option> : null}
                  {groupedOptions.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((option) => (
                        <option key={optionValue(option.provider, option.model)} value={optionValue(option.provider, option.model)}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </div>
            );
          })}
        </div>
      )}

      {effectiveMemoryRoute ? (
        <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
            <Brain className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span>{strategyText.memory.label}</span>
          </div>
          <p className="text-xs text-zinc-500">{strategyText.memory.description}</p>
          <Select
            value={memoryRoute ? optionValue(memoryRoute.provider, memoryRoute.model) : FOLLOW_FAST_VALUE}
            onChange={(event) => {
              if (event.target.value === FOLLOW_FAST_VALUE) {
                onMemoryRouteChange(null);
                return;
              }
              const parsed = parseOptionValue(event.target.value);
              if (parsed) onMemoryRouteChange(parsed);
            }}
            disabled={disabled}
            className="w-full"
            aria-label={strategyText.memory.label}
          >
            <option value={FOLLOW_FAST_VALUE}>{strategyText.memory.followFast}</option>
            {memoryRoute && memoryRouteUnavailable ? (
              <option value={optionValue(memoryRoute.provider, memoryRoute.model)}>
                {modelLabel(memoryRoute.provider, memoryRoute.model)}{strategyText.unavailableSuffix}
              </option>
            ) : null}
            {groupedOptions.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={optionValue(option.provider, option.model)} value={optionValue(option.provider, option.model)}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          {memoryRouteUnavailable ? (
            <div data-testid="memory-route-unavailable" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-badge-warning/30 bg-badge-warning px-2.5 py-2">
              <p className="min-w-0 flex-1 text-xs text-badge-warning">{strategyText.memory.unavailableHint}</p>
              <Button size="sm" variant="secondary" onClick={() => onMemoryRouteChange(null)} disabled={disabled}>
                {strategyText.memory.resetToFollowFast}
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-badge-warning/90">{strategyText.memory.costHint}</p>
        </div>
      ) : null}
    </div>
  );
};
