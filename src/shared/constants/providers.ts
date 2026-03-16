import type { ModelProvider, ModelProviderAlias } from '../types';
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
  /** OpenRouter */
  openrouter: 'https://openrouter.ai/api/v1',
  /** Google Gemini */
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  /** 火山引擎 Ark (豆包 GUI 自动化) */
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  /** Local Ollama */
  ollama: 'http://localhost:11434/v1',
} as const;

export interface CanonicalProviderInfo {
  aliases: readonly ModelProviderAlias[];
  defaultModel: string;
  endpoint: string;
  cloudProxySupported: boolean;
  displayName: string;
}

/**
 * Canonical provider registry.
 * 所有 provider 级别元数据统一从这里读取，避免 renderer / main / cloud 漂移。
 */
export const PROVIDER_REGISTRY: Record<ModelProvider, CanonicalProviderInfo> = {
  deepseek: {
    aliases: ['deepseek'],
    defaultModel: 'deepseek-chat',
    endpoint: MODEL_API_ENDPOINTS.deepseek,
    cloudProxySupported: true,
    displayName: 'DeepSeek',
  },
  claude: {
    aliases: ['claude', 'anthropic'],
    defaultModel: DEFAULT_MODEL,
    endpoint: MODEL_API_ENDPOINTS.claude,
    cloudProxySupported: true,
    displayName: 'Anthropic Claude',
  },
  openai: {
    aliases: ['openai'],
    defaultModel: 'gpt-4o',
    endpoint: MODEL_API_ENDPOINTS.openai,
    cloudProxySupported: true,
    displayName: 'OpenAI',
  },
  gemini: {
    aliases: ['gemini'],
    defaultModel: 'gemini-2.5-pro',
    endpoint: MODEL_API_ENDPOINTS.gemini,
    cloudProxySupported: false,
    displayName: 'Google Gemini',
  },
  groq: {
    aliases: ['groq'],
    defaultModel: 'llama-3.3-70b-versatile',
    endpoint: MODEL_API_ENDPOINTS.groq,
    cloudProxySupported: true,
    displayName: 'Groq',
  },
  local: {
    aliases: ['local'],
    defaultModel: 'qwen2.5-coder:7b',
    endpoint: MODEL_API_ENDPOINTS.ollama,
    cloudProxySupported: false,
    displayName: 'Local (Ollama)',
  },
  zhipu: {
    aliases: ['zhipu'],
    defaultModel: 'glm-5',
    endpoint: MODEL_API_ENDPOINTS.zhipu,
    cloudProxySupported: true,
    displayName: 'Zhipu GLM',
  },
  qwen: {
    aliases: ['qwen'],
    defaultModel: 'qwen3-max',
    endpoint: MODEL_API_ENDPOINTS.qwen,
    cloudProxySupported: true,
    displayName: 'Qwen',
  },
  moonshot: {
    aliases: ['moonshot'],
    defaultModel: 'kimi-k2.5',
    endpoint: MODEL_API_ENDPOINTS.moonshot,
    cloudProxySupported: true,
    displayName: 'Kimi',
  },
  minimax: {
    aliases: ['minimax'],
    defaultModel: 'MiniMax-M2',
    endpoint: MODEL_API_ENDPOINTS.minimax,
    cloudProxySupported: false,
    displayName: 'MiniMax',
  },
  perplexity: {
    aliases: ['perplexity'],
    defaultModel: 'sonar-pro',
    endpoint: MODEL_API_ENDPOINTS.perplexity,
    cloudProxySupported: false,
    displayName: 'Perplexity',
  },
  openrouter: {
    aliases: ['openrouter'],
    defaultModel: 'google/gemini-2.5-flash',
    endpoint: MODEL_API_ENDPOINTS.openrouter,
    cloudProxySupported: true,
    displayName: 'OpenRouter',
  },
};

export const PROVIDER_ALIAS_MAP: Record<ModelProviderAlias, ModelProvider> = Object.freeze(
  Object.entries(PROVIDER_REGISTRY).reduce((acc, [provider, config]) => {
    for (const alias of config.aliases) {
      acc[alias] = provider as ModelProvider;
    }
    return acc;
  }, {} as Record<ModelProviderAlias, ModelProvider>)
);

export function normalizeProviderId(provider: string | null | undefined): ModelProvider | undefined {
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
  moonshot: [
    { provider: 'deepseek', model: 'deepseek-chat' },
    { provider: 'zhipu', model: 'glm-4.7-flash' },
  ],
  deepseek: [
    { provider: 'moonshot', model: 'kimi-k2.5' },
    { provider: 'zhipu', model: 'glm-4.7-flash' },
  ],
  claude: [
    { provider: 'moonshot', model: 'kimi-k2.5' },
    { provider: 'deepseek', model: 'deepseek-chat' },
  ],
  openai: [
    { provider: 'moonshot', model: 'kimi-k2.5' },
    { provider: 'deepseek', model: 'deepseek-chat' },
  ],
  zhipu: [
    { provider: 'moonshot', model: 'kimi-k2.5' },
    { provider: 'deepseek', model: 'deepseek-chat' },
  ],
};
