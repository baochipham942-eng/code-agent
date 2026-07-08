import React from 'react';
import type {
  AppSettings,
  ModelConfig,
  ModelCapability,
  ModelEntrySettings,
  ModelProvider,
  ModelProviderProtocol,
  ModelProviderSettings,
} from '@shared/contract';
import { getProviderEndpointForProtocol, getProviderInfo } from '@shared/constants';
import type { ProviderInfo, ProviderModelEntry } from '@shared/constants';
import {
  getEnabledProviderModels,
  getProviderRuntimeModels,
  hasConfiguredDefaultRuntimeModel,
  inferModelCapabilities,
  inferSupportsTool,
  isDynamicCustomProviderId,
  isPureGenerationModel,
  isRuntimeProviderAvailable,
  normalizeProviderIcon,
  type ProviderIconValidationResult,
  type RuntimeProviderModel,
} from '@shared/modelRuntime';
import { zh } from '../../../../i18n/zh';

export type ModelSettingsHelperLabels = typeof zh.settings.model.helpers;

export interface ProviderDisplayInfo {
  id: ModelProvider;
  name: string;
  description: string;
  models: ProviderModelEntry[];
}

export interface ProviderManagementRow {
  id: ModelProvider;
  name: string;
  icon?: string;
  favorite: boolean;
  description: string;
  modelCount: number;
  evalEligibleCount: number;
  defaultModel: string;
  endpoint: string;
  selected: boolean;
  selectedModelLabel: string;
  enabledModelCount: number;
  /** true=无需 API Key 的本地 provider，可用性取决于本地服务是否在跑而非 Key */
  keyless: boolean;
}

export type ProviderConfigMap = Partial<Record<string, ModelProviderSettings>>;

export interface DiscoverModelsResult {
  success: boolean;
  models: Array<{
    id: string;
    label: string;
    capabilities: ModelCapability[];
    maxTokens?: number;
    contextWindow?: number;
    supportsTool: boolean;
    supportsVision: boolean;
    supportsStreaming: boolean;
  }>;
  latencyMs: number;
  error?: { code: string; message: string; suggestion?: string };
}

export interface BuildProviderConfigForSaveOptions {
  currentProviderConfig?: ModelProviderSettings;
  baseUrl: string;
  protocol?: ModelProviderProtocol;
  displayName?: string;
  icon?: string;
  favorite?: boolean;
  model: string;
  temperature?: number;
  maxTokens?: number;
  models?: Record<string, ModelEntrySettings>;
  apiKey?: string;
  needsApiKey: boolean;
  hasStoredApiKey: boolean;
  updatedAt?: number;
}

export function describeProviderIconValidationError(
  result: ProviderIconValidationResult,
  labels: ModelSettingsHelperLabels = zh.settings.model.helpers,
): string | null {
  if (result.valid) return null;
  if (result.reason === 'image-too-large') {
    const sizeDetail = result.imageBytes !== undefined
      ? `${labels.iconSizePrefix}${(result.imageBytes / 1024).toFixed(1)}${labels.iconSizeMiddle}`
      : '';
    return `${sizeDetail}${labels.iconTooLarge}`;
  }
  if (result.reason === 'unsupported-asset-ref') {
    return labels.iconUnsupportedAssetRef;
  }
  return labels.iconUnsupportedValue;
}

export function isProviderIdentityManaged(providerConfig?: Pick<ModelProviderSettings, 'managedByCloud'> | null): boolean {
  return providerConfig?.managedByCloud === true;
}

