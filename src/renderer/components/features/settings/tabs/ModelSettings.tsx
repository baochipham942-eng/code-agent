// ============================================================================
// ModelSettings - Model Configuration Tab
// ============================================================================

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { Brain, CheckCircle, Code2, Eye, Gauge, Key, RefreshCw, Search, Stethoscope, Wrench, Zap } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Input, Select } from '../../../primitives';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, ModelCapability, ModelEntrySettings, ModelProvider, ModelProviderSettings } from '@shared/contract';
import { UI, MODEL, PROVIDER_MODELS, PROVIDER_MODELS_MAP, getProviderInfo } from '@shared/constants';
import type { ProviderInfo, ProviderModelEntry } from '@shared/constants';
import {
  MODEL_CAPABILITY_OPTIONS,
  featuresFromModelMetadata,
  getEnabledProviderModels,
  getProviderRuntimeModels,
  type RuntimeProviderModel,
} from '@shared/modelRuntime';
import { createLogger } from '../../../../utils/logger';
import { toast } from '../../../../hooks/useToast';

const logger = createLogger('ModelSettings');

// ============================================================================
// Types
// ============================================================================

// Re-export ModelConfig from shared types for consistency
import type { ModelConfig } from '@shared/contract';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';
import { ProviderDoctorDialog } from '../ProviderDoctorDialog';
export type { ModelConfig };

export interface ModelSettingsProps {
  config: ModelConfig;
  onChange: (config: ModelConfig) => void;
}

interface ProviderDisplayInfo {
  id: ModelProvider;
  name: string;
  description: string;
  models: ProviderModelEntry[];
}

export interface ProviderManagementRow {
  id: ModelProvider;
  name: string;
  description: string;
  modelCount: number;
  evalEligibleCount: number;
  defaultModel: string;
  endpoint: string;
  cloudProxySupported: boolean;
  selected: boolean;
  selectedModelLabel: string;
  enabledModelCount: number;
}

type ProviderConfigMap = Partial<Record<ModelProvider, ModelProviderSettings>>;

interface DiscoverModelsResult {
  success: boolean;
  models: Array<{
    id: string;
    label: string;
    capabilities: ModelCapability[];
    maxTokens?: number;
    supportsTool: boolean;
    supportsVision: boolean;
    supportsStreaming: boolean;
  }>;
  latencyMs: number;
  error?: { code: string; message: string; suggestion?: string };
}

const CAPABILITY_ICONS: Record<string, React.ReactNode> = {
  tool: <Wrench className="h-3 w-3" />,
  vision: <Eye className="h-3 w-3" />,
  reasoning: <Brain className="h-3 w-3" />,
  code: <Code2 className="h-3 w-3" />,
  fast: <Gauge className="h-3 w-3" />,
};

const MODEL_CAPABILITY_PICKER = MODEL_CAPABILITY_OPTIONS.filter((capability) =>
  ['code', 'vision', 'reasoning', 'fast', 'longContext', 'search'].includes(capability.id)
);

// ============================================================================
// Helper: render model options with optional optgroup
// ============================================================================

function renderModelOptions(models: Array<Pick<ProviderModelEntry, 'id' | 'label' | 'group'>>): React.ReactNode {
  // Check if any models have groups
  const hasGroups = models.some((m) => m.group);
  if (!hasGroups) {
    return models.map((m) => (
      <option key={m.id} value={m.id}>{m.label}</option>
    ));
  }
  // Group by group label, preserving order
  const groups: { label: string; items: ProviderModelEntry[] }[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    const g = m.group || '';
    if (!seen.has(g)) {
      seen.add(g);
      groups.push({ label: g, items: [] });
    }
    const group = groups.find((x) => x.label === g);
    group?.items.push(m);
  }
  return groups.map((g) => (
    <optgroup key={g.label} label={g.label}>
      {g.items.map((m) => (
        <option key={m.id} value={m.id}>{m.label}</option>
      ))}
    </optgroup>
  ));
}

export function getModelLabel(models: ProviderModelEntry[], modelId: string): string {
  return models.find((model) => model.id === modelId)?.label || modelId;
}

