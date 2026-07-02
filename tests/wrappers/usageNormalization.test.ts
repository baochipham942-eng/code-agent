import { describe, expect, it } from 'vitest';
import {
  normalizeClaudeUsage,
  normalizeOpenAIUsage,
  normalizeGeminiUsage,
} from '../../src/host/model/providers/wrappers/usageNormalization';

// 归一化口径：inputTokens = 非缓存输入（不含 cacheRead / cacheCreation）

describe('normalizeClaudeUsage', () => {
  it('maps cache_read/cache_creation and keeps input_tokens as-is (Anthropic already excludes cache)', () => {
    const usage = normalizeClaudeUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 300,
    });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 9000,
      cacheCreationTokens: 300,
    });
  });

  it('omits cache fields when absent or zero', () => {
    const usage = normalizeClaudeUsage({ input_tokens: 10, output_tokens: 5 });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe('normalizeOpenAIUsage', () => {
  it('DeepSeek shape: prompt_cache_hit_tokens split out of prompt_tokens', () => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: 10_000,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 8_000,
      prompt_cache_miss_tokens: 2_000,
    });
    expect(usage).toEqual({
      inputTokens: 2_000,
      outputTokens: 200,
      cacheReadTokens: 8_000,
    });
  });

  it('OpenAI/Zhipu shape: prompt_tokens_details.cached_tokens split out of prompt_tokens', () => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: 5_000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 4_000 },
    });
    expect(usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 4_000,
    });
  });

  it('Moonshot shape: top-level cached_tokens split out of prompt_tokens', () => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: 3_000,
      completion_tokens: 50,
      cached_tokens: 2_500,
    });
    expect(usage).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 2_500,
    });
  });

  it('no cache fields → plain mapping, no cache keys', () => {
    const usage = normalizeOpenAIUsage({ prompt_tokens: 10, completion_tokens: 5 });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('clamps: cached larger than prompt_tokens never yields negative inputTokens', () => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 150,
    });
    expect(usage.inputTokens).toBe(0);
    expect(usage.cacheReadTokens).toBe(150);
  });
});

describe('normalizeGeminiUsage', () => {
  it('splits cachedContentTokenCount out of promptTokenCount', () => {
    const usage = normalizeGeminiUsage({
      promptTokenCount: 7_000,
      candidatesTokenCount: 300,
      cachedContentTokenCount: 6_000,
    });
    expect(usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 300,
      cacheReadTokens: 6_000,
    });
  });

  it('no cache field → plain mapping', () => {
    const usage = normalizeGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 5 });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});