export function buildProviderConfigForSave({
  currentProviderConfig,
  baseUrl,
  protocol,
  displayName,
  icon = currentProviderConfig?.icon,
  favorite = currentProviderConfig?.favorite,
  model,
  temperature,
  maxTokens,
  models,
  apiKey,
  needsApiKey,
  hasStoredApiKey,
  updatedAt = Date.now(),
}: BuildProviderConfigForSaveOptions): ModelProviderSettings {
  const providerIdentityManaged = isProviderIdentityManaged(currentProviderConfig);
  const providerConfigWithoutKey: ModelProviderSettings = {
    ...(currentProviderConfig ?? { enabled: true }),
  };
  delete providerConfigWithoutKey.apiKey;

  const nextConfig: ModelProviderSettings = {
    ...providerConfigWithoutKey,
    enabled: true,
    baseUrl,
    protocol,
    displayName: providerIdentityManaged ? currentProviderConfig?.displayName : displayName,
    icon: normalizeProviderIcon(providerIdentityManaged ? currentProviderConfig?.icon : icon),
    favorite,
    model,
    temperature,
    maxTokens,
    updatedAt,
    models,
    apiKeyConfigured: needsApiKey ? Boolean(apiKey?.trim() || hasStoredApiKey) : false,
  };

  if (apiKey?.trim()) {
    nextConfig.apiKey = apiKey.trim();
  }

  return nextConfig;
}

export function buildProviderSettingsUpdate(
  provider: ModelProvider,
  providerConfig: ModelProviderSettings,
): Partial<AppSettings> {
  return {
    models: {
      providers: {
        [provider]: providerConfig,
      },
    },
  } as Partial<AppSettings>;
}

/** 保存 provider 配置后，是否应把全局默认模型自动切到该 provider。
 *  默认指针与"已配置 provider"是两份状态：出厂默认（xiaomi/mimo）没 key 时，
 *  用户配好别家 key 后默认指针不会自己动，发送被门禁拦下（"明明配置了还说没配置"）。
 *  仅当刚保存的 provider 可用、且当前默认模型不可用时才接管，不抢用户已生效的默认。 */
export function shouldPromoteProviderToDefault(
  provider: ModelProvider,
  providerConfig: ModelProviderSettings,
  settings: AppSettings | null | undefined,
): boolean {
  if (providerConfig.enabled === false) return false;
  if (!isRuntimeProviderAvailable(provider, providerConfig)) return false;
  return !hasConfiguredDefaultRuntimeModel(settings);
}

export function buildDefaultModelSettingsUpdate(
  provider: ModelProvider,
  providerConfig: ModelProviderSettings,
): Partial<AppSettings> {
  return {
    models: {
      default: provider,
      defaultProvider: provider,
      providers: {
        [provider]: providerConfig,
      },
    },
  } as Partial<AppSettings>;
}

