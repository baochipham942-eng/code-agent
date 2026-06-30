import React, { useMemo } from 'react';
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
import { Select, Toggle } from '../../../primitives';

const PROFILE_META: Record<TaskStrategyProfileId, { label: string; description: string }> = {
  fast: { label: '快速任务模型', description: '短问答、改写、格式整理' },
  main: { label: '任务主模型', description: '代码、文件、工具任务' },
  deep: { label: '深度任务模型', description: '研究、规划、重构' },
  vision: { label: '视觉任务模型', description: '图片、截图、视觉输入' },
};

// 自动模式下只让用户挑这三类；主任务用「默认模型」（在上方模型列表设默认），不在这里重复配置。
const AUTO_PROFILES: TaskStrategyProfileId[] = ['fast', 'deep', 'vision'];

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

export interface TaskStrategySettingsPanelProps {
  settings: AppSettings | null;
  providerConfigs: Partial<Record<string, ModelProviderSettings>>;
  config: ModelConfig;
  strategy: TaskModelStrategySettings | null;
  disabled?: boolean;
  /** 改动即存：开关 / 三类模型修改后立即调用持久化 */
  onChange: (strategy: TaskModelStrategySettings) => void;
}

export const TaskStrategySettingsPanel: React.FC<TaskStrategySettingsPanelProps> = ({
  settings,
  providerConfigs,
  config,
  strategy,
  disabled,
  onChange,
}) => {
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

  const profileProviders = useMemo(
    () => strategy ? Object.values(strategy.profiles).map((slot) => slot.provider) : [],
    [strategy],
  );

  const modelOptions = useMemo(() => buildRuntimeModelOptions(
    effectiveSettings,
    PROVIDER_MODELS.map((provider) => provider.id),
    { includeDisabledProviders: Array.from(new Set([...profileProviders, config.provider])) },
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

  if (!strategy) {
    return <div className="text-sm text-zinc-500">任务策略配置还没有加载完成。</div>;
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
  return (
    <div className="space-y-4">
      <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-zinc-200">开启自动切换</span>
          <span className="block text-xs text-zinc-500">开启后快速 / 深度 / 视觉任务可用不同模型；关闭则全部用默认模型。</span>
        </span>
        <Toggle
          checked={strategy.mode === 'auto'}
          onChange={(checked) => patchStrategy({ mode: checked ? 'auto' : 'manual' })}
          disabled={disabled}
          aria-label="开启自动按任务切换模型"
        />
      </label>

      {strategy.mode === 'auto' && (
        <div className="grid gap-2 sm:grid-cols-3">
          {AUTO_PROFILES.map((profile) => {
            const slot = strategy.profiles[profile];
            const value = optionValue(slot.provider, slot.model);
            const unavailable = !selectedOptionSet.has(value);
            return (
              <div key={profile} className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
                  <Brain className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  <span className="truncate">{PROFILE_META[profile].label}</span>
                  {unavailable ? (
                    <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1 text-[10px] text-amber-200">
                      不可用
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
                  {unavailable ? <option value={value}>{modelLabel(slot.provider, slot.model)}（不可用）</option> : null}
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
    </div>
  );
};
