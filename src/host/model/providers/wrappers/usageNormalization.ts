// ============================================================================
// Provider usage 归一化（WP2-1 cache-aware 记账）
//
// 统一口径：inputTokens = 非缓存输入 tokens（不含 cacheRead / cacheCreation）。
// 各家 API 对缓存的报法不同，必须在 wrapper 层归一后再进预算/显示层：
//   - Anthropic：input_tokens 本身不含缓存，cache_read/cache_creation 独立字段
//   - OpenAI/Zhipu：prompt_tokens 含缓存，命中量在 prompt_tokens_details.cached_tokens
//   - DeepSeek：prompt_cache_hit_tokens / prompt_cache_miss_tokens 平级拆分
//   - Moonshot(Kimi)：顶层 cached_tokens
//   - Gemini：promptTokenCount 含缓存，命中量在 cachedContentTokenCount
// ============================================================================

export interface NormalizedTokenUsage {
  /** 非缓存输入 tokens */
  inputTokens: number;
  outputTokens: number;
  /** 缓存命中读取 tokens（按 cacheRead 价计费） */
  cacheReadTokens?: number;
  /** 缓存写入 tokens（按 cacheWrite 价计费，目前仅 Anthropic 报告） */
  cacheCreationTokens?: number;
}

interface ClaudeUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function normalizeClaudeUsage(usage: ClaudeUsageShape): NormalizedTokenUsage {
  const normalized: NormalizedTokenUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
  if (usage.cache_read_input_tokens) {
    normalized.cacheReadTokens = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens) {
    normalized.cacheCreationTokens = usage.cache_creation_input_tokens;
  }
  return normalized;
}

interface OpenAIUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** DeepSeek */
  prompt_cache_hit_tokens?: number;
  /** Moonshot (Kimi) */
  cached_tokens?: number;
  /** OpenAI / Zhipu */
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

export function normalizeOpenAIUsage(usage: OpenAIUsageShape): NormalizedTokenUsage {
  const promptTokens = usage.prompt_tokens ?? 0;
  const cachedTokens =
    usage.prompt_cache_hit_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.cached_tokens
    ?? 0;
  const normalized: NormalizedTokenUsage = {
    // OpenAI 系 prompt_tokens 含缓存命中部分 → 扣除后才是全价输入
    inputTokens: Math.max(0, promptTokens - cachedTokens),
    outputTokens: usage.completion_tokens ?? 0,
  };
  if (cachedTokens > 0) {
    normalized.cacheReadTokens = cachedTokens;
  }
  return normalized;
}

interface GeminiUsageShape {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

export function normalizeGeminiUsage(usage: GeminiUsageShape): NormalizedTokenUsage {
  const promptTokens = usage.promptTokenCount ?? 0;
  const cachedTokens = usage.cachedContentTokenCount ?? 0;
  const normalized: NormalizedTokenUsage = {
    inputTokens: Math.max(0, promptTokens - cachedTokens),
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
  if (cachedTokens > 0) {
    normalized.cacheReadTokens = cachedTokens;
  }
  return normalized;
}
