// ============================================================================
// ModelSettings - Model Configuration Tab
//
// Master-Detail 布局：左侧 Provider 列表（已可用 / 待添加 Key 分组）+ 右侧详情面板。
// 详情面板三段式：① 连接 → ② 模型 → ③ 高级（折叠）。
// 所有保存 / 测试 / 发现 / 新增 handler 与重构前完全一致，仅 UI 结构重组。
// ============================================================================

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Toggle } from '../../../primitives';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, ModelEntrySettings, ModelProvider, ModelProviderProtocol, ModelProviderSettings, TaskModelStrategySettings } from '@shared/contract';
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
import { SettingsPage, SettingsSection } from '../SettingsLayout';
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
  mergeDiscoveredModelEntry,
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
  const modelText = t.settings.model;
  const [isSaving, setIsSaving] = useState(false);
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
    const providerTexts = modelText.providers as Record<string, { name?: string; description?: string }>;
    const builtInProviders = PROVIDER_MODELS.map((p) => ({
      id: p.id,
      name: providerTexts?.[p.id === 'claude' ? 'anthropic' : p.id]?.name || p.name,
      description: providerTexts?.[p.id === 'claude' ? 'anthropic' : p.id]?.description || p.description,
      models: p.models,
    }));
    const seen = new Set(builtInProviders.map((provider) => provider.id));
    const customProviders = Object.entries(providerConfigs)
      .filter(([providerId]) => !seen.has(providerId as ModelProvider) && isDynamicCustomProviderId(providerId))
      .map(([providerId, providerConfig]) => buildProviderInfoFromSettings(providerId as ModelProvider, providerConfig))
      .filter((provider): provider is ProviderDisplayInfo => Boolean(provider));
    return [...builtInProviders, ...customProviders];
  }, [modelText.providers, providerConfigs]);

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
    () => buildProviderManagementRows({ providers, config, providerConfigs, labels: modelText.helpers }),
    [providers, config, providerConfigs, modelText.helpers],
  );
  const orderedProviderRows = useMemo(() => orderProviderManagementRows(providerRows, defaultSelection.provider), [providerRows, defaultSelection.provider]);
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
    toast.success(modelText.toast.officialEndpointRestored);
  }, [config, modelText.toast.officialEndpointRestored, onChange, patchCurrentProviderConfig, registryEndpoint]);

  const handleDisplayNameChange = useCallback((value: string) => {
    if (isProviderIdentityManaged(currentProviderConfig)) {
      toast.warning(modelText.toast.managedNameWarning);
      return;
    }
    patchCurrentProviderConfig({ displayName: value });
  }, [currentProviderConfig, modelText.toast.managedNameWarning, patchCurrentProviderConfig]);
  const handleProviderIconChange = useCallback((value: string) => {
    if (isProviderIdentityManaged(currentProviderConfig)) {
      toast.warning(modelText.toast.managedIconWarning);
      return;
    }
    const result = validateProviderIcon(value);
    if (!result.valid) {
      toast.warning(describeProviderIconValidationError(result, modelText.helpers) ?? modelText.toast.invalidIconFallback);
      return;
    }
    patchCurrentProviderConfig({ icon: result.normalized });
  }, [currentProviderConfig, modelText.helpers, modelText.toast.invalidIconFallback, modelText.toast.managedIconWarning, patchCurrentProviderConfig]);
  const handleProviderIconImageUpload = useCallback(async (dataUrl: string) => {
    const result = await saveProviderIconAssetFromDataUrl({
      provider: config.provider,
      dataUrl,
    });
    toast.success(modelText.toast.iconSaved);
    return result.icon;
  }, [config.provider, modelText.toast.iconSaved]);
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
      toast.success(modelText.toast.defaultModelUpdated);
    } catch (error) {
      logger.error('Failed to set default model', error);
      toast.error(modelText.toast.defaultModelSaveFailedPrefix + (error instanceof Error ? error.message : modelText.unknownError));
    } finally {
      setSettingDefaultModelId(null);
    }
  }, [buildCurrentProviderConfigForSave, config, currentModels, modelText.toast.defaultModelSaveFailedPrefix, modelText.toast.defaultModelUpdated, modelText.unknownError, onChange, patchCurrentProviderConfig]);

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
          toast.success(`${modelText.toast.defaultPromotedPrefix}${providerConfigForSave.displayName || currentProviderInfo?.name || config.provider} / ${promotedModel}`);
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

  // 自动切换改为「改动即存」（静默，无保存按钮）：开关 / 三类模型的修改立即落盘。
  const persistTaskStrategy = useCallback(async (next: TaskModelStrategySettings) => {
    setTaskStrategy(next);
    const nextStrategy: TaskModelStrategySettings = { ...next, updatedAt: Date.now() };
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        models: { taskStrategy: nextStrategy },
      });
      setAppSettings((prev) => prev ? {
        ...prev,
        models: { ...prev.models, taskStrategy: nextStrategy },
      } : prev);
    } catch (error) {
      logger.error('Failed to save task strategy', error);
      toast.error(modelText.toast.taskStrategySaveFailedPrefix + (error instanceof Error ? error.message : modelText.unknownError));
    }
  }, [modelText.toast.taskStrategySaveFailedPrefix, modelText.unknownError]);

  const handleTestConnection = async () => {
    if (needsApiKey && !config.apiKey && !hasStoredApiKey) {
      toast.warning(modelText.toast.apiKeyRequired);
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
        toast.success(`${modelText.toast.connectionSuccessPrefix}${result.latencyMs}${modelText.toast.connectionSuccessSuffix}`);
      } else if (result?.error) {
        toast.error(`${result.error.message}\n${result.error.suggestion}`);
      } else {
        toast.error(modelText.toast.connectionFailed);
      }
    } catch (err) {
      toast.error(modelText.toast.connectionTestFailedPrefix + (err instanceof Error ? err.message : modelText.unknownError) + modelText.toast.connectionTestFailedSuffix);
    } finally {
      setIsTesting(false);
    }
  };

  const handleDiscoverModels = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!effectiveBaseUrl) {
      if (!silent) toast.warning(modelText.toast.providerAddressRequired);
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
          toast.error(`${result?.error?.message || modelText.toast.modelDiscoveryFailed}${detail}`);
        }
        return;
      }

      if (!result.models.length) {
        if (!silent) toast.warning(modelText.toast.noModelsReturned);
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
          nextModelMap[model.id] = mergeDiscoveredModelEntry(existing, model, shouldEnable, discoveredAt);
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

      if (!silent) toast.success(`${modelText.toast.discoveredModelsPrefix}${result.models.length}${modelText.toast.discoveredModelsSuffix}`);
    } catch (error) {
      if (!silent) toast.error(modelText.toast.modelDiscoveryFailedPrefix + (error instanceof Error ? error.message : modelText.unknownError));
    } finally {
      setIsDiscovering(false);
    }
  }, [config, currentEnabledModels, effectiveBaseUrl, effectiveProtocol, hasStoredApiKey, modelText.toast.discoveredModelsPrefix, modelText.toast.discoveredModelsSuffix, modelText.toast.modelDiscoveryFailed, modelText.toast.modelDiscoveryFailedPrefix, modelText.toast.noModelsReturned, modelText.toast.providerAddressRequired, modelText.unknownError, onChange]);

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
      toast.warning(modelText.toast.providerNameRequired);
      return;
    }
    if (!baseUrl) {
      toast.warning(modelText.toast.providerAddressRequired);
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
    toast.success(modelText.toast.providerAdded);
  }, [config, modelText.toast.providerAdded, modelText.toast.providerAddressRequired, modelText.toast.providerNameRequired, newProviderApiKey, newProviderBaseUrl, newProviderName, newProviderProtocol, onChange, providerConfigs]);

  const handleAddManualModel = useCallback(() => {
    const modelId = manualModelId.trim();
    if (!modelId) {
      toast.warning(modelText.toast.modelIdRequired);
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
    toast.success(modelText.toast.modelAdded);
  }, [config, effectiveBaseUrl, effectiveProtocol, hasStoredApiKey, manualModelId, manualModelLabel, modelText.toast.modelAdded, modelText.toast.modelIdRequired, onChange]);

  const providerTitle = currentProviderConfig?.displayName || selectedProviderRow?.name || config.provider;
  const providerIcon = normalizeProviderIcon(currentProviderConfig?.icon) || providerTitle.slice(0, 1).toUpperCase();
  const providerIconIsImage = isProviderImageIcon(providerIcon);
  const providerIconImageSource = useProviderIconImageSource(providerIcon);
  const providerIconPresets = getProviderIconPresets(config.provider);
  const providerIdentityManaged = isProviderIdentityManaged(currentProviderConfig);

  return (
    <SettingsPage
      title={modelText.title}
      description={modelText.description}
    >
      <WebModeBanner />

      {/* ── 按任务自动切换（置顶，默认关闭；改动即存）── */}
      <TaskStrategySettingsPanel
        settings={appSettings}
        providerConfigs={providerConfigs}
        config={config}
        strategy={taskStrategy}
        disabled={isWebMode()}
        onChange={persistTaskStrategy}
      />

      {/* ── 模型提供商：左 Provider 列表 + 右详情 ── */}
      <SettingsSection title={modelText.providerSection.title} description={modelText.providerSection.description}>
      <div className="grid gap-4 lg:grid-cols-[252px_minmax(0,1fr)] lg:items-start">
        <ProviderListPanel
          configuredRows={configuredRows}
          unconfiguredRows={unconfiguredRows}
          keylessReachability={keylessReachability}
          selectedProviderId={config.provider}
          defaultProviderId={defaultSelection.provider}
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
                  </span>
                  <div>
                    <h4 className="text-base font-semibold text-zinc-100">{providerTitle}</h4>
                    <p className="mt-0.5 max-w-[420px] truncate text-xs text-zinc-500" title={effectiveBaseUrl}>
                      {getProtocolLabel(effectiveProtocol, modelText.helpers)} · {effectiveBaseUrl || modelText.header.unsetAddress}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className={`text-xs ${hasApiKey ? 'text-emerald-300' : 'text-amber-300'}`}>
                    {!needsApiKey ? modelText.header.noApiKey : hasApiKey ? modelText.header.apiKeySaved : modelText.header.waitingApiKey}
                  </span>
                  <label className="flex items-center gap-2 text-xs text-zinc-400" title={modelText.header.selectableTitle}>
                    <span>{modelText.header.selectableLabel}</span>
                    <Toggle
                      checked={currentProviderConfig?.enabled !== false}
                      onChange={(checked) => patchCurrentProviderConfig({ enabled: checked })}
                      aria-label={modelText.header.selectableAriaLabel}
                    />
                  </label>
                </div>
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
              <div className="flex flex-col gap-2 border-t border-zinc-800 pt-4">
                <Button
                  disabled={isWebMode()}
                  onClick={handleSave}
                  loading={isSaving}
                  size="lg"
                  variant={saveStatus === 'error' ? 'danger' : 'primary'}
                  className={`w-full ${saveStatus === 'success' ? '!bg-green-600 hover:!bg-green-500' : ''}`}
                >
                  {isSaving ? t.common.saving || 'Saving...' : saveStatus === 'success' ? t.common.saved || 'Saved!' : saveStatus === 'error' ? t.common.error || 'Error' : modelText.header.saveConfig}
                </Button>
                <span className="text-xs text-zinc-500">
                  {modelText.header.saveHintPrefix}{providerTitle}{modelText.header.saveHintSuffix}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
      </SettingsSection>

      <ProviderDoctorDialog
        isOpen={isDoctorOpen}
        onClose={() => setIsDoctorOpen(false)}
      />
    </SettingsPage>
  );
};
