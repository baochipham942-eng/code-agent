import React, { useMemo } from 'react';
import { Brain, GitBranch, RotateCcw } from 'lucide-react';
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
import { Button, Input, Select } from '../../../primitives';
import { ProviderDetailCard } from './ProviderDetailSections';

const PROFILE_META: Record<TaskStrategyProfileId, { label: string; description: string }> = {
  fast: { label: '快速任务模型', description: '短问答、改写、格式整理' },
  main: { label: '任务主模型', description: '代码、文件、工具任务' },
  deep: { label: '深度任务模型', description: '研究、规划、重构' },
  vision: { label: '视觉任务模型', description: '图片、截图、视觉输入' },
};

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
  saving?: boolean;
  onChange: (strategy: TaskModelStrategySettings) => void;
  onSave: () => void;
}

export const TaskStrategySettingsPanel: React.FC<TaskStrategySettingsPanelProps> = ({
  settings,
  providerConfigs,
  config,
  strategy,
  disabled,
  saving,
  onChange,
  onSave,
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

  if (!strategy) {
    return (
      <ProviderDetailCard step="0" title="任务策略">
        <div className="text-sm text-zinc-500">任务策略配置还没有加载完成。</div>
      </ProviderDetailCard>
    );
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
    <ProviderDetailCard
      step="1"
      title="任务策略"
      meta={strategy.mode === 'auto' ? '自动路由' : '手动默认'}
      actions={(
        <Button
          size="sm"
          variant="primary"
          onClick={onSave}
          loading={saving}
          disabled={disabled}
          leftIcon={<GitBranch className="h-3.5 w-3.5" />}
        >
          保存策略
        </Button>
      )}
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs font-medium text-zinc-400">策略模式</span>
              <Select
                value={strategy.mode}
                onChange={(event) => patchStrategy({ mode: event.target.value as TaskModelStrategySettings['mode'] })}
                disabled={disabled}
              >
                <option value="auto">自动按任务选择</option>
                <option value="manual">固定默认档位</option>
              </Select>
            </label>
            <label className="block">
              <span className="mb-2 block text-xs font-medium text-zinc-400">默认档位</span>
              <Select
                value={strategy.defaultProfile}
                onChange={(event) => patchStrategy({ defaultProfile: event.target.value as TaskStrategyProfileId })}
                disabled={disabled}
              >
                {Object.entries(PROFILE_META).map(([profile, meta]) => (
                  <option key={profile} value={profile}>{meta.label}</option>
                ))}
              </Select>
            </label>
          </div>

          <div className="grid gap-2">
            {(Object.keys(PROFILE_META) as TaskStrategyProfileId[]).map((profile) => {
              const slot = strategy.profiles[profile];
              const value = optionValue(slot.provider, slot.model);
              const unavailable = !selectedOptionSet.has(value);
              return (
                <div key={profile} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                        <Brain className="h-4 w-4 text-zinc-500" />
                        {PROFILE_META[profile].label}
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">{PROFILE_META[profile].description}</div>
                    </div>
                    {unavailable ? (
                      <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
                        当前模型不可用
                      </span>
                    ) : null}
                  </div>
                  <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_120px_120px]">
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] text-zinc-500">模型</span>
                      <Select
                        value={value}
                        onChange={(event) => {
                          const parsed = parseOptionValue(event.target.value);
                          if (parsed) patchProfile(profile, parsed);
                        }}
                        disabled={disabled}
                      >
                        {unavailable ? <option value={value}>{modelLabel(slot.provider, slot.model)}（不可用）</option> : null}
                        {modelOptions.map((option) => (
                          <option key={optionValue(option.provider, option.model)} value={optionValue(option.provider, option.model)}>
                            {option.providerLabel} / {option.label}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] text-zinc-500">Effort</span>
                      <Select
                        value={slot.reasoningEffort || 'medium'}
                        onChange={(event) => patchProfile(profile, { reasoningEffort: event.target.value as ModelConfig['reasoningEffort'] })}
                        disabled={disabled}
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </Select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] text-zinc-500">Max tokens</span>
                      <Input
                        type="number"
                        min={1024}
                        step={1024}
                        value={slot.maxTokens ?? ''}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          patchProfile(profile, { maxTokens: Number.isFinite(value) && value > 0 ? value : undefined });
                        }}
                        disabled={disabled}
                        inputSize="sm"
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-sm font-medium text-zinc-100">Fallback</div>
          <label className="flex items-start gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={strategy.fallback.enabled}
              onChange={(event) => patchStrategy({ fallback: { ...strategy.fallback, enabled: event.target.checked } })}
              disabled={disabled}
              className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-blue-500"
            />
            模型不可用时允许降级
          </label>
          <label className="flex items-start gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={strategy.fallback.preferSameProvider}
              onChange={(event) => patchStrategy({ fallback: { ...strategy.fallback, preferSameProvider: event.target.checked } })}
              disabled={disabled || !strategy.fallback.enabled}
              className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-blue-500"
            />
            优先同 Provider
          </label>
          <label className="flex items-start gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={strategy.fallback.allowCrossProvider}
              onChange={(event) => patchStrategy({ fallback: { ...strategy.fallback, allowCrossProvider: event.target.checked } })}
              disabled={disabled || !strategy.fallback.enabled}
              className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-blue-500"
            />
            允许跨 Provider
          </label>

          <div className="border-t border-zinc-800 pt-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-100">
              <RotateCcw className="h-4 w-4 text-zinc-500" />
              规则
            </div>
            <div className="space-y-2">
              {strategy.rules.map((rule) => (
                <label key={rule.id} className="flex items-start gap-2 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(event) => {
                      onChange({
                        ...strategy,
                        rules: strategy.rules.map((item) =>
                          item.id === rule.id ? { ...item, enabled: event.target.checked } : item
                        ),
                      });
                    }}
                    disabled={disabled || strategy.mode === 'manual'}
                    className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-blue-500"
                  />
                  <span>
                    <span className="block text-zinc-300">{rule.label}</span>
                    <span className="block text-zinc-600">{PROFILE_META[rule.profile]?.label || rule.profile}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </ProviderDetailCard>
  );
};
