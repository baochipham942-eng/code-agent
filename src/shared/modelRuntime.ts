import type { AppSettings, ModelCapability, ModelProvider, ModelProviderProtocol, ModelProviderSettings } from './contract';
import {
  MODEL_FEATURES,
  PROVIDER_MODELS,
  PROVIDER_MODELS_MAP,
  getModelDisplayLabel,
  getProviderDisplayName,
  getProviderInfo,
  type ProviderInfo,
  type ProviderModelEntry,
} from './constants';

export type RuntimeModelFeature = 'tool' | 'vision' | 'reasoning';

export interface RuntimeProviderModel extends ProviderModelEntry {
  enabled: boolean;
  capabilities: ModelCapability[];
  supportsTool: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  maxTokens?: number;
  source: 'catalog' | 'discovered';
}

export interface RuntimeModelOption {
  provider: ModelProvider;
  model: string;
  label: string;
  providerLabel: string;
  features: RuntimeModelFeature[];
}

export const MODEL_CAPABILITY_OPTIONS: Array<{ id: ModelCapability; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'code', label: '代码' },
  { id: 'reasoning', label: '推理' },
  { id: 'vision', label: '视觉' },
  { id: 'fast', label: '快速' },
  { id: 'longContext', label: '长上下文' },
  { id: 'search', label: '搜索' },
];

const DEFAULT_SWITCHER_PROVIDERS: ModelProvider[] = [
  'moonshot',
  'deepseek',
  'zhipu',
  'openai',
  'claude',
  'volcengine',
  'local',
  'xiaomi',
  'custom',
];

export function isDynamicCustomProviderId(providerId: string): boolean {
  return /^custom-[a-z0-9][a-z0-9-]*$/i.test(providerId);
}

export function resolveProviderProtocol(
  providerId: string,
  providerConfig?: Partial<ModelProviderSettings>,
): ModelProviderProtocol {
  if (providerConfig?.protocol) return providerConfig.protocol;
  if (providerId === 'claude' || providerId === 'anthropic') return 'claude';
  return 'openai';
}

function uniqueCapabilities(values: Array<ModelCapability | undefined>): ModelCapability[] {
  return Array.from(new Set(values.filter(Boolean) as ModelCapability[]));
}

export function inferModelCapabilities(modelId: string): ModelCapability[] {
  const id = modelId.toLowerCase();
  const capabilities: ModelCapability[] = ['general'];

  if (/code|coder|codex|dev/.test(id)) capabilities.push('code');
  if (/vision|vl|omni|4o|image|multimodal|mm/.test(id)) capabilities.push('vision');
  if (/reason|thinking|think|r1|o1|o3|o4|k2\.6|glm-5/.test(id)) capabilities.push('reasoning');
  if (/flash|fast|mini|nano|lite|turbo/.test(id)) capabilities.push('fast');
  if (/1m|128k|200k|256k|long/.test(id)) capabilities.push('longContext');
  if (/sonar|search|perplexity/.test(id)) capabilities.push('search');

  return uniqueCapabilities(capabilities);
}

export function inferSupportsTool(modelId: string, capabilities: ModelCapability[] = inferModelCapabilities(modelId)): boolean {
  const id = modelId.toLowerCase();
  if (/embed|embedding|rerank|tts|audio|whisper|speech|image|video/.test(id) && !/omni|vision|vl|4o/.test(id)) {
    return false;
  }
  return capabilities.includes('code') || capabilities.includes('general') || capabilities.includes('reasoning') || capabilities.includes('fast');
}

export function featuresFromModelMetadata(args: {
  modelId: string;
  capabilities?: ModelCapability[];
  supportsTool?: boolean;
  supportsVision?: boolean;
}): RuntimeModelFeature[] {
  const staticFeatures = MODEL_FEATURES[args.modelId] ?? [];
  const capabilities = args.capabilities ?? inferModelCapabilities(args.modelId);
  const supportsTool = args.supportsTool ?? inferSupportsTool(args.modelId, capabilities);
  const supportsVision = args.supportsVision ?? capabilities.includes('vision');
  const features: RuntimeModelFeature[] = [];

  if (supportsTool || staticFeatures.includes('tool')) features.push('tool');
  if (supportsVision || staticFeatures.includes('vision') || capabilities.includes('vision')) features.push('vision');
  if (staticFeatures.includes('reasoning') || capabilities.includes('reasoning')) features.push('reasoning');

  return Array.from(new Set(features));
}

