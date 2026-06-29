// ============================================================================
// ModelSettings - Model Configuration Tab
//
// Master-Detail 布局：左侧 Provider 列表（已可用 / 待添加 Key 分组）+ 右侧详情面板。
// 详情面板三段式：① 连接 → ② 模型 → ③ 高级（折叠）。
// 所有保存 / 测试 / 发现 / 新增 handler 与重构前完全一致，仅 UI 结构重组。
// ============================================================================

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Star, Brain } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, ModelCapability, ModelEntrySettings, ModelProvider, ModelProviderProtocol, ModelProviderSettings, TaskModelStrategySettings } from '@shared/contract';
import { MODEL, UI, PROVIDER_MODELS, getProviderEndpointForProtocol, PROVIDER_CONCURRENCY_LIMITS } from '@shared/constants';
import {
  buildProviderInfoFromSettings,
  getProviderIconPresets,
  getProviderRuntimeModels,
  isProviderImageIcon,
  isDynamicCustomProviderId,
  normalizeProviderIcon,
  resolveProviderProtocol,
  validateProviderIcon,
  type RuntimeProviderModel,
} from '@shared/modelRuntime';
import { createLogger } from '../../../../utils/logger';
import { toast } from '../../../../hooks/useToast';
import { saveProviderIconAssetFromDataUrl, useProviderIconImageSource } from '../../../../utils/providerIconAssets';

const logger = createLogger('ModelSettings');

// ============================================================================
// Types
// ============================================================================

// Re-export ModelConfig from shared types for consistency
import type { ModelConfig, ProxyMode } from '@shared/contract';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsPage, SettingsDetails } from '../SettingsLayout';
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
  describeProviderIconValidationError,
  getProtocolLabel,
  hasCustomEndpointOverride,
  isProviderIdentityManaged,
  orderProviderManagementRows,
  providerRequiresApiKey,
  resolveModelForProvider,
  shouldPromoteProviderToDefault,
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
import { TaskStrategySettingsPanel } from './TaskStrategySettingsPanel';
import { ProviderModelsSection } from './ProviderModelsSection';
import { AddProviderCard } from './AddProviderCard';
export type { ModelConfig };