export function resolveModelForProvider(
  provider: ProviderInfo | undefined,
  currentModel: string,
  providerConfig?: Partial<ModelProviderSettings>,
): string {
  if (!provider) {
    return currentModel;
  }
  const models = getEnabledProviderModels(provider, providerConfig);
  const selectableModels = models.length > 0 ? models : getProviderRuntimeModels(provider, providerConfig);
  if (selectableModels.some((model) => model.id === currentModel)) {
    return currentModel;
  }
  const registryDefault = getProviderInfo(provider.id)?.defaultModel;
  if (registryDefault && selectableModels.some((model) => model.id === registryDefault)) {
    return registryDefault;
  }
  return selectableModels[0]?.id || currentModel;
}

export function buildProviderManagementRows({
  providers,
  config,
  providerConfigs,
}: {
  providers: ProviderDisplayInfo[];
  config: ModelConfig;
  providerConfigs?: ProviderConfigMap;
}): ProviderManagementRow[] {
  return providers.map((provider) => {
    const registryInfo = getProviderInfo(provider.id);
    const runtimeModels = getProviderRuntimeModels(provider, providerConfigs?.[provider.id]);
    const enabledModels = runtimeModels.filter((model) => model.enabled);
    return {
      id: provider.id,
      name: providerConfigs?.[provider.id]?.displayName || provider.name,
      description: provider.description,
      modelCount: runtimeModels.length,
      evalEligibleCount: provider.models.filter((model) => model.evalEligible !== false).length,
      enabledModelCount: enabledModels.length,
      defaultModel: registryInfo?.defaultModel || runtimeModels[0]?.id || '-',
      endpoint: providerConfigs?.[provider.id]?.baseUrl || registryInfo?.endpoint || '-',
      cloudProxySupported: Boolean(registryInfo?.cloudProxySupported),
      selected: config.provider === provider.id,
      selectedModelLabel: config.provider === provider.id
        ? getModelLabel(runtimeModels, config.model)
        : getModelLabel(runtimeModels, registryInfo?.defaultModel || runtimeModels[0]?.id || '-'),
    };
  });
}

// ============================================================================
// Component
// ============================================================================

