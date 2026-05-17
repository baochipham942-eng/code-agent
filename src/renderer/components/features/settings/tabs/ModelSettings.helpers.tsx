import React from 'react';
import type {
  ModelConfig,
  ModelCapability,
  ModelEntrySettings,
  ModelProvider,
  ModelProviderSettings,
} from '@shared/contract';
import { getProviderInfo } from '@shared/constants';
import type { ProviderInfo, ProviderModelEntry } from '@shared/constants';
import {
  getEnabledProviderModels,
  getProviderRuntimeModels,
  inferModelCapabilities,
  inferSupportsTool,
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
      selected: config.provider === provider.id,
      selectedModelLabel: config.provider === provider.id
        ? getModelLabel(runtimeModels, config.model)
        : getModelLabel(runtimeModels, registryInfo?.defaultModel || runtimeModels[0]?.id || '-'),
    };
  });
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
