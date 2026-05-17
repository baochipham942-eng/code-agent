import type { BuiltInModelProvider, ModelProviderAlias } from '../contract';
import { DEFAULT_MODEL } from './defaults';
import { DEFAULT_MODELS } from './models';

// ============================================================================
// AI 模型 API 端点
// ============================================================================

export const MODEL_API_ENDPOINTS = {
  /** DeepSeek */
  deepseek: 'https://api.deepseek.com/v1',
  /** Anthropic Claude */
  claude: 'https://api.anthropic.com/v1',
  /** OpenAI */
  openai: 'https://api.openai.com/v1',
  /** Groq */
  groq: 'https://api.groq.com/openai/v1',
  /** 智谱 GLM (OKI 代理) */
  zhipu: 'https://api.0ki.cn/api/paas/v4',
  /** 智谱官方 API (图像生成等 0ki 不支持的功能) */
  zhipuOfficial: 'https://open.bigmodel.cn/api/paas/v4',
  /** 智谱 Coding 套餐 (OKI 代理) */
  zhipuCoding: 'https://api.0ki.cn/api/coding/paas/v4',
  /** 通义千问 (国际版) */
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  /** Moonshot/Kimi */
  moonshot: 'https://api.moonshot.cn/v1',
  /** Kimi K2.5 (Coding 套餐) */
  kimiK25: 'https://api.kimi.com/coding/v1',
  /** MiniMax */
  minimax: 'https://api.minimax.chat/v1',
  /** Perplexity */
  perplexity: 'https://api.perplexity.ai',
  /** xAI Grok */
  grok: 'https://api.x.ai/v1',
  /** OpenRouter */
  openrouter: 'https://openrouter.ai/api/v1',
  /** Google Gemini */
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  /** 火山引擎 Ark (豆包 GUI 自动化) */
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  /** LongCat API 开放平台 (OpenAI 兼容) */
  longcat: 'https://api.longcat.chat/openai/v1',
  /** LongCat API 开放平台 (Anthropic/Claude 兼容) */
  longcatClaude: 'https://api.longcat.chat/anthropic/v1',
  /** 小米 MiMo Token Plan (新加坡节点，OpenAI 兼容) */
  xiaomi: 'https://token-plan-sgp.xiaomimimo.com/v1',
  /** Custom OpenAI-compatible provider */
  custom: 'https://api.example.com/v1',
  /** Local Ollama */
  ollama: 'http://localhost:11434/v1',
} as const;

export interface CanonicalProviderInfo {
  aliases: readonly ModelProviderAlias[];
  defaultModel: string;
  endpoint: string;
  displayName: string;
}

/**
 * Canonical provider registry.
 * 所有 provider 级别元数据统一从这里读取，避免 renderer / main / cloud 漂移。
 */
export const PROVIDER_REGISTRY: Record<BuiltInModelProvider, CanonicalProviderInfo> = {
  deepseek: {
    aliases: ['deepseek'],
    defaultModel: 'deepseek-v4-flash',
    endpoint: MODEL_API_ENDPOINTS.deepseek,
    displayName: 'DeepSeek',
  },
  claude: {
    aliases: ['claude', 'anthropic'],
    defaultModel: DEFAULT_MODEL,
    endpoint: MODEL_API_ENDPOINTS.claude,
    displayName: 'Anthropic Claude',
  },
  openai: {
    aliases: ['openai'],
    defaultModel: 'gpt-5.5',
    endpoint: MODEL_API_ENDPOINTS.openai,
    displayName: 'OpenAI',
  },
  gemini: {
    aliases: ['gemini'],
    defaultModel: 'gemini-3.1-pro-preview',
    endpoint: MODEL_API_ENDPOINTS.gemini,
    displayName: 'Google Gemini',
  },
  groq: {
    aliases: ['groq'],
    defaultModel: 'llama-3.3-70b-versatile',
    endpoint: MODEL_API_ENDPOINTS.groq,
    displayName: 'Groq',
  },
  local: {
    aliases: ['local'],
    defaultModel: 'qwen2.5-coder:7b',
    endpoint: MODEL_API_ENDPOINTS.ollama,
    displayName: 'Local (Ollama)',
  },
  zhipu: {
    aliases: ['zhipu'],
    defaultModel: 'glm-5',
    endpoint: MODEL_API_ENDPOINTS.zhipu,
    displayName: 'Zhipu GLM',
  },
  qwen: {
    aliases: ['qwen'],
    defaultModel: 'qwen3-max',
    endpoint: MODEL_API_ENDPOINTS.qwen,
    displayName: 'Qwen',
  },
  moonshot: {
    aliases: ['moonshot'],
    defaultModel: 'kimi-k2.5',
    endpoint: MODEL_API_ENDPOINTS.moonshot,
    displayName: 'Kimi',
  },
  minimax: {
    aliases: ['minimax'],
    defaultModel: 'MiniMax-M2.7',
    endpoint: MODEL_API_ENDPOINTS.minimax,
    displayName: 'MiniMax',
  },
  perplexity: {
    aliases: ['perplexity'],
    defaultModel: 'sonar-pro',
    endpoint: MODEL_API_ENDPOINTS.perplexity,
    displayName: 'Perplexity',
  },
  grok: {
    aliases: ['grok'],
    defaultModel: 'grok-4-1-fast-non-reasoning',
    endpoint: MODEL_API_ENDPOINTS.grok,
    displayName: 'Grok',
  },
  openrouter: {
    aliases: ['openrouter'],
    defaultModel: 'google/gemini-3-flash-preview',
    endpoint: MODEL_API_ENDPOINTS.openrouter,
    displayName: 'OpenRouter',
  },
  volcengine: {
    aliases: ['volcengine'],
    defaultModel: 'doubao-1.5-pro-256k',
    endpoint: MODEL_API_ENDPOINTS.volcengine,
    displayName: '火山引擎 (豆包)',
  },
  longcat: {
    aliases: ['longcat'],
    defaultModel: 'LongCat-2.0-Preview',
    endpoint: MODEL_API_ENDPOINTS.longcat,
    displayName: 'LongCat',
  },
  xiaomi: {
    aliases: ['xiaomi'],
    defaultModel: 'mimo-v2.5-pro',
    endpoint: MODEL_API_ENDPOINTS.xiaomi,
    displayName: '小米 MiMo',
  },
  custom: {
    aliases: ['custom'],
    defaultModel: 'custom-model',
    endpoint: MODEL_API_ENDPOINTS.custom,
    displayName: 'Custom Provider',
  },
};

