import { describe, expect, it } from 'vitest';
import { parseClaudeResponse } from '../../src/host/model/providers/wrappers/anthropicWrapper';
import { parseOpenAIResponse } from '../../src/host/model/providers/wrappers/openaiWrapper';
import { parseGeminiResponse } from '../../src/host/model/providers/wrappers/geminiWrapper';

// WP2-1：非流式解析器把 provider usage（含 cache 字段）带回 ModelResponse.usage，
// 修复 anthropicWrapper "schema 已解析但就地丢弃" 的缺口。

describe('parseClaudeResponse usage passthrough', () => {
  it('returns normalized usage with cache fields', () => {
    const response = parseClaudeResponse({
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 5_000,
        cache_creation_input_tokens: 700,
      },
    });
    expect(response.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 5_000,
      cacheCreationTokens: 700,
    });
  });

  it('leaves usage undefined when provider omits it', () => {
    const response = parseClaudeResponse({
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(response.usage).toBeUndefined();
  });
});

describe('parseOpenAIResponse usage passthrough', () => {
  it('returns normalized usage with DeepSeek cache-hit fields', () => {
    const response = parseOpenAIResponse({
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 20,
        prompt_cache_hit_tokens: 900,
      },
    });
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 900,
    });
  });

  it('returns usage on tool_use responses too', () => {
    const response = parseOpenAIResponse({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    });
    expect(response.type).toBe('tool_use');
    expect(response.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
  });

  it('leaves usage undefined when provider omits it', () => {
    const response = parseOpenAIResponse({
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
    });
    expect(response.usage).toBeUndefined();
  });
});

describe('parseGeminiResponse usage passthrough', () => {
  it('returns normalized usage with cachedContentTokenCount', () => {
    const response = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: {
        promptTokenCount: 800,
        candidatesTokenCount: 40,
        cachedContentTokenCount: 600,
      },
    });
    expect(response.usage).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 600,
    });
  });
});
