// ============================================================================
// Provider 解析 —— baseURL / apiKey 的单一事实来源
//
// 把原本散落在各 provider 类 getBaseUrl/getApiKey 里的「端点 + key 形状」知识
// 收敛到这里：zhipu 三态、moonshot kimi-k2.5 专用端点、claude/anthropic、
// local→ollama 命名、以及通用 `config.baseUrl || ENDPOINTS[provider]`。
//
// 两类消费方共用同一份解析，消除「每加一个 provider 就要在 adapter 再打一次补丁」：
//   1) BaseOpenAIProvider 派生的 provider 类（主 loop）—— 委托到这里。
//   2) aiSdkAdapter（子代理路径）—— 同样调用，附带 `trustConfigKey:false`。
//
// apiKey 的两种「策略」是真实语义差异，故参数化而非合一：
//   - 主 loop（trustConfigKey 默认 true）：config.apiKey 由 modelRouter 按 provider
//     注入，可信，优先用它，env 仅作兜底。
//   - 子代理（trustConfigKey:false）：config.apiKey 是从父代理继承来的，provider 可能
//     已被角色策略改成别家 → 不可信，先按 provider 重新解析（configService → env），
//     config.apiKey 降为最后兜底。
// ============================================================================

import type { ModelConfig } from '../../../shared/contract';
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { PROVIDER_REGISTRY } from '../providerRegistry';
import { getConfigService } from '../../services/core/configService';

const ENDPOINTS = MODEL_API_ENDPOINTS as Record<string, string>;

// provider id → 环境变量名（dev/webServer 下 SecureStorage 为空时的兜底来源）。
// 仅收录代码里真实存在的 env 名；未列入的 provider 不做 env 兜底（与其旧实现一致）。
const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  groq: 'GROQ_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  longcat: 'LONGCAT_API_KEY',
};

function modelInfoOf(config: ModelConfig) {
  const reg = PROVIDER_REGISTRY[config.provider];
  return {
    reg,
    model: reg?.models.find((m) => m.id === config.model) ?? null,
  };
}

/** zhipu 免费档（走官方 bigmodel.cn + ZHIPU_OFFICIAL_API_KEY，0ki 不稳支持免费 ID）。 */
function isZhipuFree(config: ModelConfig): boolean {
  if (config.provider !== 'zhipu') return false;
  return modelInfoOf(config).model?.costType === 'free';
}

/** Moonshot Kimi K2.5（Coding 套餐专用端点 + KIMI_K25_API_KEY）。 */
function isKimiK25(config: ModelConfig): boolean {
  return config.provider === 'moonshot' && config.model === 'kimi-k2.5';
}

/**
 * 解析 provider 的 API base URL —— 各 provider 类 getBaseUrl 的单一事实来源。
 */
export function resolveProviderBaseUrl(config: ModelConfig): string {
  const provider = config.provider;
  const { reg, model } = modelInfoOf(config);

  // zhipu 三态（镜像 ZhipuProvider.getBaseUrl）
  if (provider === 'zhipu') {
    if (model?.costType === 'free') {
      return config.baseUrl || MODEL_API_ENDPOINTS.zhipuOfficial;
    }
    if (model?.useCodingEndpoint && reg?.codingBaseUrl) {
      return reg.codingBaseUrl; // coding 端点固定，不被 config.baseUrl 覆盖（对齐旧实现）
    }
    return config.baseUrl || reg?.baseUrl || MODEL_API_ENDPOINTS.zhipu;
  }

  // moonshot kimi-k2.5 专用端点（镜像 MoonshotProvider.getBaseUrl）
  if (isKimiK25(config)) {
    return process.env.KIMI_K25_API_URL || MODEL_API_ENDPOINTS.kimiK25;
  }

  // claude/anthropic（claudeProvider 自身仍保留 normalizeClaudeBaseUrl，这里供 adapter 的
  // createAnthropic 用；默认端点已含 /v1，normalize 为 no-op）
  if (provider === 'claude' || provider === 'anthropic') {
    return config.baseUrl || process.env.ANTHROPIC_BASE_URL || MODEL_API_ENDPOINTS.claude;
  }

  // local → ollama（provider id 与 endpoint key 不同名）
  if (provider === 'local') {
    return config.baseUrl || MODEL_API_ENDPOINTS.ollama;
  }

  // 通用：config.baseUrl || ENDPOINTS[provider]
  return config.baseUrl || ENDPOINTS[provider] || '';
}

interface ResolveApiKeyOptions {
  /**
   * config.apiKey 是否可信。
   * - true（默认，主 loop / provider 类）：config.apiKey 优先，env 兜底。
   * - false（adapter / 子代理）：configService(provider) → env 优先，config.apiKey 兜底。
   */
  trustConfigKey?: boolean;
}

/**
 * 解析 provider 的 API key —— 各 provider 类 getApiKey 的单一事实来源。
 */
export function resolveProviderApiKey(config: ModelConfig, opts: ResolveApiKeyOptions = {}): string {
  const trustConfigKey = opts.trustConfigKey !== false;

  // vendor 专用官方 key 始终最高优先（不依赖 config.apiKey 是否可信）
  const officialKey = isZhipuFree(config)
    ? process.env.ZHIPU_OFFICIAL_API_KEY
    : isKimiK25(config)
      ? process.env.KIMI_K25_API_KEY
      : undefined;
  if (officialKey) return officialKey;

  const envKey = ENV_KEY_BY_PROVIDER[config.provider];
  const envVal = envKey ? process.env[envKey] : undefined;

  if (trustConfigKey) {
    // 主 loop：config.apiKey 已由 modelRouter 按 provider 注入，可信。
    return config.apiKey || envVal || '';
  }

  // 子代理：config.apiKey 可能是父代理别家 provider 的 key，降为最后兜底。
  const serviceKey = getConfigService().getApiKey(config.provider);
  return serviceKey || envVal || config.apiKey || '';
}
