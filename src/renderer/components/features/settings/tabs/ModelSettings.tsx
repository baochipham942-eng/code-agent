// ============================================================================
// ModelSettings - Model Configuration Tab
//
// Master-Detail 布局：左侧 Provider 列表（已可用 / 待添加 Key 分组）+ 右侧详情面板。
// 详情面板三段式：① 连接 → ② 模型 → ③ 高级（折叠）。
// 所有保存 / 测试 / 发现 / 新增 handler 与重构前完全一致，仅 UI 结构重组。
// ============================================================================

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Brain, Code2, Eye, Gauge, Key, Plus, RefreshCw, Search, Wrench } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Input, Select } from '../../../primitives';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, ModelCapability, ModelEntrySettings, ModelProvider, ModelProviderProtocol, ModelProviderSettings } from '@shared/contract';
import { MODEL, UI, PROVIDER_MODELS, getProviderEndpointForProtocol, PROVIDER_CONCURRENCY_LIMITS } from '@shared/constants';
import {
  MODEL_CAPABILITY_OPTIONS,
  buildProviderInfoFromSettings,
  featuresFromModelMetadata,
  getProviderRuntimeModels,
  isDynamicCustomProviderId,
  resolveProviderProtocol,
  type RuntimeProviderModel,
} from '@shared/modelRuntime';
import { createLogger } from '../../../../utils/logger';
import { toast } from '../../../../hooks/useToast';

const logger = createLogger('ModelSettings');

// ============================================================================
// Types
// ============================================================================

// Re-export ModelConfig from shared types for consistency
import type { ModelConfig, ProxyMode } from '@shared/contract';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsPage } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';
import { ProviderDoctorDialog } from '../ProviderDoctorDialog';
import {
  buildManualModelSettings,
  buildDefaultModelSettingsUpdate,
  buildLegacyLongCatProviderMigration,
  buildProviderConfigForSave,
  buildProviderManagementRows,
  buildProviderSettingsUpdate,
  createCustomProviderId,
  getProtocolLabel,
  hasCustomEndpointOverride,
  isModelMetadataLocked,
  orderProviderManagementRows,
  providerRequiresApiKey,
  resolveModelForProvider,
  type DiscoverModelsResult,
  type ProviderConfigMap,
  type ProviderDisplayInfo,
} from './ModelSettings.helpers';
import { ProviderListPanel } from './ProviderListPanel';
import {
  ProviderAdvancedSection,
  ProviderConnectionSection,
  ProviderDetailCard,
} from './ProviderDetailSections';
export type { ModelConfig };

export interface ModelSettingsProps {
  config: ModelConfig;
  onChange: (config: ModelConfig) => void;
}

const CAPABILITY_ICONS: Record<string, React.ReactNode> = { tool: <Wrench className="h-3 w-3" />, vision: <Eye className="h-3 w-3" />, reasoning: <Brain className="h-3 w-3" />, code: <Code2 className="h-3 w-3" />, fast: <Gauge className="h-3 w-3" /> };
const MODEL_CAPABILITY_PICKER = MODEL_CAPABILITY_OPTIONS.filter((capability) => ['code', 'vision', 'reasoning', 'fast', 'longContext', 'search'].includes(capability.id));

interface DefaultModelSelection {
  provider: ModelProvider;
  model: string;
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
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfigMap>({});
  // 本地 Provider「打开即自动发现」的去重闸：每个 Provider 一个会话只自动发现一次
  const autoDiscoveredRef = useRef<Set<string>>(new Set());
  const [modelSearch, setModelSearch] = useState('');
  const [manualModelId, setManualModelId] = useState('');
  const [manualModelLabel, setManualModelLabel] = useState('');
  const [defaultSelection, setDefaultSelection] = useState<DefaultModelSelection>({
    provider: config.provider,
    model: config.model,
  });
  const [settingDefaultModelId, setSettingDefaultModelId] = useState<string | null>(null);
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('');
  const [newProviderApiKey, setNewProviderApiKey] = useState('');
  const [newProviderProtocol, setNewProviderProtocol] = useState<ModelProviderProtocol>('openai');
  // Master-Detail：右侧面板是否处于「新增 Provider」模式
  const [isAddingProvider, setIsAddingProvider] = useState(false);

