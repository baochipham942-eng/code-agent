import type { BuiltInModelProvider, ModelProviderAlias } from '../contract';
import { DEFAULT_MODELS } from './models';

function readProcessEnv(name: string, fallback: string): string {
  return typeof process !== 'undefined' ? process.env?.[name] ?? fallback : fallback;
}

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

// ============================================================================
// Per-provider 代理分类 — 国内直连 host（即使设了全局代理也绕过）
// ----------------------------------------------------------------------------
// Why: mimo（token-plan-sgp，海外）必须走代理，但同一个全局 HTTPS_PROXY 会把
// 国内 provider（智谱/Kimi/DeepSeek/MiniMax 等直连端点）也打进海外代理，导致
// `socket disconnected before TLS` —— 这正是 fallback 链一个都救不了的真凶。
// 用 host 后缀判定：命中下列国内 host 的请求一律直连绕过代理；海外/未知 host
// 才走代理。新增国内 provider 时把其端点 host 加进来。
// ============================================================================

export const DIRECT_CONNECT_HOST_SUFFIXES: readonly string[] = [
  '0ki.cn',        // 智谱 (OKI 代理)
  'bigmodel.cn',   // 智谱官方
  'moonshot.cn',   // Moonshot
  'kimi.com',      // Kimi K2.5 Coding
  'minimax.chat',  // MiniMax
  'deepseek.com',  // DeepSeek
  'volces.com',    // 火山引擎 (豆包)
  'longcat.chat',  // LongCat (美团)
  'baidubce.com',  // 百度 OCR
  'aliyuncs.com',  // 阿里云通义千问
  'localhost',     // 本地 Ollama
  '127.0.0.1',
];

/**
 * 判断目标 URL/host 是否为国内直连 host（应绕过代理）。
 * 接受完整 URL 或裸 hostname；解析失败时按裸 hostname 处理。
 */
export function isDirectConnectHost(urlOrHost: string): boolean {
  let host = urlOrHost;
  try {
    host = new URL(urlOrHost).hostname;
  } catch {
    // 已经是裸 hostname（或非法），原样使用
  }
  host = host.toLowerCase();
  return DIRECT_CONNECT_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

// ============================================================================
// Per-provider 代理决策（按 provider 身份，而非 host 地址）
// ----------------------------------------------------------------------------
// 海外 provider 默认端点在墙外、需走代理；其余 provider（含国内厂商的海外节点，如小米
// mimo 的 token-plan-sgp —— 实测直连才通、代理反而把大请求掐成 HTTP2 framing 断连）一律直连。
// Why 按 provider 而非 host：provider 是封闭枚举集，新增国内 provider 默认直连、不会像 host
// 白名单那样漏（mimo 曾因没加进 DIRECT_CONNECT_HOST_SUFFIXES 而被全局 HTTPS_PROXY 打偏）。
// host 白名单（DIRECT_CONNECT_HOST_SUFFIXES）降级为「海外 provider 走国内中转 baseUrl」的
// 例外判定（如 claude 走 clawapi.vip 国内中转）。随 bundle 分发，装机后同样按 provider 身份判。
// ============================================================================

export const OVERSEAS_PROVIDERS: ReadonlySet<string> = new Set([
  'openai',
  'claude',
  'anthropic',
  'gemini',
  'groq',
  'grok',
  'xai',
  'openrouter',
  'perplexity',
]);

/**
 * 判断某 provider 的请求是否需要走代理。
 * - 国内 provider（含国内厂商的海外节点，如 xiaomi mimo）→ false（直连）
 * - 海外 provider → true，除非 baseUrl 命中国内直连 host（走国内中转）→ false
 */
export function providerNeedsProxy(
  provider: string | null | undefined,
  baseUrl?: string,
): boolean {
  const normalized = normalizeProviderId(provider) ?? provider ?? '';
  if (!OVERSEAS_PROVIDERS.has(normalized)) return false;
  if (baseUrl && isDirectConnectHost(baseUrl)) return false;
  return true;
}

// ============================================================================
// Provider 并发限额（明确声明并发上限的 provider 才进此表）
// ----------------------------------------------------------------------------
// 用于自适应并发限流器（concurrencyLimiter）。只有在此声明的 provider 才会被节流；
// 未声明的 provider（如 xiaomi 实测可扛 ≥6 并发）不限流。
// maxConcurrent 触发限流后会自适应降级，5 分钟无限流后逐步恢复。
// ============================================================================

// 此表是「出厂默认」：用户在模型配置页填写的 maxConcurrent 会覆盖这里的值
// （见 concurrencyLimiter.setProviderConcurrencyOverrides）。
export const PROVIDER_CONCURRENCY_LIMITS: Record<string, { maxConcurrent: number; minIntervalMs: number }> = {
  /** 智谱 GLM 免费档（glm-4.x-flash）实测并发上限约 3-4，超过即 1302 限流 */
  zhipu: {
    maxConcurrent: parseInt(readProcessEnv('ZHIPU_MAX_CONCURRENT', '3'), 10),
    minIntervalMs: parseInt(readProcessEnv('ZHIPU_MIN_INTERVAL_MS', '200'), 10),
  },
  /** 小米 MiMo（token-plan-sgp 海外节点）：实测高扇出（>6 并发）会 429。
   *  默认 6 防止 dynamic-workflow 规模的 429 风暴；可在模型配置页覆盖。 */
  xiaomi: {
    maxConcurrent: parseInt(readProcessEnv('XIAOMI_MAX_CONCURRENT', '6'), 10),
    minIntervalMs: parseInt(readProcessEnv('XIAOMI_MIN_INTERVAL_MS', '0'), 10),
  },
};

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
    defaultModel: 'claude-opus-4-7',
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
// 第三方服务 API 端点（非 LLM provider）
// ============================================================================

export const BAIDU_OCR_ENDPOINTS = {
  /** OAuth 2.0 token endpoint */
  token: 'https://aip.baidubce.com/oauth/2.0/token',
  /** 高精度 OCR */
  accurate: 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate',
} as const;

// ============================================================================
// 搜索 API 端点
// ============================================================================

export const SEARCH_API_ENDPOINTS = {
  /** Firecrawl keyless/authenticated search */
  firecrawlSearch: 'https://api.firecrawl.dev/v2/search',
  /** Firecrawl keyless/authenticated scrape */
  firecrawlScrape: 'https://api.firecrawl.dev/v2/scrape',
  /** Brave Search */
  brave: 'https://api.search.brave.com/res/v1/web/search',
  /** Exa AI */
  exa: 'https://api.exa.ai/search',
  /** Perplexity */
  perplexity: 'https://api.perplexity.ai/chat/completions',
  /** Tavily */
  tavily: 'https://api.tavily.com/search',
  /** OpenAI Responses API with web_search tool */
  openai: 'https://api.openai.com/v1/responses',
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
