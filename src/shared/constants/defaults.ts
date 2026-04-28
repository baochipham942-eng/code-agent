/** Provider HTTP request timeout (ms) */
export const PROVIDER_TIMEOUT = 300000;

/** 默认 Provider */
export const DEFAULT_PROVIDER = 'claude' as const;

/** 默认模型（主力对话） */
export const DEFAULT_MODEL = 'claude-opus-4-7' as const;

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
 * 过时模型 → 当前生产级替换的映射。
 * 用于 settings 持久化里存的旧 model ID 平滑迁移（不报错、静默升级），
 * 以及 CONTEXT_WINDOWS / MODEL_MAX_OUTPUT_TOKENS 查表时 fallback。
 */
export const MODEL_MIGRATIONS: Record<string, string> = {
  // Anthropic
  'claude-opus-4-6': 'claude-opus-4-7',
  'claude-opus-4-5-20251101': 'claude-opus-4-7',
  'claude-opus-4-1-20250805': 'claude-opus-4-7',
  'claude-opus-4-20250514': 'claude-opus-4-7',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5-20251001',
  // OpenAI — GPT-5.5 于 2026-04-23 发布，替代 5.4 成为旗舰
  'gpt-4o': 'gpt-5.4-mini',
  'gpt-4o-mini': 'gpt-5.4-mini',
  'gpt-4.1': 'gpt-5.5',
  'gpt-4.1-mini': 'gpt-5.4-mini',
  'o3': 'gpt-5.5',
  'o4-mini': 'gpt-5.4-mini',
  // DeepSeek — V4 于 2026-04-24 发布，legacy chat/reasoner 2026-07-24 退役
  'deepseek-coder': 'deepseek-v4-flash',
  // 火山豆包 — 1.5 系列 → 1.6 系列
  'doubao-1.5-pro-256k': 'doubao-seed-1-6',
  'doubao-1.5-thinking-pro': 'doubao-seed-1-6-thinking',
  'doubao-seed-1-6-vision-250815': 'doubao-seed-1-6',
};

/**
 * 把模型 ID 规范化到 CONTEXT_WINDOWS / MODEL_MAX_OUTPUT_TOKENS 查表用的 key。
 * 1. 剥掉 provider 前缀（openrouter 的 `anthropic/claude-opus-4-7`）
 * 2. 把 dot-style version 转成 dash-style（Anthropic API 规范）
 * 3. 应用 MODEL_MIGRATIONS 表做旧→新替换（迭代一次，防止循环）
 */
export function normalizeModelId(modelId: string): string {
  if (!modelId) return modelId;
  let id = modelId.includes('/') ? modelId.split('/').slice(-1)[0] : modelId;
  // Anthropic 的 API ID 用 dash（claude-opus-4-7），少数入口会写 dot（claude-opus-4.7）
  if (/^claude-(opus|sonnet|haiku)-\d+\.\d+/.test(id)) {
    id = id.replace(/^(claude-(?:opus|sonnet|haiku))-(\d+)\.(\d+)/, '$1-$2-$3');
  }
  return MODEL_MIGRATIONS[id] ?? id;
}

/**
 * 每个模型的推荐 maxOutputTokens — 基于官方文档。
 * 参考来源:
 * - Anthropic: https://platform.claude.com/docs/en/docs/about-claude/models/overview
 * - OpenAI:    https://developers.openai.com/api/docs/models
 * - DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing
 * - 智谱 GLM:  https://docs.bigmodel.cn/cn/guide/start/model-overview
 * - Moonshot:  https://platform.kimi.com/docs/api/models-overview
 */