export function buildProviderInfoFromSettings(
  providerId: ModelProvider,
  providerConfig?: Partial<ModelProviderSettings>,
  catalogProvider: ProviderInfo | undefined = PROVIDER_MODELS_MAP[providerId],
): ProviderInfo | undefined {
  if (catalogProvider) {
    return {
      ...catalogProvider,
      name: providerConfig?.displayName || catalogProvider.name,
    };
  }

  if (!providerConfig) return undefined;

  const models: ProviderModelEntry[] = Object.entries(providerConfig.models ?? {}).map(([modelId, settings]) => ({
    id: modelId,
    label: settings.label || modelId,
  }));

  if (providerConfig.model && !models.some((model) => model.id === providerConfig.model)) {
    models.unshift({
      id: providerConfig.model,
      label: providerConfig.models?.[providerConfig.model]?.label || providerConfig.model,
    });
  }

  const protocol = resolveProviderProtocol(providerId, providerConfig);

  return {
    id: providerId,
    name: providerConfig.displayName || providerId,
    description: providerConfig.baseUrl
      ? `${protocol === 'claude' ? 'Claude-compatible' : 'OpenAI-compatible'} · ${providerConfig.baseUrl}`
      : `${protocol === 'claude' ? 'Claude-compatible' : 'OpenAI-compatible'} custom provider`,
    models: models.length > 0 ? models : [{ id: 'custom-model', label: 'Custom Model' }],
  };
}

export function getProviderRuntimeModels(
  provider: ProviderInfo | undefined,
  providerConfig?: Partial<ModelProviderSettings>,
): RuntimeProviderModel[] {
  if (!provider) return [];

  const byId = new Map<string, RuntimeProviderModel>();
  for (const model of provider.models) {
    const override = providerConfig?.models?.[model.id];
    const capabilities = override?.capabilities ?? inferModelCapabilities(model.id);
    const supportsVision = override?.supportsVision ?? capabilities.includes('vision') ?? false;
    const supportsTool = override?.supportsTool ?? inferSupportsTool(model.id, capabilities);
    byId.set(model.id, {
      ...model,
      label: override?.label || model.label,
      enabled: override?.enabled ?? (provider.id === 'custom' ? false : true),
      capabilities,
      maxTokens: override?.maxTokens,
      supportsTool,
      supportsVision,
      supportsStreaming: override?.supportsStreaming ?? true,
      source: 'catalog',
    });
  }

  for (const [modelId, override] of Object.entries(providerConfig?.models ?? {})) {
    if (byId.has(modelId)) continue;
    const capabilities = override.capabilities ?? inferModelCapabilities(modelId);
    byId.set(modelId, {
      id: modelId,
      label: override.label || modelId,
      enabled: override.enabled ?? false,
      capabilities,
      maxTokens: override.maxTokens,
      supportsTool: override.supportsTool ?? inferSupportsTool(modelId, capabilities),
      supportsVision: override.supportsVision ?? capabilities.includes('vision'),
      supportsStreaming: override.supportsStreaming ?? true,
      source: 'discovered',
    });
  }

  return Array.from(byId.values());
}

export function getEnabledProviderModels(
  provider: ProviderInfo | undefined,
  providerConfig?: Partial<ModelProviderSettings>,
): RuntimeProviderModel[] {
  return getProviderRuntimeModels(provider, providerConfig).filter((model) => model.enabled);
}

export function getRuntimeModelLabel(
  modelId: string,
  provider?: ModelProvider,
  settings?: AppSettings | null,
): string {
  if (provider && settings?.models?.providers?.[provider]?.models?.[modelId]?.label) {
    return settings.models.providers[provider].models?.[modelId]?.label || modelId;
  }
  return getModelDisplayLabel(modelId);
}

export function buildRuntimeModelOptions(
  settings?: AppSettings | null,
  providerIds: readonly ModelProvider[] = DEFAULT_SWITCHER_PROVIDERS,
): RuntimeModelOption[] {
  const options: RuntimeModelOption[] = [];
  const dynamicProviderIds = settings
    ? (Object.keys(settings.models?.providers ?? {}) as ModelProvider[]).filter(isDynamicCustomProviderId)
    : [];
  const sourceProviderIds = settings
    ? Array.from(new Set<ModelProvider>([
      ...providerIds,
      ...dynamicProviderIds,
    ]))
    : [...providerIds];

  for (const providerId of sourceProviderIds) {
    const providerConfig = settings?.models?.providers?.[providerId];
    const provider = buildProviderInfoFromSettings(providerId, providerConfig);
    if (!provider) continue;

    if (settings && providerConfig?.enabled === false) continue;

    const providerLabel = providerConfig?.displayName || getProviderDisplayName(providerId) || provider.name;
    for (const model of getEnabledProviderModels(provider, providerConfig)) {
      options.push({
        provider: providerId,
        model: model.id,
        label: model.label || getModelDisplayLabel(model.id),
        providerLabel,
        features: featuresFromModelMetadata({
          modelId: model.id,
          capabilities: model.capabilities,
          supportsTool: model.supportsTool,
          supportsVision: model.supportsVision,
        }),
      });
    }
  }

  if (options.length > 0 || settings) return options;

  return PROVIDER_MODELS.flatMap((provider) =>
    provider.models.map((model) => ({
      provider: provider.id,
      model: model.id,
      label: getModelDisplayLabel(model.id),
      providerLabel: getProviderInfo(provider.id)?.displayName || provider.name,
      features: featuresFromModelMetadata({ modelId: model.id }),
    }))
  );
}