export const ModelSettings: React.FC<ModelSettingsProps> = ({ config, onChange }) => {
  const { t } = useI18n();
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [isTesting, setIsTesting] = useState(false);
  const [isDoctorOpen, setIsDoctorOpen] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfigMap>({});
  const [modelSearch, setModelSearch] = useState('');

  // Build provider display list with i18n names where available
  const providers = useMemo(() =>
    PROVIDER_MODELS.map((p) => ({
      id: p.id,
      name: (t.model.providers as Record<string, { name?: string }>)?.[p.id === 'claude' ? 'anthropic' : p.id]?.name || p.name,
      description: (t.model.providers as Record<string, { description?: string }>)?.[p.id === 'claude' ? 'anthropic' : p.id]?.description || p.description,
      models: p.models,
    })),
  [t]);

  useEffect(() => {
    let cancelled = false;
    ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (!cancelled) {
          setProviderConfigs(settings?.models?.providers ?? {});
        }
      })
      .catch((error) => {
        logger.warn('Failed to load provider settings', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Get models for current provider
  const currentProviderInfo = PROVIDER_MODELS_MAP[config.provider];
  const currentProviderConfig = providerConfigs[config.provider];
  const registryEndpoint = getProviderInfo(config.provider)?.endpoint || '';
  const configuredBaseUrl = config.baseUrl ?? currentProviderConfig?.baseUrl ?? registryEndpoint;
  const effectiveBaseUrl = configuredBaseUrl || registryEndpoint;
  const effectiveDisplayName = currentProviderConfig?.displayName || currentProviderInfo?.name || config.provider;

  const currentModels = useMemo(
    () => getProviderRuntimeModels(PROVIDER_MODELS_MAP[config.provider], currentProviderConfig),
    [config.provider, currentProviderConfig],
  );
  const currentEnabledModels = useMemo(
    () => currentModels.filter((model) => model.enabled),
    [currentModels],
  );
  const selectableModels = currentEnabledModels.length > 0 ? currentEnabledModels : currentModels;
  const filteredCurrentModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) return currentModels;
    return currentModels.filter((model) =>
      model.id.toLowerCase().includes(query) ||
      model.label.toLowerCase().includes(query) ||
      model.capabilities.some((capability) => capability.toLowerCase().includes(query))
    );
  }, [currentModels, modelSearch]);
  const providerRows = useMemo(
    () => buildProviderManagementRows({ providers, config, providerConfigs }),
    [providers, config, providerConfigs],
  );
  const selectedProviderRow = providerRows.find((provider) => provider.selected);
  const selectedModelLabel = getModelLabel(currentModels, config.model);
  const hasApiKey = Boolean(config.apiKey?.trim());

  const patchCurrentProviderConfig = useCallback((patch: Partial<ModelProviderSettings>) => {
    setProviderConfigs((prev) => {
      const current = prev[config.provider] ?? { enabled: true };
      return {
        ...prev,
        [config.provider]: {
          ...current,
          ...patch,
          enabled: patch.enabled ?? current.enabled ?? true,
        },
      };
    });
  }, [config.provider]);

  const patchCurrentModelSettings = useCallback((
    model: RuntimeProviderModel,
    patch: Partial<ModelEntrySettings>,
  ) => {
    setProviderConfigs((prev) => {
      const providerConfig = prev[config.provider] ?? { enabled: true };
      const existing = providerConfig.models?.[model.id] ?? {};
      return {
        ...prev,
        [config.provider]: {
          ...providerConfig,
          enabled: providerConfig.enabled ?? true,
          models: {
            ...providerConfig.models,
            [model.id]: {
              label: model.label,
              enabled: model.enabled,
              capabilities: model.capabilities,
              maxTokens: model.maxTokens,
              supportsTool: model.supportsTool,
              supportsVision: model.supportsVision,
              supportsStreaming: model.supportsStreaming,
              ...existing,
              ...patch,
            },
          },
        },
      };
    });
  }, [config.provider]);

  const handleSelectProvider = useCallback((providerId: ModelProvider) => {
    const provider = PROVIDER_MODELS_MAP[providerId];
    const providerConfig = providerConfigs[providerId];
    const nextModel = resolveModelForProvider(provider, config.model, providerConfig);
    const nextRuntimeModel = getProviderRuntimeModels(provider, providerConfig).find((model) => model.id === nextModel);
    onChange({
      ...config,
      provider: providerId,
      model: nextModel,
      apiKey: providerConfig?.apiKey || '',
      baseUrl: providerConfig?.baseUrl || getProviderInfo(providerId)?.endpoint || '',
      capabilities: nextRuntimeModel?.capabilities,
      maxTokens: nextRuntimeModel?.maxTokens ?? config.maxTokens,
    });
    setModelSearch('');
  }, [config, onChange, providerConfigs]);

  const handleApiKeyChange = useCallback((value: string) => {
    patchCurrentProviderConfig({ apiKey: value });
    onChange({ ...config, apiKey: value });
  }, [config, onChange, patchCurrentProviderConfig]);

  const handleBaseUrlChange = useCallback((value: string) => {
    patchCurrentProviderConfig({ baseUrl: value });
    onChange({ ...config, baseUrl: value });
  }, [config, onChange, patchCurrentProviderConfig]);

  const handleDisplayNameChange = useCallback((value: string) => {
    patchCurrentProviderConfig({ displayName: value });
  }, [patchCurrentProviderConfig]);

  const handleModelChange = useCallback((modelId: string) => {
    const selectedModel = currentModels.find((model) => model.id === modelId);
    patchCurrentProviderConfig({ model: modelId });
    onChange({
      ...config,
      model: modelId,
      capabilities: selectedModel?.capabilities ?? config.capabilities,
      maxTokens: selectedModel?.maxTokens ?? config.maxTokens,
    });
  }, [config, currentModels, onChange, patchCurrentProviderConfig]);

  const handleToggleModelEnabled = useCallback((model: RuntimeProviderModel, enabled: boolean) => {
    patchCurrentModelSettings(model, { enabled });
    const nextModels = currentModels.map((item) =>
      item.id === model.id ? { ...item, enabled } : item
    );
    const nextEnabledModels = nextModels.filter((item) => item.enabled);
    let nextModelId = config.model;
    if (enabled && !currentEnabledModels.length) {
      nextModelId = model.id;
    }
    if (!enabled && config.model === model.id) {
      nextModelId = nextEnabledModels[0]?.id || model.id;
    }
    const selectedModel = nextModels.find((item) => item.id === nextModelId);
    onChange({
      ...config,
      model: nextModelId,
      capabilities: selectedModel?.capabilities ?? config.capabilities,
      maxTokens: selectedModel?.maxTokens ?? config.maxTokens,
    });
  }, [config, currentEnabledModels.length, currentModels, onChange, patchCurrentModelSettings]);

  const handleToggleModelCapability = useCallback((model: RuntimeProviderModel, capability: ModelCapability) => {
    const hasCapability = model.capabilities.includes(capability);
    const nextCapabilities = hasCapability
      ? model.capabilities.filter((item) => item !== capability)
      : [...model.capabilities, capability];
    const patch: Partial<ModelEntrySettings> = {
      capabilities: nextCapabilities,
    };
    if (capability === 'vision') {
      patch.supportsVision = !hasCapability;
    }
    patchCurrentModelSettings(model, patch);
    if (config.model === model.id) {
      onChange({ ...config, capabilities: nextCapabilities });
    }
  }, [config, onChange, patchCurrentModelSettings]);

  const handleToggleModelTool = useCallback((model: RuntimeProviderModel) => {
    patchCurrentModelSettings(model, { supportsTool: !model.supportsTool });
  }, [patchCurrentModelSettings]);

  // Save config to backend
  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus('idle');
    try {
      const providerConfigForSave: ModelProviderSettings = {
        ...(currentProviderConfig ?? { enabled: true }),
        enabled: true,
        apiKey: config.apiKey,
        baseUrl: effectiveBaseUrl,
        displayName: currentProviderConfig?.displayName,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        models: currentProviderConfig?.models,
      };
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        models: {
          default: config.provider,
          defaultProvider: config.provider,
          providers: {
            [config.provider]: providerConfigForSave,
          },
        },
      } as Partial<AppSettings>);
      setProviderConfigs((prev) => ({
        ...prev,
        [config.provider]: providerConfigForSave,
      }));
      logger.info('Config saved', { provider: config.provider });
      setSaveStatus('success');
      setTimeout(() => setSaveStatus('idle'), UI.COPY_FEEDBACK_DURATION);
    } catch (error) {
      logger.error('Failed to save config', error);
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!config.apiKey) {
      toast.warning('请先填写 API Key');
      return;
    }
    setIsTesting(true);
    try {
      const result = await ipcService.invokeDomain<{
        success: boolean;
        latencyMs: number;
        error?: { code: string; message: string; suggestion: string };
      }>(
        IPC_DOMAINS.PROVIDER,
        'test_connection',
        { provider: config.provider, apiKey: config.apiKey, baseUrl: effectiveBaseUrl }
      );
      if (result?.success) {
        toast.success(`连接成功，延迟 ${result.latencyMs}ms`);
      } else if (result?.error) {
        toast.error(`${result.error.message}\n${result.error.suggestion}`);
      } else {
        toast.error('连接失败，请检查 API Key 和网络连接');
      }
    } catch (err) {
      toast.error('连接测试失败: ' + (err instanceof Error ? err.message : '未知错误') + '。请检查网络连接');
    } finally {
      setIsTesting(false);
    }
  };

  const handleDiscoverModels = async () => {
    if (!effectiveBaseUrl) {
      toast.warning('请先填写 Provider 地址');
      return;
    }
    setIsDiscovering(true);
    try {
      const result = await ipcService.invokeDomain<DiscoverModelsResult>(
        IPC_DOMAINS.PROVIDER,
        'discover_models',
        { provider: config.provider, apiKey: config.apiKey, baseUrl: effectiveBaseUrl }
      );

      if (!result?.success) {
        const detail = result?.error?.suggestion ? `\n${result.error.suggestion}` : '';
        toast.error(`${result?.error?.message || '模型发现失败'}${detail}`);
        return;
      }

      if (!result.models.length) {
        toast.warning('没有从 Provider 返回可用模型');
        return;
      }

      const hasEnabledModel = currentEnabledModels.length > 0;
      const discoveredAt = Date.now();
      const firstDiscovered = result.models[0];

      setProviderConfigs((prev) => {
        const providerConfig = prev[config.provider] ?? { enabled: true };
        const nextModelMap: Record<string, ModelEntrySettings> = { ...providerConfig.models };
        result.models.forEach((model, index) => {
          const existing = nextModelMap[model.id];
          const shouldEnable = existing?.enabled ?? (!hasEnabledModel && index === 0);
          nextModelMap[model.id] = {
            ...existing,
            label: existing?.label || model.label,
            enabled: shouldEnable,
            capabilities: existing?.capabilities || model.capabilities,
            maxTokens: existing?.maxTokens ?? model.maxTokens,
            supportsTool: existing?.supportsTool ?? model.supportsTool,
            supportsVision: existing?.supportsVision ?? model.supportsVision,
            supportsStreaming: existing?.supportsStreaming ?? model.supportsStreaming,
            discoveredAt,
          };
        });
        return {
          ...prev,
          [config.provider]: {
            ...providerConfig,
            enabled: true,
            apiKey: config.apiKey,
            baseUrl: effectiveBaseUrl,
            model: providerConfig.model || config.model || firstDiscovered.id,
            models: nextModelMap,
          },
        };
      });

      if (!hasEnabledModel && firstDiscovered) {
        onChange({
          ...config,
          model: firstDiscovered.id,
          capabilities: firstDiscovered.capabilities,
          maxTokens: firstDiscovered.maxTokens ?? config.maxTokens,
        });
      }

      toast.success(`发现 ${result.models.length} 个模型，已合入当前 Provider`);
    } catch (error) {
      toast.error('模型发现失败: ' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setIsDiscovering(false);
    }
  };

  return (
    <SettingsPage
      title={t.model.title}
      description="管理默认 Provider、模型、API Key 和生成参数。诊断与连接测试保留在当前页，不进入普通对话流。"
    >
      <WebModeBanner />

      <SettingsSection
        title="Provider 管理"
        description="选择默认模型提供商，查看 endpoint、可用模型数量和当前配置状态。"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setIsDoctorOpen(true)}
            disabled={isWebMode()}
            leftIcon={<Stethoscope className="h-3 w-3" />}
          >
            运行诊断
          </Button>
        )}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
            {[
              ['当前 Provider', selectedProviderRow?.name || config.provider, selectedModelLabel],
              ['Provider 数量', String(providerRows.length), '可选服务商'],
              ['模型数量', `${currentEnabledModels.length}/${currentModels.length}`, '已启用 / 已发现'],
              ['API Key', hasApiKey ? '已填写' : '未填写', hasApiKey ? '可测试连接' : '保存前需要补齐'],
            ].map(([label, value, caption]) => (
              <div key={label} className="bg-zinc-900/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                <div className="mt-1 truncate text-lg font-semibold text-zinc-100">{value}</div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-500">{caption}</div>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left text-xs">
              <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Provider</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">默认模型</th>
                  <th className="px-3 py-2 font-medium">模型</th>
                  <th className="px-3 py-2 font-medium">Endpoint</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {providerRows.map((provider) => (
                  <tr
                    key={provider.id}
                    className={provider.selected ? 'bg-blue-500/10' : 'bg-zinc-900/40 hover:bg-zinc-800/60'}
                  >
                    <td className="px-3 py-3 align-middle">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-zinc-200">{provider.name}</span>
                          <span className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">
                            {provider.id}
                          </span>
                        </div>
                        <div className="mt-1 max-w-[260px] truncate text-xs text-zinc-500">
                          {provider.description}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 align-middle">
                      {provider.selected ? (
                        <div className="space-y-1">
                          <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                            <CheckCircle className="h-3 w-3" />
                            当前
                          </span>
                          <div className={hasApiKey ? 'text-[11px] text-zinc-400' : 'text-[11px] text-amber-300'}>
                            {hasApiKey ? 'API Key 已填' : '等待 API Key'}
                          </div>
                        </div>
                      ) : (
                        <span className="inline-flex rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-400">
                          可选择
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-middle text-zinc-300">
                      <div className="max-w-[170px] truncate" title={provider.defaultModel}>
                        {provider.defaultModel}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-middle text-zinc-300">
                      <div>{provider.modelCount} 个模型</div>
                      <div className="mt-0.5 text-[11px] text-zinc-500">
                        {provider.enabledModelCount} 个已启用
                      </div>
                    </td>
                    <td className="px-3 py-3 align-middle">
                      <div className="max-w-[240px] truncate font-mono text-[11px] text-zinc-500" title={provider.endpoint}>
                        {provider.endpoint}
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-600">
                        {provider.cloudProxySupported ? '支持云端代理' : '本地直连'}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-middle">
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          variant={provider.selected ? 'ghost' : 'secondary'}
                          onClick={() => handleSelectProvider(provider.id)}
                          disabled={provider.selected}
                        >
                          {provider.selected ? '已选择' : '使用'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="当前模型配置"
        description={`当前使用 ${selectedProviderRow?.name || config.provider} / ${selectedModelLabel}`}
      >
        <div className="grid gap-4 rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-200">
                Provider 名称
              </label>
              <Input
                value={currentProviderConfig?.displayName ?? ''}
                onChange={(e) => handleDisplayNameChange(e.target.value)}
                placeholder={currentProviderInfo?.name || config.provider}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-200">
                Provider 地址
              </label>
              <Input
                value={configuredBaseUrl}
                onChange={(e) => handleBaseUrlChange(e.target.value)}
                placeholder={registryEndpoint || 'https://api.example.com/v1'}
              />
              <p className="mt-2 text-xs text-zinc-500">
                OpenAI-compatible 服务通常填写到 /v1，模型发现会请求该地址下的 /models。
              </p>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-200">
                {t.model.apiKey}
              </label>
              <Input
                type="password"
                value={config.apiKey || ''}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                placeholder={t.model.apiKeyPlaceholder}
                leftIcon={<Key className="w-4 h-4" />}
              />
              <p className="mt-2 text-xs text-zinc-500">
                {t.model.apiKeyHint}
              </p>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-200">
                {t.model.modelSelect}
              </label>
              <Select
                value={config.model}
                onChange={(e) => handleModelChange(e.target.value)}
              >
                {renderModelOptions(selectableModels)}
              </Select>
              <p className="mt-2 text-xs text-zinc-500">
                默认模型只能从已启用模型里选；未启用模型会从输入框下拉隐藏。
              </p>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-200">
                {t.model.temperature}: {config.temperature ?? MODEL.DEFAULT_TEMPERATURE}
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={config.temperature ?? MODEL.DEFAULT_TEMPERATURE}
                onChange={(e) => {
                  const temperature = parseFloat(e.target.value);
                  patchCurrentProviderConfig({ temperature });
                  onChange({ ...config, temperature });
                }}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-zinc-500">
                <span>{t.model.temperaturePrecise}</span>
                <span>{t.model.temperatureCreative}</span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
              <Zap className="h-4 w-4 text-amber-300" />
              运行摘要
            </div>
            <dl className="mt-3 space-y-2 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Provider</dt>
                <dd className="truncate text-zinc-300">{selectedProviderRow?.name || config.provider}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Model</dt>
                <dd className="truncate text-zinc-300">{selectedModelLabel}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Endpoint</dt>
                <dd className="max-w-[150px] truncate font-mono text-zinc-400" title={effectiveBaseUrl}>
                  {effectiveBaseUrl || '-'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">API Key</dt>
                <dd className={hasApiKey ? 'text-emerald-300' : 'text-amber-300'}>
                  {hasApiKey ? '已填写' : '未填写'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">模型池</dt>
                <dd className="text-zinc-300">{currentEnabledModels.length}/{currentModels.length} 个</dd>
              </div>
            </dl>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="模型发现与启用"
        description="从 Provider 拉取模型列表，按模型选择启用状态和能力标签。"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            onClick={handleDiscoverModels}
            disabled={isWebMode() || !effectiveBaseUrl}
            loading={isDiscovering}
            leftIcon={<RefreshCw className="h-3 w-3" />}
          >
            发现模型
          </Button>
        )}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="flex flex-col gap-3 border-b border-zinc-800 p-3 md:flex-row md:items-center md:justify-between">
            <div className="text-xs text-zinc-500">
              {currentEnabledModels.length} 个已启用，{currentModels.length} 个在当前模型池
            </div>
            <div className="relative w-full md:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <Input
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder="搜索模型..."
                className="pl-8"
              />
            </div>
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {filteredCurrentModels.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-zinc-500">
                没有匹配模型
              </div>
            ) : (
              <div className="divide-y divide-zinc-800">
                {filteredCurrentModels.map((model) => {
                  const features = featuresFromModelMetadata({
                    modelId: model.id,
                    capabilities: model.capabilities,
                    supportsTool: model.supportsTool,
                    supportsVision: model.supportsVision,
                  });
                  return (
                    <div key={model.id} className="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="inline-flex items-center gap-2 text-sm font-medium text-zinc-100">
                            <input
                              type="checkbox"
                              checked={model.enabled}
                              onChange={(event) => handleToggleModelEnabled(model, event.target.checked)}
                              className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-blue-500"
                            />
                            <span>{model.label}</span>
                          </label>
                          <span className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">
                            {model.source === 'discovered' ? '发现' : '内置'}
                          </span>
                          {features.map((feature) => (
                            <span
                              key={feature}
                              className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300"
                            >
                              {CAPABILITY_ICONS[feature]}
                              {feature}
                            </span>
                          ))}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-zinc-500">
                          <span>{model.id}</span>
                          {model.maxTokens ? <span>{model.maxTokens.toLocaleString()} tokens</span> : null}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
                        <button
                          type="button"
                          onClick={() => handleToggleModelTool(model)}
                          className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition ${
                            model.supportsTool
                              ? 'border-blue-400/50 bg-blue-500/15 text-blue-200'
                              : 'border-zinc-700 bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                          }`}
                          title="工具调用"
                        >
                          <Wrench className="h-3 w-3" />
                          工具
                        </button>
                        {MODEL_CAPABILITY_PICKER.map((capability) => {
                          const active = model.capabilities.includes(capability.id);
                          return (
                            <button
                              key={capability.id}
                              type="button"
                              onClick={() => handleToggleModelCapability(model, capability.id)}
                              className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition ${
                                active
                                  ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
                                  : 'border-zinc-700 bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                              }`}
                              title={capability.label}
                            >
                              {CAPABILITY_ICONS[capability.id] ?? <span className="text-[10px]">{capability.label.slice(0, 1)}</span>}
                              {capability.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      <div className="flex gap-3 border-t border-zinc-800 pt-4">
        <Button
          disabled={isWebMode()}
          onClick={handleSave}
          loading={isSaving}
          fullWidth
          variant={saveStatus === 'error' ? 'danger' : 'primary'}
          className={saveStatus === 'success' ? '!bg-green-600 hover:!bg-green-500' : ''}
        >
          {isSaving ? t.common.saving || 'Saving...' : saveStatus === 'success' ? t.common.saved || 'Saved!' : saveStatus === 'error' ? t.common.error || 'Error' : t.common.save || 'Save'}
        </Button>
        <Button
          disabled={isWebMode() || !config.apiKey}
          onClick={handleTestConnection}
          loading={isTesting}
          variant="secondary"
          className="shrink-0"
        >
          测试连接
        </Button>
      </div>

      <ProviderDoctorDialog
        isOpen={isDoctorOpen}
        onClose={() => setIsDoctorOpen(false)}
      />
    </SettingsPage>
  );
};
