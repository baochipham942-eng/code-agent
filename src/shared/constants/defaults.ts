/** Provider HTTP request timeout (ms) */
export const PROVIDER_TIMEOUT = 300000;

/** 默认 Provider */
export const DEFAULT_PROVIDER = 'claude' as const;

/** 默认模型（主力对话） */
export const DEFAULT_MODEL = 'claude-opus-4-6' as const;

/** 模型 maxTokens 分层默认值（对标 Claude Code / Aider 行业标准） */
export const MODEL_MAX_TOKENS = {
  /** 主聊天模型默认值 — 对标 Claude Code Sonnet 16K */
  DEFAULT: 16384,
  /** 截断恢复上限 — 对标 Claude Code Opus 32K */
  EXTENDED: 32768,
  /** 辅助/免费模型（GLM-4.7-Flash 等快速任务） */
  COMPACT: 4096,
  /** 视觉模型（GLM-4V-Plus via OKI 代理，上限 2048） */
  VISION: 2048,
} as const;

/**
 * 每个模型的推荐 maxOutputTokens — 基于官方文档 + 行业标准
 *
 * 参考来源:
 * - Aider: https://aider.chat/docs/config/adv-model-settings.html
 * - DeepSeek API: https://api-docs.deepseek.com/api/create-chat-completion (8K limit)
 * - GLM-4.7 Docs: https://docs.z.ai/guides/llm/glm-4.7 (128K output)
 * - Kimi K2.5: https://openrouter.ai/moonshotai/kimi-k2.5 (96K benchmark)
 */
export const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  // Moonshot — Kimi K2.5 支持 96K output，对标 Claude Code Sonnet 默认
  'kimi-k2.5': 32768,  // Kimi K2.5: 256K context, ~65K max output (OpenRouter data)
  // DeepSeek — 官方 API 上限 8K
  'deepseek-chat': 8192,
  'deepseek-coder': 8192,
  'deepseek-reasoner': 16384,
  // 智谱 GLM — 按用途分层
  'glm-5': 8192,
  'glm-5-turbo': 8192,
  'glm-4.7': 8192,
  'glm-4.7-flash': 4096,    // 免费快速模型，短任务
  'glm-4v-plus': 2048,      // 视觉
  'glm-4.6v': 2048,         // 视觉
  'glm-4.6v-flash': 1024,   // 视觉快速
  // Anthropic — 参考 Aider 配置
  'claude-opus-4-6': 32000,
  'claude-sonnet-4-6': 16384,
  'claude-haiku-4-5-20251001': 16384,
  'claude-sonnet-4-20250514': 16384,
  'claude-sonnet-4-5-20250929': 16384,
  'claude-3-5-sonnet-20241022': 8192,
  'claude-3-5-haiku-20241022': 8192,
  // OpenAI
  'gpt-4o': 16384,
  'gpt-4o-mini': 16384,
  // Groq
  'llama-3.3-70b-versatile': 8192,
};

/** 根据模型名查找推荐的 maxOutputTokens */
export function getModelMaxOutputTokens(model: string): number {
  return MODEL_MAX_OUTPUT_TOKENS[model] || MODEL_MAX_TOKENS.DEFAULT;
}

/** 模型上下文窗口大小（tokens） — 仅包含 PROVIDER_REGISTRY 中注册的模型 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  // DeepSeek
  'deepseek-chat': 64_000,
  'deepseek-coder': 64_000,
  'deepseek-reasoner': 64_000,
  // Anthropic
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  // Zhipu
  'glm-5': 200_000,
  'glm-4.7': 128_000,
  'glm-4.7-flash': 128_000,
  // Moonshot
  'kimi-k2.5': 256_000,
};

/** 默认上下文窗口（未知模型 fallback） */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