export function renderModelOptions(models: Array<Pick<ProviderModelEntry, 'id' | 'label' | 'group'>>): React.ReactNode {
  const hasGroups = models.some((model) => model.group);
  if (!hasGroups) {
    return models.map((model) => (
      <option key={model.id} value={model.id}>{model.label}</option>
    ));
  }

  const groups: { label: string; items: ProviderModelEntry[] }[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const groupLabel = model.group || '';
    if (!seen.has(groupLabel)) {
      seen.add(groupLabel);
      groups.push({ label: groupLabel, items: [] });
    }
    groups.find((group) => group.label === groupLabel)?.items.push(model as ProviderModelEntry);
  }

  return groups.map((group) => (
    <optgroup key={group.label} label={group.label}>
      {group.items.map((model) => (
        <option key={model.id} value={model.id}>{model.label}</option>
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
  labels = zh.settings.model.helpers,
}: {
  providers: ProviderDisplayInfo[];
  config: ModelConfig;
  providerConfigs?: ProviderConfigMap;
  labels?: ModelSettingsHelperLabels;
}): ProviderManagementRow[] {
  return providers.map((provider) => {
    const registryInfo = getProviderInfo(provider.id);
    const providerConfig = providerConfigs?.[provider.id];
    const runtimeModels = getProviderRuntimeModels(provider, providerConfig);
    const enabledModels = runtimeModels.filter((model) => model.enabled);
    const rowDefaultModel = providerConfig?.model || registryInfo?.defaultModel || runtimeModels[0]?.id || '-';
    return {
      id: provider.id,
      name: providerConfig?.displayName || provider.name,
      ...(normalizeProviderIcon(providerConfig?.icon) ? { icon: normalizeProviderIcon(providerConfig?.icon) } : {}),
      favorite: providerConfig?.favorite === true,
      description: `${provider.description}${providerConfig?.protocol === 'claude' ? labels.claudeProtocolSuffix : ''}`,
      modelCount: runtimeModels.length,
      evalEligibleCount: provider.models.filter((model) => model.evalEligible !== false).length,
      enabledModelCount: enabledModels.length,
      defaultModel: rowDefaultModel,
      endpoint: providerConfig?.baseUrl || registryInfo?.endpoint || '-',
      selected: config.provider === provider.id,
      selectedModelLabel: config.provider === provider.id
        ? getModelLabel(runtimeModels, config.model)
        : getModelLabel(runtimeModels, rowDefaultModel),
      keyless: !providerRequiresApiKey(provider.id),
    };
  });
}

/** keyless provider（local/Ollama）的可用性展示：探测结果 → 状态 + 文案。
 *  undefined=探测未完成，不能直接展示成已可用（假性可用是 dogfood 实测踩坑）。 */
export function describeKeylessReadiness(
  reachable: boolean | undefined,
  labels: ModelSettingsHelperLabels = zh.settings.model.helpers,
): {
  state: 'checking' | 'running' | 'unavailable';
  label: string;
} {
  if (reachable === true) return { state: 'running', label: labels.keylessRunning };
  if (reachable === false) return { state: 'unavailable', label: labels.keylessUnavailable };
  return { state: 'checking', label: labels.keylessChecking };
}

export function getProtocolLabel(
  protocol: ModelProviderProtocol | undefined,
  labels: ModelSettingsHelperLabels = zh.settings.model.helpers,
): string {
  return protocol === 'claude' ? labels.protocolClaude : labels.protocolOpenai;
}

export function providerRequiresApiKey(providerId: ModelProvider): boolean {
  return providerId !== 'local';
}

export function isModelMetadataLocked(providerId: ModelProvider, model: RuntimeProviderModel): boolean {
  return model.source === 'catalog' && providerId !== 'custom' && !isDynamicCustomProviderId(providerId);
}

export function normalizeLongCatModelId(modelId?: string): string {
  return modelId?.toLowerCase() === 'longcat-2.0-preview'
    ? 'LongCat-2.0-Preview'
    : modelId || 'LongCat-2.0-Preview';
}

export function isLegacyLongCatProviderConfig(
  providerId: ModelProvider,
  providerConfig?: Partial<ModelProviderSettings>,
): boolean {
  if (providerId !== 'custom' || !providerConfig) {
    return false;
  }
  const baseUrl = providerConfig.baseUrl?.toLowerCase() || '';
  const displayName = providerConfig.displayName?.trim().toLowerCase() || '';
  return baseUrl.includes('api.longcat.chat') || displayName === 'longcat';
}

export function buildLegacyLongCatProviderMigration(
  config: ModelConfig,
  providerConfigs: ProviderConfigMap,
): { providerConfigs: ProviderConfigMap; config: ModelConfig } | null {
  const legacy = providerConfigs.custom;
  if (config.provider !== 'custom' || !isLegacyLongCatProviderConfig('custom', legacy)) return null;

  const model = normalizeLongCatModelId(legacy?.model || config.model);
  const protocol = legacy?.protocol ?? 'openai';
  const baseUrl = legacy?.baseUrl || getProviderEndpointForProtocol('longcat', protocol) || '';
  const legacyModelSettings = legacy?.models?.[legacy.model || ''] ?? legacy?.models?.[model];
  const capabilities: ModelCapability[] = ['general', 'code', 'reasoning', 'longContext'];
  const longcat: ModelProviderSettings = {
    ...(providerConfigs.longcat ?? { enabled: true }),
    ...(legacy ?? { enabled: true }),
    enabled: true,
    displayName: 'LongCat',
    protocol,
    baseUrl,
    model,
    models: {
      ...legacy?.models,
      [model]: {
        enabled: true,
        label: 'LongCat 2.0 Preview',
        capabilities,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
        ...legacyModelSettings,
      },
    },
  };
  return {
    providerConfigs: {
      longcat,
      custom: {
        ...(providerConfigs.custom ?? { enabled: false }),
        enabled: false,
        displayName: 'Custom Provider',
        baseUrl: undefined,
        model: 'custom-model',
        models: undefined,
      },
    },
    config: {
      ...config,
      provider: 'longcat',
      model,
      baseUrl,
      protocol,
      apiKey: legacy?.apiKey || config.apiKey,
      capabilities: longcat.models?.[model]?.capabilities,
      maxTokens: longcat.models?.[model]?.maxTokens ?? config.maxTokens,
    },
  };
}

export function hasCustomEndpointOverride(
  providerId: ModelProvider,
  configuredBaseUrl?: string,
  protocol?: ModelProviderProtocol,
): boolean {
  if (providerId === 'custom' || isDynamicCustomProviderId(providerId)) {
    return false;
  }
  const officialEndpoint = getProviderEndpointForProtocol(providerId, protocol);
  if (!officialEndpoint) {
    return false;
  }
  const normalizeEndpoint = (value: string) => value.trim().replace(/\/+$/, '');
  return normalizeEndpoint(configuredBaseUrl ?? '') !== normalizeEndpoint(officialEndpoint);
}

// 默认 provider 置顶，其余保持稳定顺序（不再按「选中」排序，避免点击就跳到最前）。
export function orderProviderManagementRows(
  rows: ProviderManagementRow[],
  defaultProviderId?: string,
): ProviderManagementRow[] {
  if (!defaultProviderId) return rows;
  const def = rows.filter((row) => row.id === defaultProviderId);
  if (def.length === 0) return rows;
  const rest = rows.filter((row) => row.id !== defaultProviderId);
  return [...def, ...rest];
}

export function buildManualModelSettings(
  modelId: string,
  label?: string,
  discoveredAt = Date.now(),
): ModelEntrySettings {
  const trimmedId = modelId.trim();
  const capabilities = inferModelCapabilities(trimmedId);
  return {
    label: label?.trim() || trimmedId,
    enabled: true,
    capabilities,
    supportsTool: inferSupportsTool(trimmedId, capabilities),
    supportsVision: capabilities.includes('vision'),
    supportsStreaming: true,
    discoveredAt,
  };
}

/**
 * 重发现时合并单个模型条目。
 * 纯生成模型（新推断判定）用新推断 caps 覆盖已存（修正旧 vision 误标 + 补 gen 标签 + 移出聊天）；
 * 聊天/混合模型保留已存 caps（不丢 API 来源的 vision 等）。其余结构字段保留用户已存偏好。
 */
export function mergeDiscoveredModelEntry(
  existing: ModelEntrySettings | undefined,
  discovered: {
    id: string;
    label: string;
    capabilities: ModelCapability[];
    maxTokens?: number;
    contextWindow?: number;
    supportsTool?: boolean;
    supportsVision?: boolean;
    supportsStreaming?: boolean;
  },
  shouldEnable: boolean,
  discoveredAt: number,
): ModelEntrySettings {
  const overwriteGenCaps = isPureGenerationModel(discovered.capabilities);
  const capabilities = overwriteGenCaps
    ? discovered.capabilities
    : (existing?.capabilities || discovered.capabilities);
  return {
    ...existing,
    label: existing?.label || discovered.label,
    enabled: shouldEnable,
    capabilities,
    maxTokens: existing?.maxTokens ?? discovered.maxTokens,
    contextWindow: existing?.contextWindow ?? discovered.contextWindow,
    supportsTool: overwriteGenCaps
      ? (discovered.supportsTool ?? false)
      : (existing?.supportsTool ?? discovered.supportsTool),
    supportsVision: overwriteGenCaps
      ? capabilities.includes('vision')
      : (existing?.supportsVision ?? discovered.supportsVision),
    supportsStreaming: existing?.supportsStreaming ?? discovered.supportsStreaming,
    discoveredAt,
  };
}

export function createCustomProviderId(name: string, existingIds: Iterable<string>): ModelProvider {
  const existing = new Set(existingIds);
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const baseId = `custom-${slug || 'provider'}`;
  let candidate = baseId;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return candidate as ModelProvider;
}