  // Build provider display list with i18n names where available
  const providers = useMemo(() => {
    const builtInProviders = PROVIDER_MODELS.map((p) => ({
      id: p.id,
      name: (t.model.providers as Record<string, { name?: string }>)?.[p.id === 'claude' ? 'anthropic' : p.id]?.name || p.name,
      description: (t.model.providers as Record<string, { description?: string }>)?.[p.id === 'claude' ? 'anthropic' : p.id]?.description || p.description,
      models: p.models,
    }));
    const seen = new Set(builtInProviders.map((provider) => provider.id));
    const customProviders = Object.entries(providerConfigs)
      .filter(([providerId]) => !seen.has(providerId as ModelProvider) && isDynamicCustomProviderId(providerId))
      .map(([providerId, providerConfig]) => buildProviderInfoFromSettings(providerId as ModelProvider, providerConfig))
      .filter((provider): provider is ProviderDisplayInfo => Boolean(provider));
    return [...builtInProviders, ...customProviders];
  }, [providerConfigs, t]);

  useEffect(() => {
    let cancelled = false;
    ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (!cancelled) {
          setProviderConfigs(settings?.models?.providers ?? {});
          const defaultProvider = (settings?.models?.defaultProvider || settings?.models?.default || config.provider) as ModelProvider;
          const defaultProviderConfig = settings?.models?.providers?.[defaultProvider];
          setDefaultSelection({
            provider: defaultProvider,
            model: defaultProviderConfig?.model || config.model,
          });
        }
      })
      .catch((error: unknown) => {
        logger.warn('Failed to load provider settings', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (!cancelled) {
          setSettingsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const migration = buildLegacyLongCatProviderMigration(config, providerConfigs);
    if (!migration) return;
    setProviderConfigs((prev) => ({ ...prev, ...migration.providerConfigs }));
    onChange(migration.config);
  }, [config, onChange, providerConfigs]);

  // Get models for current provider
  const currentProviderConfig = providerConfigs[config.provider];
  const currentProviderInfo = buildProviderInfoFromSettings(config.provider, currentProviderConfig);
  const effectiveProtocol = resolveProviderProtocol(config.provider, currentProviderConfig);
  const registryEndpoint = getProviderEndpointForProtocol(config.provider, effectiveProtocol) || '';
  const configuredBaseUrl = config.baseUrl ?? currentProviderConfig?.baseUrl ?? registryEndpoint;
  const effectiveBaseUrl = configuredBaseUrl || registryEndpoint;
  const showOfficialEndpointReset = hasCustomEndpointOverride(config.provider, configuredBaseUrl, effectiveProtocol);
  const isCustomProviderProtocolEditable = isDynamicCustomProviderId(config.provider) || config.provider === 'longcat';

  const currentModels = useMemo(
    () => getProviderRuntimeModels(currentProviderInfo, currentProviderConfig),
    [currentProviderInfo, currentProviderConfig],
  );
  const currentEnabledModels = useMemo(
    () => currentModels.filter((model) => model.enabled),
    [currentModels],
  );
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
  const orderedProviderRows = useMemo(() => orderProviderManagementRows(providerRows), [providerRows]);
  const selectedProviderRow = providerRows.find((provider) => provider.selected);
  const needsApiKey = providerRequiresApiKey(config.provider);
  const hasInputApiKey = Boolean(config.apiKey?.trim());
  const hasStoredApiKey = Boolean(currentProviderConfig?.apiKey || currentProviderConfig?.apiKeyConfigured);
  const hasApiKey = !needsApiKey || hasInputApiKey || hasStoredApiKey;

  // Master-Detail：按「是否已配置 Key」给左侧列表分组（local 等无需 Key 的视为已配置）
  const providerHasKey = useCallback((providerId: ModelProvider) => {
    if (!providerRequiresApiKey(providerId)) return true;
    const providerConfig = providerConfigs[providerId];
    return Boolean(providerConfig?.apiKeyConfigured || providerConfig?.apiKey);
  }, [providerConfigs]);
  const configuredRows = useMemo(
    () => orderedProviderRows.filter((row) => providerHasKey(row.id)),
    [orderedProviderRows, providerHasKey],
  );
  const unconfiguredRows = useMemo(
    () => orderedProviderRows.filter((row) => !providerHasKey(row.id)),
    [orderedProviderRows, providerHasKey],
  );

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
    const providerConfig = providerConfigs[providerId];
    const provider = buildProviderInfoFromSettings(providerId, providerConfig);
    const nextModel = resolveModelForProvider(provider, config.model, providerConfig);
    const nextRuntimeModel = getProviderRuntimeModels(provider, providerConfig).find((model) => model.id === nextModel);
    onChange({
      ...config,
      provider: providerId,
      model: nextModel,
      apiKey: providerConfig?.apiKey || '',
      baseUrl: providerConfig?.baseUrl || getProviderEndpointForProtocol(providerId, resolveProviderProtocol(providerId, providerConfig)) || '',
      protocol: resolveProviderProtocol(providerId, providerConfig),
      capabilities: nextRuntimeModel?.capabilities,
      maxTokens: nextRuntimeModel?.maxTokens ?? config.maxTokens,
    });
    setModelSearch('');
    setIsAddingProvider(false);
  }, [config, onChange, providerConfigs]);

