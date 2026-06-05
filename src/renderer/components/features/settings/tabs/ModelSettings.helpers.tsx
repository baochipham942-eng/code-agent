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
  inferModelCapabilities,
  inferSupportsTool,
  isDynamicCustomProviderId,
  type RuntimeProviderModel,
} from '@shared/modelRuntime';

export interface ProviderDisplayInfo {
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
  selected: boolean;
  selectedModelLabel: string;
  enabledModelCount: number;
}

export type ProviderConfigMap = Partial<Record<string, ModelProviderSettings>>;

export interface DiscoverModelsResult {
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

export interface BuildProviderConfigForSaveOptions {
  currentProviderConfig?: ModelProviderSettings;
  baseUrl: string;
  protocol?: ModelProviderProtocol;
  displayName?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  models?: Record<string, ModelEntrySettings>;
  apiKey?: string;
  needsApiKey: boolean;
  hasStoredApiKey: boolean;
  updatedAt?: number;
}

export function buildProviderConfigForSave({
  currentProviderConfig,
  baseUrl,
  protocol,
  displayName,
  model,
  temperature,
  maxTokens,
  models,
  apiKey,
  needsApiKey,
  hasStoredApiKey,
  updatedAt = Date.now(),
}: BuildProviderConfigForSaveOptions): ModelProviderSettings {
  const providerConfigWithoutKey: ModelProviderSettings = {
    ...(currentProviderConfig ?? { enabled: true }),
  };
  delete providerConfigWithoutKey.apiKey;

  const nextConfig: ModelProviderSettings = {
    ...providerConfigWithoutKey,
    enabled: true,
    baseUrl,
    protocol,
    displayName,
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
}: {
  providers: ProviderDisplayInfo[];
  config: ModelConfig;
  providerConfigs?: ProviderConfigMap;
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
      description: `${provider.description}${providerConfig?.protocol === 'claude' ? ' · Claude 协议' : ''}`,
      modelCount: runtimeModels.length,
      evalEligibleCount: provider.models.filter((model) => model.evalEligible !== false).length,
      enabledModelCount: enabledModels.length,
      defaultModel: rowDefaultModel,
      endpoint: providerConfig?.baseUrl || registryInfo?.endpoint || '-',
      selected: config.provider === provider.id,
      selectedModelLabel: config.provider === provider.id
        ? getModelLabel(runtimeModels, config.model)
        : getModelLabel(runtimeModels, rowDefaultModel),
    };
  });
}

export function getProtocolLabel(protocol: ModelProviderProtocol | undefined): string {
  return protocol === 'claude' ? 'Claude 协议' : 'OpenAI 兼容';
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

export function orderProviderManagementRows(rows: ProviderManagementRow[]): ProviderManagementRow[] {
  const selected = rows.filter((row) => row.selected);
  const rest = rows.filter((row) => !row.selected);
  return [...selected, ...rest];
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