export const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  // Anthropic
  'claude-opus-4-7': 128_000,
  'claude-sonnet-4-6': 64_000,
  'claude-haiku-4-5-20251001': 64_000,
  // OpenAI
  'gpt-5.5': 128_000,
  'gpt-5.5-pro': 128_000,
  'gpt-5.4': 128_000,
  'gpt-5.4-mini': 128_000,
  'gpt-5.4-nano': 128_000,
  'gpt-5.3-codex': 128_000,
  'gpt-5.2': 128_000,
  // Gemini
  'gemini-3.1-pro-preview': 64_000,
  'gemini-3-pro-preview': 64_000,
  'gemini-3-flash-preview': 64_000,
  'gemini-2.5-pro': 64_000,
  'gemini-2.5-flash': 64_000,
  // DeepSeek — 官方 API 上限
  'deepseek-v4-flash': 64_000,
  'deepseek-v4-pro': 64_000,
  'deepseek-chat': 8_192,
  'deepseek-reasoner': 64_000,
  // 智谱 GLM
  'glm-5.1': 128_000,
  'glm-5': 128_000,
  'glm-4.7': 128_000,
  'glm-4.7-flash': 128_000,
  'glm-4.7-flashx': 128_000,
  'glm-4.6v': 32_000,
  'glm-4.6v-flash': 32_000,
  // Qwen
  'qwen3.6-plus': 32_768,
  'qwen3-max': 32_768,
  'qwen-plus-latest': 32_768,
  'qwen3-coder': 131_072,
  'qwen-vl-max': 8_192,
  // Moonshot Kimi
  'kimi-k2.6': 32_768,
  'kimi-k2.5': 32_768,
  'kimi-k2-turbo-preview': 32_768,
  'kimi-k2-thinking': 32_768,
  // MiniMax
  'MiniMax-M2.7': 131_072,
  'MiniMax-M2.5': 131_072,
  // 火山豆包
  'doubao-seed-1-6': 32_768,
  'doubao-seed-1-6-thinking': 32_768,
  'doubao-seed-1-6-flash': 32_768,
  'doubao-seed-1-6-lite': 32_768,
  // xAI Grok
  'grok-4-1-fast-reasoning': 32_768,
  'grok-4-1-fast-non-reasoning': 32_768,
  // Perplexity
  'sonar-pro': 8_192,
  'sonar': 8_192,
  'sonar-reasoning-pro': 8_192,
  'sonar-reasoning': 8_192,
  'sonar-deep-research': 8_192,
  // 小米 MiMo（API 实测 max_tokens 上限均为 131072）
  'mimo-v2.5-pro': 131_072,
  'mimo-v2.5': 131_072,
  'mimo-v2-pro': 131_072,
  'mimo-v2-omni': 131_072,
};

/** 根据模型名查找推荐的 maxOutputTokens（先做规范化） */
export function getModelMaxOutputTokens(model: string): number {
  const id = normalizeModelId(model);
  return MODEL_MAX_OUTPUT_TOKENS[id] || MODEL_MAX_TOKENS.DEFAULT;
}

/**
 * 模型上下文窗口大小（tokens） — 覆盖 model-catalog.json 所有在售模型。
 * 参考来源同 MODEL_MAX_OUTPUT_TOKENS。
 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic — Opus 4.7 / Sonnet 4.6 原生 1M；Haiku 4.5 为 200K
  'claude-opus-4-7': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
  // OpenAI
  'gpt-5.5': 1_000_000,
  'gpt-5.5-pro': 1_000_000,
  'gpt-5.4': 1_000_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5.4-nano': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.2': 400_000,
  // Gemini
  'gemini-3.1-pro-preview': 1_000_000,
  'gemini-3-pro-preview': 1_000_000,
  'gemini-3-flash-preview': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  // DeepSeek — V4 原生 1M 上下文
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 128_000,
  // 智谱 GLM
  'glm-5.1': 200_000,
  'glm-5': 200_000,
  'glm-4.7': 200_000,
  'glm-4.7-flash': 200_000,
  'glm-4.7-flashx': 200_000,
  'glm-4.6v': 128_000,
  'glm-4.6v-flash': 128_000,
  // Qwen
  'qwen3.6-plus': 1_000_000,
  'qwen3-max': 262_144,
  'qwen-plus-latest': 1_000_000,
  'qwen3-coder': 262_144,
  'qwen-vl-max': 32_768,
  // Moonshot Kimi
  'kimi-k2.6': 262_144,
  'kimi-k2.5': 262_144,
  'kimi-k2-turbo-preview': 262_144,
  'kimi-k2-thinking': 262_144,
  // MiniMax
  'MiniMax-M2.7': 204_800,
  'MiniMax-M2.5': 204_800,
  // 火山豆包
  'doubao-seed-1-6': 256_000,
  'doubao-seed-1-6-thinking': 256_000,
  'doubao-seed-1-6-flash': 256_000,
  'doubao-seed-1-6-lite': 256_000,
  // xAI Grok
  'grok-4-1-fast-reasoning': 2_000_000,
  'grok-4-1-fast-non-reasoning': 2_000_000,
  // Perplexity
  'sonar-pro': 200_000,
  'sonar': 128_000,
  'sonar-reasoning-pro': 128_000,
  'sonar-reasoning': 128_000,
  'sonar-deep-research': 128_000,
  // 小米 MiMo（mimo.xiaomi.com / OpenRouter 官方文档）
  'mimo-v2.5-pro': 1_048_576, // 1M，hybrid attention 架构
  'mimo-v2.5': 1_048_576,
  'mimo-v2-pro': 1_048_576,
  'mimo-v2-omni': 262_144,    // 256k，多模态版上下文较短
};

/** 默认上下文窗口（未知模型 fallback） */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 查模型的上下文窗口（先规范化，再查表，查不到回落到 DEFAULT_CONTEXT_WINDOW）。
 * 所有需要根据 model ID 取 context size 的地方都应通过本函数，不要直接读 CONTEXT_WINDOWS。
 */
export function getContextWindow(model: string): number {
  const id = normalizeModelId(model);
  return CONTEXT_WINDOWS[id] ?? DEFAULT_CONTEXT_WINDOW;
}