  const handleApiKeyChange = useCallback((value: string) => {
    patchCurrentProviderConfig({
      apiKey: value,
      apiKeyConfigured: value.trim() ? true : currentProviderConfig?.apiKeyConfigured,
    });
    onChange({ ...config, apiKey: value });
  }, [config, currentProviderConfig?.apiKeyConfigured, onChange, patchCurrentProviderConfig]);

  const handleBaseUrlChange = useCallback((value: string) => {
    patchCurrentProviderConfig({ baseUrl: value });
    onChange({ ...config, baseUrl: value });
  }, [config, onChange, patchCurrentProviderConfig]);

  // 并发上限是 per-provider 设置（不属于活动 ModelConfig），只写 providerConfig，
  // 由 Save 时随 currentProviderConfig 一起持久化到 settings.models.providers。
  const handleMaxConcurrentChange = useCallback((value: number | undefined) => {
    patchCurrentProviderConfig({ maxConcurrent: value });
  }, [patchCurrentProviderConfig]);
  const handleProxyModeChange = useCallback((mode: ProxyMode) => {
    patchCurrentProviderConfig({ proxyMode: mode });
  }, [patchCurrentProviderConfig]);
  const defaultMaxConcurrent = PROVIDER_CONCURRENCY_LIMITS[config.provider]?.maxConcurrent;

  const handleResetOfficialEndpoint = useCallback(() => {
    if (!registryEndpoint) {
      return;
    }
    patchCurrentProviderConfig({ baseUrl: registryEndpoint });
    onChange({ ...config, baseUrl: registryEndpoint });
    toast.success('已恢复官方地址');
  }, [config, onChange, patchCurrentProviderConfig, registryEndpoint]);

  const handleDisplayNameChange = useCallback((value: string) => {
    patchCurrentProviderConfig({ displayName: value });
  }, [patchCurrentProviderConfig]);

  const handleProviderProtocolChange = useCallback((protocol: ModelProviderProtocol) => {
    patchCurrentProviderConfig({ protocol });
    if (config.provider === 'longcat') {
      const baseUrl = getProviderEndpointForProtocol(config.provider, protocol) || config.baseUrl;
      patchCurrentProviderConfig({ protocol, baseUrl });
      onChange({ ...config, protocol, baseUrl });
      return;
    }
    onChange({ ...config, protocol });
  }, [config, onChange, patchCurrentProviderConfig]);

  const buildCurrentProviderConfigForSave = useCallback((modelId: string) => buildProviderConfigForSave({
    currentProviderConfig,
    baseUrl: effectiveBaseUrl,
    protocol: effectiveProtocol,
    displayName: currentProviderConfig?.displayName,
    model: modelId,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    models: currentProviderConfig?.models,
    apiKey: config.apiKey,
    needsApiKey,
    hasStoredApiKey,
  }), [
    config.apiKey,
    config.maxTokens,
    config.temperature,
    currentProviderConfig,
    effectiveBaseUrl,
    effectiveProtocol,
    hasStoredApiKey,
    needsApiKey,
  ]);