export const PROVIDER_ALIAS_MAP: Record<ModelProviderAlias, BuiltInModelProvider> = Object.freeze(
  Object.entries(PROVIDER_REGISTRY).reduce((acc, [provider, config]) => {
    for (const alias of config.aliases) {
      acc[alias] = provider as BuiltInModelProvider;
    }
    return acc;
  }, {} as Record<ModelProviderAlias, BuiltInModelProvider>)
);

export function normalizeProviderId(provider: string | null | undefined): BuiltInModelProvider | undefined {
  if (!provider) {
    return undefined;
  }
  return PROVIDER_ALIAS_MAP[provider as ModelProviderAlias];
}

export function getProviderInfo(provider: string | null | undefined): CanonicalProviderInfo | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  return normalizedProvider ? PROVIDER_REGISTRY[normalizedProvider] : undefined;
}

export function getDefaultModelForProvider(provider: string | null | undefined): string {
  return getProviderInfo(provider)?.defaultModel ?? DEFAULT_MODELS.chat;
}

export function getProviderEndpoint(provider: string | null | undefined): string | undefined {
  return getProviderInfo(provider)?.endpoint;
}

export function getProviderEndpointForProtocol(
  provider: string | null | undefined,
  protocol?: 'openai' | 'claude',
): string | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider === 'longcat' && protocol === 'claude') {
    return MODEL_API_ENDPOINTS.longcatClaude;
  }
  return getProviderEndpoint(provider);
}

export function getProviderDisplayName(provider: string | null | undefined): string | undefined {
  return getProviderInfo(provider)?.displayName;
}

// ============================================================================
// 搜索 API 端点
// ============================================================================

export const SEARCH_API_ENDPOINTS = {
  /** Brave Search */
  brave: 'https://api.search.brave.com/res/v1/web/search',
  /** Exa AI */
  exa: 'https://api.exa.ai/search',
  /** Perplexity */
  perplexity: 'https://api.perplexity.ai/chat/completions',
  /** Tavily */
  tavily: 'https://api.tavily.com/search',
} as const;

// ============================================================================
// Provider Fallback Chain — 跨 Provider 降级（429/瞬态错误时自动切换）
// ============================================================================

/**
 * 跨 Provider 降级链
 * 当主 Provider 瞬态重试耗尽后，按顺序尝试下一个 Provider
 * Key = 起始 provider, Value = 降级顺序（不含自身）
 */
export const PROVIDER_FALLBACK_CHAIN: Record<string, Array<{ provider: string; model: string }>> = {
  xiaomi: [
    { provider: 'zhipu', model: 'glm-4.7-flash' },
    { provider: 'openai', model: 'gpt-5.4-mini' },
    { provider: 'moonshot', model: DEFAULT_MODELS.compact },
    { provider: 'deepseek', model: 'deepseek-v4-flash' },
  ],
  moonshot: [
    { provider: 'deepseek', model: 'deepseek-v4-flash' },
  ],
  deepseek: [
    { provider: 'moonshot', model: DEFAULT_MODELS.compact },
  ],
  claude: [
    { provider: 'zhipu', model: 'glm-4.7-flash' },
    { provider: 'openai', model: 'gpt-5.4-mini' },
    { provider: 'moonshot', model: DEFAULT_MODELS.compact },
    { provider: 'deepseek', model: 'deepseek-v4-flash' },
  ],
  openai: [
    { provider: 'zhipu', model: 'glm-4.7-flash' },
    { provider: 'moonshot', model: DEFAULT_MODELS.compact },
    { provider: 'deepseek', model: 'deepseek-v4-flash' },
  ],
  zhipu: [
    { provider: 'moonshot', model: DEFAULT_MODELS.compact },
    { provider: 'deepseek', model: 'deepseek-v4-flash' },
  ],
};