export interface ModelSettingsProps {
  config: ModelConfig;
  onChange: (config: ModelConfig) => void;
}

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
  const [isSavingTaskStrategy, setIsSavingTaskStrategy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [isTesting, setIsTesting] = useState(false);
  const [isDoctorOpen, setIsDoctorOpen] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfigMap>({});
  const [taskStrategy, setTaskStrategy] = useState<TaskModelStrategySettings | null>(null);
  // 本地 Provider「打开即自动发现」的去重闸：每个 Provider 一个会话只自动发现一次
  const autoDiscoveredRef = useRef<Set<string>>(new Set());
  // keyless provider（local/Ollama）端点探测结果：undefined=探测中，不能默认当已可用
  const [keylessReachability, setKeylessReachability] = useState<Partial<Record<string, boolean>>>({});
  const keylessProbedRef = useRef<Set<string>>(new Set());
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
          setAppSettings(settings ?? null);
          setTaskStrategy(settings?.models?.taskStrategy ?? null);
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
    if (isProviderIdentityManaged(currentProviderConfig)) {
      toast.warning('团队托管 Provider 的名称由控制面下发。');
      return;
    }
    patchCurrentProviderConfig({ displayName: value });
  }, [currentProviderConfig, patchCurrentProviderConfig]);
  const handleProviderIconChange = useCallback((value: string) => {
    if (isProviderIdentityManaged(currentProviderConfig)) {
      toast.warning('团队托管 Provider 的图标由控制面下发。');
      return;
    }
    const result = validateProviderIcon(value);
    if (!result.valid) {
      toast.warning(describeProviderIconValidationError(result) ?? 'Provider 图标无效。');
      return;
    }
    patchCurrentProviderConfig({ icon: result.normalized });
  }, [currentProviderConfig, patchCurrentProviderConfig]);
  const handleProviderIconImageUpload = useCallback(async (dataUrl: string) => {
    const result = await saveProviderIconAssetFromDataUrl({
      provider: config.provider,
      dataUrl,
    });
    toast.success('Provider 图标已保存到本机资产目录');
    return result.icon;
  }, [config.provider]);
  const handleProviderFavoriteChange = useCallback((favorite: boolean) => {
    patchCurrentProviderConfig({ favorite });
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
    icon: currentProviderConfig?.icon,
    favorite: currentProviderConfig?.favorite,
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
      setAppSettings((prev) => prev ? {
        ...prev,
        models: {
          ...prev.models,
          default: config.provider,
          defaultProvider: config.provider,
          providers: {
            ...prev.models.providers,
            [config.provider]: providerConfigForSave,
          },
        },
      } : prev);
      setDefaultSelection({ provider: config.provider, model: modelId });
      toast.success('主任务模型已更新');
    } catch (error) {
      logger.error('Failed to set default model', error);
      toast.error('主任务模型保存失败: ' + (error instanceof Error ? error.message : '未知错误'));
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
      // 主任务模型指针与已配置 provider 解耦修复：出厂默认没 key 时，配好的 provider 自动接管主任务模型，
      // 否则发送被门禁拦下（"当前主任务模型未配置 API Key"）。
      setAppSettings((prev) => prev ? {
        ...prev,
        models: {
          ...prev.models,
          providers: {
            ...prev.models.providers,
            [config.provider]: providerConfigForSave,
          },
        },
      } : prev);
      try {
        const latestSettings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
        if (shouldPromoteProviderToDefault(config.provider, providerConfigForSave, latestSettings)) {
          await ipcService.invokeDomain(
            IPC_DOMAINS.SETTINGS,
            'set',
            buildDefaultModelSettingsUpdate(config.provider, providerConfigForSave)
          );
          const promotedModel = providerConfigForSave.model || config.model;
          setDefaultSelection({ provider: config.provider, model: promotedModel });
          toast.success(`原主任务模型未配置 API Key，主任务模型已自动切换到 ${providerConfigForSave.displayName || currentProviderInfo?.name || config.provider} / ${promotedModel}`);
        }
      } catch (promoteError) {
        logger.warn('Failed to auto-promote default model after provider save', {
          error: promoteError instanceof Error ? promoteError.message : String(promoteError),
        });
      }
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

  const handleSaveTaskStrategy = useCallback(async () => {
    if (!taskStrategy) return;
    setIsSavingTaskStrategy(true);
    const nextStrategy: TaskModelStrategySettings = {
      ...taskStrategy,
      updatedAt: Date.now(),
    };
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        models: {
          taskStrategy: nextStrategy,
        },
      });
      setTaskStrategy(nextStrategy);
      setAppSettings((prev) => prev ? {
        ...prev,
        models: {
          ...prev.models,
          taskStrategy: nextStrategy,
        },
      } : prev);
      toast.success('任务策略已保存');
    } catch (error) {
      logger.error('Failed to save task strategy', error);
      toast.error('任务策略保存失败: ' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setIsSavingTaskStrategy(false);
    }
  }, [taskStrategy]);

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

      // keyless provider 的发现结果同时就是端点可达性信号（启动 Ollama 后手动发现可翻正徽章）
      if (!providerRequiresApiKey(config.provider)) {
        setKeylessReachability((prev) => ({ ...prev, [config.provider]: Boolean(result?.success) }));
      }

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

  // keyless provider（local/Ollama）：列表展示前静默探测端点，没装/没起服务时
  // 不能在左侧列表挂"已可用"（dogfood 实测：全新机器显示已可用，选了连不上）。
  useEffect(() => {
    if (!settingsLoaded) return;
    let cancelled = false;
    providers
      .filter((provider) => !providerRequiresApiKey(provider.id))
      .forEach((provider) => {
        if (keylessProbedRef.current.has(provider.id)) return;
        keylessProbedRef.current.add(provider.id);
        const baseUrl = providerConfigs[provider.id]?.baseUrl
          || getProviderEndpointForProtocol(provider.id, 'openai')
          || '';
        ipcService.invokeDomain<DiscoverModelsResult>(
          IPC_DOMAINS.PROVIDER,
          'discover_models',
          { provider: provider.id, apiKey: '', baseUrl },
        )
          .then((result) => {
            if (!cancelled) {
              setKeylessReachability((prev) => ({ ...prev, [provider.id]: Boolean(result?.success) }));
            }
          })
          .catch(() => {
            if (!cancelled) {
              setKeylessReachability((prev) => ({ ...prev, [provider.id]: false }));
            }
          });
      });
    return () => {
      cancelled = true;
    };
  }, [settingsLoaded, providers, providerConfigs]);

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
  const providerIcon = normalizeProviderIcon(currentProviderConfig?.icon) || providerTitle.slice(0, 1).toUpperCase();
  const providerIconIsImage = isProviderImageIcon(providerIcon);
  const providerIconImageSource = useProviderIconImageSource(providerIcon);
  const providerIconPresets = getProviderIconPresets(config.provider);
  const providerIdentityManaged = isProviderIdentityManaged(currentProviderConfig);

  // 主模型锚点：Neo 实际默认用哪个模型（消灭「任务策略默认档位」与「Provider 设默认」两套默认打架）。
  const defaultProviderConfig = providerConfigs[defaultSelection.provider];
  const defaultProviderLabel = defaultProviderConfig?.displayName
    || providers.find((provider) => provider.id === defaultSelection.provider)?.name
    || defaultSelection.provider;
  const defaultModelLabel = defaultProviderConfig?.models?.[defaultSelection.model]?.label
    || defaultSelection.model;

  return (
    <SettingsPage
      title={t.model.title}
      description="先接入 Provider 并选定默认模型，按需再设自动按任务切换的策略。"
    >
      <WebModeBanner />

      {/* ── 主模型锚点 ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Brain className="h-4 w-4 shrink-0 text-zinc-400" />
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">Neo 默认模型</div>
            <div className="truncate text-sm font-medium text-zinc-100">
              {defaultSelection.model ? `${defaultProviderLabel} / ${defaultModelLabel}` : '未设置'}
            </div>
          </div>
        </div>
        <span className="text-[11px] text-zinc-500">在下方选择 Provider 后，点模型旁的「设为默认」更改</span>
      </div>

      {/* ── Master-Detail：左 Provider 列表 + 右详情 ── */}
      <div className="grid gap-4 lg:grid-cols-[252px_minmax(0,1fr)] lg:items-start">
        <ProviderListPanel
          configuredRows={configuredRows}
          unconfiguredRows={unconfiguredRows}
          keylessReachability={keylessReachability}
          selectedProviderId={config.provider}
          isAddingProvider={isAddingProvider}
          onSelect={handleSelectProvider}
          onStartAddProvider={() => setIsAddingProvider(true)}
          onOpenDoctor={() => setIsDoctorOpen(true)}
        />

        <div className="min-w-0 space-y-4">
          {isAddingProvider ? (
            <AddProviderCard
              name={newProviderName}
              protocol={newProviderProtocol}
              baseUrl={newProviderBaseUrl}
              apiKey={newProviderApiKey}
              onNameChange={setNewProviderName}
              onProtocolChange={setNewProviderProtocol}
              onBaseUrlChange={setNewProviderBaseUrl}
              onApiKeyChange={setNewProviderApiKey}
              onAddProvider={handleAddProvider}
            />
          ) : (
            <>
              {/* ── 详情 Header ── */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-base font-bold text-zinc-200">
                    {providerIconIsImage ? (
                      providerIconImageSource ? (
                        <img src={providerIconImageSource} alt="" className="h-full w-full rounded-lg object-cover" />
                      ) : (
                        providerTitle.slice(0, 1).toUpperCase()
                      )
                    ) : (
                      providerIcon
                    )}
                    {currentProviderConfig?.favorite && (
                      <Star className="absolute -right-1 -top-1 h-3.5 w-3.5 fill-amber-300 text-amber-300" />
                    )}
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
                providerIcon={normalizeProviderIcon(currentProviderConfig?.icon) ?? ''}
                providerIconPresets={providerIconPresets}
                providerFavorite={currentProviderConfig?.favorite === true}
                providerIdentityManaged={providerIdentityManaged}
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
                onProviderIconChange={handleProviderIconChange}
                onProviderIconImageUpload={handleProviderIconImageUpload}
                onProviderIconUploadError={(message) => toast.warning(message)}
                onProviderFavoriteChange={handleProviderFavoriteChange}
                onProviderProtocolChange={handleProviderProtocolChange}
                onResetOfficialEndpoint={handleResetOfficialEndpoint}
                onBaseUrlChange={handleBaseUrlChange}
                onApiKeyChange={handleApiKeyChange}
                onTestConnection={handleTestConnection}
              />

              {/* ── ② 模型（配好 Key 后展示） ── */}
              <ProviderModelsSection
                hasApiKey={hasApiKey}
                provider={config.provider}
                currentModels={currentModels}
                currentEnabledModels={currentEnabledModels}
                filteredCurrentModels={filteredCurrentModels}
                effectiveBaseUrl={effectiveBaseUrl}
                isDiscovering={isDiscovering}
                onDiscoverModels={() => handleDiscoverModels()}
                modelSearch={modelSearch}
                onModelSearchChange={setModelSearch}
                manualModelId={manualModelId}
                onManualModelIdChange={setManualModelId}
                manualModelLabel={manualModelLabel}
                onManualModelLabelChange={setManualModelLabel}
                onAddManualModel={handleAddManualModel}
                defaultSelection={defaultSelection}
                settingDefaultModelId={settingDefaultModelId}
                onSetDefaultModel={handleSetDefaultModel}
                onToggleModelEnabled={handleToggleModelEnabled}
                onToggleModelTool={handleToggleModelTool}
                onToggleModelCapability={handleToggleModelCapability}
              />

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

      {/* ── 任务策略（进阶，默认折叠）── */}
      <SettingsDetails
        title="自动按任务切换模型（进阶）"
        description="开启后 Neo 会按任务类型（快速 / 主 / 深度 / 视觉）自动选不同模型；不展开就一直用上面的默认模型。"
      >
        <TaskStrategySettingsPanel
          settings={appSettings}
          providerConfigs={providerConfigs}
          config={config}
          strategy={taskStrategy}
          disabled={isWebMode()}
          saving={isSavingTaskStrategy}
          onChange={setTaskStrategy}
          onSave={handleSaveTaskStrategy}
        />
      </SettingsDetails>

      <ProviderDoctorDialog
        isOpen={isDoctorOpen}
        onClose={() => setIsDoctorOpen(false)}
      />
    </SettingsPage>
  );
};