  const handleSetDefaultModel = useCallback(async (modelId: string) => {
    const selectedModel = currentModels.find((model) => model.id === modelId);
    const nextConfig = {
      ...config,
      model: modelId,
      capabilities: selectedModel?.capabilities ?? config.capabilities,
      maxTokens: selectedModel?.maxTokens ?? config.maxTokens,
    };
    const providerConfigForSave = buildCurrentProviderConfigForSave(modelId);

    setSettingDefaultModelId(modelId);
    try {
      await ipcService.invokeDomain(
        IPC_DOMAINS.SETTINGS,
        'set',
        buildDefaultModelSettingsUpdate(config.provider, providerConfigForSave)
      );
      patchCurrentProviderConfig({ model: modelId });
      onChange(nextConfig);
      setProviderConfigs((prev) => ({
        ...prev,
        [config.provider]: providerConfigForSave,
      }));
      setDefaultSelection({ provider: config.provider, model: modelId });
      toast.success('默认模型已更新');
    } catch (error) {
      logger.error('Failed to set default model', error);
      toast.error('默认模型保存失败: ' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setSettingDefaultModelId(null);
    }
  }, [buildCurrentProviderConfigForSave, config, currentModels, onChange, patchCurrentProviderConfig]);

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
      const providerConfigForSave = buildCurrentProviderConfigForSave(currentProviderConfig?.model || config.model);
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        ...buildProviderSettingsUpdate(config.provider, providerConfigForSave),
      });
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
    if (needsApiKey && !config.apiKey && !hasStoredApiKey) {
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
        { provider: config.provider, apiKey: config.apiKey || '', baseUrl: effectiveBaseUrl, model: config.model, protocol: effectiveProtocol }
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

  const handleDiscoverModels = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!effectiveBaseUrl) {
      if (!silent) toast.warning('请先填写 Provider 地址');
      return;
    }
    setIsDiscovering(true);
    try {
      const result = await ipcService.invokeDomain<DiscoverModelsResult>(
        IPC_DOMAINS.PROVIDER,
        'discover_models',
        { provider: config.provider, apiKey: config.apiKey || '', baseUrl: effectiveBaseUrl, protocol: effectiveProtocol }
      );

      if (!result?.success) {
        if (!silent) {
          const detail = result?.error?.suggestion ? `\n${result.error.suggestion}` : '';
          toast.error(`${result?.error?.message || '模型发现失败'}${detail}`);
        }
        return;
      }

      if (!result.models.length) {
        if (!silent) toast.warning('没有从 Provider 返回可用模型');
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
            ...(config.apiKey?.trim()
              ? { apiKey: config.apiKey.trim(), apiKeyConfigured: true }
              : { apiKeyConfigured: hasStoredApiKey }),
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

      if (!silent) toast.success(`发现 ${result.models.length} 个模型，已合入当前 Provider`);
    } catch (error) {
      if (!silent) toast.error('模型发现失败: ' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setIsDiscovering(false);
    }
  }, [config, currentEnabledModels, effectiveBaseUrl, effectiveProtocol, hasStoredApiKey, onChange]);

  // 本地 Ollama：选中即自动发现已装模型，下拉框出厂预填，避免用户手敲出幽灵模型名。
  // 本地清单零成本、随时可读，静默发现（失败不弹错），每个 Provider 一个会话只跑一次。
  useEffect(() => {
    if (!settingsLoaded) return;
    if (config.provider !== 'local') return;
    if (!effectiveBaseUrl) return;
    if (autoDiscoveredRef.current.has(config.provider)) return;
    autoDiscoveredRef.current.add(config.provider);
    void handleDiscoverModels({ silent: true });
  }, [settingsLoaded, config.provider, effectiveBaseUrl, handleDiscoverModels]);

  const handleAddProvider = useCallback(() => {
    const displayName = newProviderName.trim();
    const baseUrl = newProviderBaseUrl.trim().replace(/\/+$/, '');
    const apiKey = newProviderApiKey.trim();
    if (!displayName) {
      toast.warning('请先填写 Provider 名称');
      return;
    }
    if (!baseUrl) {
      toast.warning('请先填写 Provider 地址');
      return;
    }

    const providerId = createCustomProviderId(displayName, [
      ...PROVIDER_MODELS.map((provider) => provider.id),
      ...Object.keys(providerConfigs),
    ]);
    const modelId = newProviderProtocol === 'claude' ? 'claude-sonnet-4-6' : 'custom-model';
    const modelSettings = buildManualModelSettings(
      modelId,
      newProviderProtocol === 'claude' ? 'Claude Sonnet 4.6' : 'Custom Model',
    );
    const nextProviderConfig: ModelProviderSettings = {
      enabled: true,
      displayName,
      baseUrl,
      apiKey,
      protocol: newProviderProtocol,
      model: modelId,
      updatedAt: Date.now(),
      models: {
        [modelId]: modelSettings,
      },
    };

    setProviderConfigs((prev) => ({
      ...prev,
      [providerId]: nextProviderConfig,
    }));
    onChange({
      ...config,
      provider: providerId,
      model: modelId,
      apiKey,
      baseUrl,
      protocol: newProviderProtocol,
      capabilities: modelSettings.capabilities,
      maxTokens: modelSettings.maxTokens ?? config.maxTokens,
    });
    setNewProviderName('');
    setNewProviderBaseUrl('');
    setNewProviderApiKey('');
    setNewProviderProtocol('openai');
    setModelSearch('');
    setIsAddingProvider(false);
    toast.success('Provider 已添加，点击「发现模型」拉取可用模型');
  }, [config, newProviderApiKey, newProviderBaseUrl, newProviderName, newProviderProtocol, onChange, providerConfigs]);

  const handleAddManualModel = useCallback(() => {
    const modelId = manualModelId.trim();
    if (!modelId) {
      toast.warning('请先填写模型 ID');
      return;
    }

    const manualModel = buildManualModelSettings(modelId, manualModelLabel);
    setProviderConfigs((prev) => {
      const providerConfig = prev[config.provider] ?? { enabled: true };
      const existing = providerConfig.models?.[modelId];
      return {
        ...prev,
        [config.provider]: {
          ...providerConfig,
          enabled: true,
          ...(config.apiKey?.trim()
            ? { apiKey: config.apiKey.trim(), apiKeyConfigured: true }
            : { apiKeyConfigured: hasStoredApiKey }),
          baseUrl: effectiveBaseUrl,
          protocol: effectiveProtocol,
          models: {
            ...providerConfig.models,
            [modelId]: {
              ...manualModel,
              ...existing,
              enabled: true,
              label: manualModel.label,
            },
          },
        },
      };
    });
    setManualModelId('');
    setManualModelLabel('');
    setModelSearch('');
    toast.success('模型已加入当前 Provider');
  }, [config, effectiveBaseUrl, effectiveProtocol, hasStoredApiKey, manualModelId, manualModelLabel, onChange]);

  const providerTitle = currentProviderConfig?.displayName || selectedProviderRow?.name || config.provider;

  return (
    <SettingsPage
      title={t.model.title}
      description="左侧选择或新增 Provider，右侧完成连接、模型与高级配置。"
    >
      <WebModeBanner />

      {/* ── Master-Detail：左 Provider 列表 + 右详情 ── */}
      <div className="grid gap-4 lg:grid-cols-[252px_minmax(0,1fr)] lg:items-start">
        <ProviderListPanel
          configuredRows={configuredRows}
          unconfiguredRows={unconfiguredRows}
          selectedProviderId={config.provider}
          isAddingProvider={isAddingProvider}
          onSelect={handleSelectProvider}
          onStartAddProvider={() => setIsAddingProvider(true)}
          onOpenDoctor={() => setIsDoctorOpen(true)}
        />

        <div className="min-w-0 space-y-4">
          {isAddingProvider ? (
            /* ── 新增 Provider / 中转站 ── */
            <ProviderDetailCard step="+" title="新增 Provider / 中转站">
              <div className="space-y-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-zinc-200">显示名称</label>
                    <Input
                      value={newProviderName}
                      onChange={(event) => setNewProviderName(event.target.value)}
                      placeholder="windhub.cc"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-zinc-200">协议</label>
                    <Select
                      value={newProviderProtocol}
                      onChange={(event) => setNewProviderProtocol(event.target.value as ModelProviderProtocol)}
                    >
                      <option value="openai">OpenAI 兼容</option>
                      <option value="claude">Claude 协议</option>
                    </Select>
                  </div>
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-zinc-200">接口地址（Base URL）</label>
                  <Input
                    value={newProviderBaseUrl}
                    onChange={(event) => setNewProviderBaseUrl(event.target.value)}
                    placeholder="https://example.com/v1"
                  />
                  <p className="mt-2 text-xs text-zinc-500">填到 /v1 为止，不要带 /chat/completions。</p>
                </div>
                <div className="flex items-end gap-3">
                  <div className="min-w-0 flex-1">
                    <label className="mb-2 block text-sm font-medium text-zinc-200">API Key</label>
                    <Input
                      type="password"
                      value={newProviderApiKey}
                      onChange={(event) => setNewProviderApiKey(event.target.value)}
                      placeholder="sk-..."
                      leftIcon={<Key className="h-4 w-4" />}
                    />
                  </div>
                  <Button
                    onClick={handleAddProvider}
                    disabled={isWebMode() || !newProviderName.trim() || !newProviderBaseUrl.trim()}
                    leftIcon={<Plus className="h-4 w-4" />}
                    className="shrink-0"
                  >
                    添加 Provider
                  </Button>
                </div>
                <p className="text-xs text-zinc-500">添加后点击「发现模型」拉取该 Provider 的可用模型列表。</p>
              </div>
            </ProviderDetailCard>
          ) : (
            <>
              {/* ── 详情 Header ── */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-base font-bold text-zinc-200">
                    {providerTitle.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <h4 className="text-base font-semibold text-zinc-100">{providerTitle}</h4>
                    <p className="mt-0.5 max-w-[420px] truncate text-xs text-zinc-500" title={effectiveBaseUrl}>
                      {getProtocolLabel(effectiveProtocol)} · {effectiveBaseUrl || '未设置地址'}
                    </p>
                  </div>
                </div>
                <span className={`text-xs ${hasApiKey ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {!needsApiKey ? '无需 API Key' : hasApiKey ? 'API Key 已保存' : '等待 API Key'}
                </span>
              </div>

              {/* ── ① 连接 ── */}
              <ProviderConnectionSection
                providerDisplayName={currentProviderConfig?.displayName ?? ''}
                providerNamePlaceholder={currentProviderInfo?.name || config.provider}
                effectiveProtocol={effectiveProtocol}
                isCustomProviderProtocolEditable={isCustomProviderProtocolEditable}
                showOfficialEndpointReset={showOfficialEndpointReset}
                registryEndpoint={registryEndpoint}
                configuredBaseUrl={configuredBaseUrl}
                apiKey={config.apiKey || ''}
                needsApiKey={needsApiKey}
                hasStoredApiKey={hasStoredApiKey}
                isTesting={isTesting}
                canTestConnection={!needsApiKey || Boolean(config.apiKey) || hasStoredApiKey}
                onDisplayNameChange={handleDisplayNameChange}
                onProviderProtocolChange={handleProviderProtocolChange}
                onResetOfficialEndpoint={handleResetOfficialEndpoint}
                onBaseUrlChange={handleBaseUrlChange}
                onApiKeyChange={handleApiKeyChange}
                onTestConnection={handleTestConnection}
              />

              {/* ── ② 模型（配好 Key 后展示） ── */}
              {hasApiKey ? (
                <ProviderDetailCard
                  step="2"
                  title="模型"
                  meta={`${currentEnabledModels.length} 已启用 / ${currentModels.length} 个`}
                  actions={(
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleDiscoverModels()}
                      disabled={isWebMode() || !effectiveBaseUrl}
                      loading={isDiscovering}
                      leftIcon={<RefreshCw className="h-3 w-3" />}
                    >
                      发现模型
                    </Button>
                  )}
                >
                  {/* 搜索 + 手动添加 */}
                  <div className="mb-3 grid gap-3 lg:grid-cols-[minmax(160px,1fr)_minmax(140px,1fr)_minmax(120px,0.8fr)_auto] lg:items-end">
                    <div>
                      <label className="mb-2 block text-xs font-medium text-zinc-400">搜索模型</label>
                      <Input
                        value={modelSearch}
                        onChange={(event) => setModelSearch(event.target.value)}
                        placeholder="搜索模型..."
                        inputSize="sm"
                        leftIcon={<Search className="h-3.5 w-3.5" />}
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-xs font-medium text-zinc-400">手动添加：模型 ID</label>
                      <Input
                        value={manualModelId}
                        onChange={(event) => setManualModelId(event.target.value)}
                        placeholder="deepseek-v3-2-251201"
                        inputSize="sm"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-xs font-medium text-zinc-400">显示名称</label>
                      <Input
                        value={manualModelLabel}
                        onChange={(event) => setManualModelLabel(event.target.value)}
                        placeholder={manualModelId || '可选'}
                        inputSize="sm"
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleAddManualModel}
                      disabled={isWebMode() || !manualModelId.trim()}
                      leftIcon={<Plus className="h-3 w-3" />}
                      className="lg:mb-px"
                    >
                      添加
                    </Button>
                  </div>

                  {/* 模型列表 */}
                  <div className="max-h-[420px] overflow-y-auto rounded-lg border border-zinc-800">
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
                          const metadataLocked = isModelMetadataLocked(config.provider, model);
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
                                {/* 设为默认 */}
                                {defaultSelection.provider === config.provider && defaultSelection.model === model.id ? (
                                  <span className="inline-flex h-7 items-center gap-1 rounded border border-blue-400/50 bg-blue-500/15 px-2 text-[11px] text-blue-200">
                                    ★ 默认
                                  </span>
                                ) : model.enabled ? (
                                  <button
                                    type="button"
                                    onClick={() => void handleSetDefaultModel(model.id)}
                                    disabled={settingDefaultModelId !== null}
                                    className="inline-flex h-7 items-center rounded border border-zinc-700 bg-zinc-800 px-2 text-[11px] text-zinc-500 transition hover:text-zinc-300"
                                  >
                                    {settingDefaultModelId === model.id ? '保存中...' : '设为默认'}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => handleToggleModelTool(model)}
                                  disabled={metadataLocked}
                                  className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition ${
                                    model.supportsTool
                                      ? 'border-blue-400/50 bg-blue-500/15 text-blue-200'
                                      : metadataLocked
                                        ? 'border-zinc-700 bg-zinc-800 text-zinc-500'
                                        : 'border-zinc-700 bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                                  }`}
                                  title={metadataLocked ? '内置模型标签由模型目录决定' : '工具调用'}
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
                                      disabled={metadataLocked}
                                      className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition ${
                                        active
                                          ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
                                          : metadataLocked
                                            ? 'border-zinc-700 bg-zinc-800 text-zinc-500'
                                            : 'border-zinc-700 bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                                      }`}
                                      title={metadataLocked ? '内置模型标签由模型目录决定' : capability.label}
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
                </ProviderDetailCard>
              ) : (
                <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 px-4 py-6 text-center text-xs text-zinc-500">
                  填写 API Key 并测试连接后，即可发现和启用该 Provider 的模型。
                </div>
              )}

              {/* ── ③ 高级（折叠） ── */}
              {hasApiKey && (
                <ProviderAdvancedSection
                  maxConcurrent={currentProviderConfig?.maxConcurrent}
                  defaultMaxConcurrent={defaultMaxConcurrent}
                  proxyMode={currentProviderConfig?.proxyMode}
                  temperature={config.temperature ?? MODEL.DEFAULT_TEMPERATURE}
                  onMaxConcurrentChange={handleMaxConcurrentChange}
                  onProxyModeChange={handleProxyModeChange}
                  onTemperatureChange={(temperature) => {
                    patchCurrentProviderConfig({ temperature });
                    onChange({ ...config, temperature });
                  }}
                />
              )}

              {/* ── 保存 ── */}
              <div className="flex items-center gap-3 border-t border-zinc-800 pt-4">
                <Button
                  disabled={isWebMode()}
                  onClick={handleSave}
                  loading={isSaving}
                  variant={saveStatus === 'error' ? 'danger' : 'primary'}
                  className={saveStatus === 'success' ? '!bg-green-600 hover:!bg-green-500' : ''}
                >
                  {isSaving ? t.common.saving || 'Saving...' : saveStatus === 'success' ? t.common.saved || 'Saved!' : saveStatus === 'error' ? t.common.error || 'Error' : t.common.save || 'Save'}
                </Button>
                <span className="text-xs text-zinc-500">
                  保存 {providerTitle} 的连接、模型和高级配置。
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      <ProviderDoctorDialog
        isOpen={isDoctorOpen}
        onClose={() => setIsDoctorOpen(false)}
      />
    </SettingsPage>
  );
};
