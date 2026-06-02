import type { ModelConfig, ModelEntrySettings, ModelProvider, ModelProviderSettings } from '@shared/contract';
import { DEFAULT_MODEL, MODEL, PROVIDER_MODELS_MAP, getProviderInfo } from '@shared/constants';
import { getProviderRuntimeModels } from '@shared/modelRuntime';

export interface OnboardingProviderCopy {
  id: ModelProvider;
  name: string;
  description: string;
  badge?: string;
  recommended: boolean;
  /** 中转站/自定义卡片：需要用户填 Base URL，模型列表完全依赖在线发现 */
  requiresBaseUrl?: boolean;
}

export interface OnboardingDiscoveredModel {
  id: string;
  label: string;
  capabilities?: ModelConfig['capabilities'];
  maxTokens?: number;
  supportsTool?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
}

export interface OnboardingModelSelection {
  modelConfig: ModelConfig;
  providerSettings: ModelProviderSettings;
}

export const ONBOARDING_OFFICIAL_PROVIDERS: readonly ModelProvider[] = [
  'deepseek',
  'moonshot',
  'zhipu',
  'qwen',
  'openai',
  'claude',
  'gemini',
  'minimax',
  'grok',
  'groq',
  'perplexity',
  'volcengine',
  'longcat',
  'xiaomi',
];

export const ONBOARDING_RECOMMENDED_PROVIDERS: readonly ModelProvider[] = [
  'deepseek',
  'moonshot',
  'zhipu',
  'qwen',
];

const PROVIDER_COPY: Partial<Record<ModelProvider, Pick<OnboardingProviderCopy, 'name' | 'description' | 'badge'>>> = {
  deepseek: {
    name: 'DeepSeek',
    description: '日常聊天、代码和高性价比任务',
    badge: '推荐默认',
  },
  moonshot: {
    name: 'Kimi / Moonshot',
    description: '长文本、中文写作和文档处理',
    badge: '长文本',
  },
  zhipu: {
    name: '智谱 GLM',
    description: '国内直连、视觉和多模态能力',
    badge: '国内可用',
  },
  qwen: {
    name: 'Qwen',
    description: '办公文档、多模态和国内生态',
    badge: '办公场景',
  },
  openai: {
    name: 'OpenAI',
    description: 'GPT 系列官方 API',
  },
  claude: {
    name: 'Claude',
    description: 'Anthropic 官方 API',
  },
  gemini: {
    name: 'Gemini',
    description: 'Google Gemini 官方 API',
  },
  minimax: {
    name: 'MiniMax',
    description: 'MiniMax 官方 API',
  },
  grok: {
    name: 'Grok',
    description: 'xAI Grok 官方 API',
  },
  groq: {
    name: 'Groq',
    description: '高速推理官方 API',
  },
  perplexity: {
    name: 'Perplexity',
    description: '联网搜索官方 API',
  },
  volcengine: {
    name: '火山 / 豆包',
    description: '火山引擎 Ark 官方 API',
  },
  longcat: {
    name: 'LongCat',
    description: 'LongCat API 开放平台',
  },
  xiaomi: {
    name: '小米 MiMo',
    description: '小米 MiMo Token Plan',
  },
};

/** 中转站/自定义卡片（OpenAI 兼容），让只有中转 key 的新用户也能完成 onboarding */
export const ONBOARDING_RELAY_CARD: OnboardingProviderCopy = {
  id: 'custom',
  name: '中转站 / 自定义',
  description: 'OpenAI 兼容中转站（new-api / one-api 等），填接口地址和 Key',
  badge: '中转',
  recommended: false,
  requiresBaseUrl: true,
};

export function getOnboardingProviderCards(): OnboardingProviderCopy[] {
  return ONBOARDING_OFFICIAL_PROVIDERS.map((id) => {
    const registry = getProviderInfo(id);
    const copy = PROVIDER_COPY[id];
    return {
      id,
      name: copy?.name || registry?.displayName || id,
      description: copy?.description || `${registry?.displayName || id} 官方 API`,
      badge: copy?.badge,
      recommended: ONBOARDING_RECOMMENDED_PROVIDERS.includes(id),
    };
  });
}

export function selectOnboardingDefaultModel(
  provider: ModelProvider,
  discoveredModels: OnboardingDiscoveredModel[] = [],
): string {
  const providerDefault = getProviderInfo(provider)?.defaultModel;
  if (providerDefault && discoveredModels.some((model) => model.id === providerDefault)) {
    return providerDefault;
  }
  if (discoveredModels[0]?.id) {
    return discoveredModels[0].id;
  }
  return providerDefault || getProviderRuntimeModels(PROVIDER_MODELS_MAP[provider]).find(Boolean)?.id || DEFAULT_MODEL;
}

function getBuiltinModelEntry(provider: ModelProvider, modelId: string): ModelEntrySettings {
  const runtimeModels = getProviderRuntimeModels(PROVIDER_MODELS_MAP[provider]);
  const runtimeModel = runtimeModels.find((model) => model.id === modelId)
    || runtimeModels.find(Boolean);
  return {
    enabled: true,
    label: runtimeModel?.label || modelId,
    capabilities: runtimeModel?.capabilities,
    maxTokens: runtimeModel?.maxTokens,
    supportsTool: runtimeModel?.supportsTool,
    supportsVision: runtimeModel?.supportsVision,
    supportsStreaming: runtimeModel?.supportsStreaming,
  };
}

export function buildOnboardingModelSelection({
  provider,
  apiKey,
  baseUrl,
  discoveredModels = [],
}: {
  provider: ModelProvider;
  apiKey: string;
  baseUrl?: string;
  discoveredModels?: OnboardingDiscoveredModel[];
}): OnboardingModelSelection {
  const selectedModel = selectOnboardingDefaultModel(provider, discoveredModels);
  const modelEntries: Record<string, ModelEntrySettings> = {};
  const discoveredAt = Date.now();

  for (const model of discoveredModels) {
    modelEntries[model.id] = {
      enabled: true,
      label: model.label || model.id,
      capabilities: model.capabilities,
      maxTokens: model.maxTokens,
      supportsTool: model.supportsTool,
      supportsVision: model.supportsVision,
      supportsStreaming: model.supportsStreaming,
      discoveredAt,
    };
  }

  if (!modelEntries[selectedModel]) {
    modelEntries[selectedModel] = getBuiltinModelEntry(provider, selectedModel);
  }

  const providerSettings: ModelProviderSettings = {
    enabled: true,
    apiKey,
    baseUrl: baseUrl || getProviderInfo(provider)?.endpoint,
    model: selectedModel,
    temperature: MODEL.DEFAULT_TEMPERATURE,
    models: modelEntries,
  };

  return {
    providerSettings,
    modelConfig: {
      provider,
      model: selectedModel,
      apiKey,
      baseUrl: providerSettings.baseUrl,
      temperature: MODEL.DEFAULT_TEMPERATURE,
      maxTokens: modelEntries[selectedModel]?.maxTokens,
      capabilities: modelEntries[selectedModel]?.capabilities,
    },
  };
}
