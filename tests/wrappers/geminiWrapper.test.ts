import { describe, expect, it } from 'vitest';

import {
  parseGeminiResponse,
  parseGeminiStreamChunk,
} from '../../src/main/model/providers/wrappers/geminiWrapper';

describe('geminiWrapper / parseGeminiResponse', () => {
  it('success: parses text-only response', () => {
    const raw = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'hello from gemini' }],
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 },
    };

    const result = parseGeminiResponse(raw);
    expect(result.type).toBe('text');
    expect(result.content).toBe('hello from gemini');
    // Gemini 兼容性：toolCalls 总是有，即使空
    expect(result.toolCalls).toEqual([]);
  });

  it('tool_use: parses single functionCall', () => {
    const raw = {
      candidates: [
        {
          content: {
            parts: [
              { text: '' },
              { functionCall: { name: 'getWeather', args: { city: 'Beijing' } } },
            ],
          },
        },
      ],
    };

    const result = parseGeminiResponse(raw);
    expect(result.type).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0].name).toBe('getWeather');
    expect(result.toolCalls?.[0].arguments).toEqual({ city: 'Beijing' });
  });

  it('multi_tool_use: parses multiple functionCall parts', () => {
    const raw = {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'a', args: { k: 1 } } },
              { functionCall: { name: 'b', args: { k: 2 } } },
            ],
          },
        },
      ],
    };
    const result = parseGeminiResponse(raw);
    expect(result.type).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls?.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('refusal: returns plain text when only text parts', () => {
    const raw = {
      candidates: [
        {
          content: { parts: [{ text: 'I cannot help with that.' }] },
          finishReason: 'STOP',
        },
      ],
    };
    const result = parseGeminiResponse(raw);
    expect(result.type).toBe('text');
    expect(result.content).toBe('I cannot help with that.');
  });

  it('unknown_field_passthrough: tolerates inlineData + unknown fields', () => {
    const raw = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'main text' },
              {
                inlineData: { mimeType: 'image/png', data: 'base64...' },
                // 未来 part 类型加的字段
                executableCode: { language: 'PYTHON', code: 'print()' },
              },
            ],
          },
          // 未知 candidate 级字段
          safetyRatings: [{ category: 'HARM_HATE', probability: 'NEGLIGIBLE' }],
          citationMetadata: { citationSources: [] },
        },
      ],
      // 顶层未知字段
      promptFeedback: { blockReason: undefined },
      modelVersion: 'gemini-2.5-pro',
    };

    expect(() => parseGeminiResponse(raw)).not.toThrow();
    const result = parseGeminiResponse(raw);
    expect(result.content).toBe('main text');
  });

  it('throws when candidates array is empty', () => {
    const raw = { candidates: [] };
    expect(() => parseGeminiResponse(raw)).toThrow(/No response from Gemini/);
  });
});

describe('geminiWrapper / parseGeminiStreamChunk', () => {
  it('parses text chunk', () => {
    const raw = {
      candidates: [{ content: { parts: [{ text: 'streamed text' }] } }],
    };
    const chunk = parseGeminiStreamChunk(raw);
    expect(chunk?.candidates?.[0].content?.parts?.[0].text).toBe('streamed text');
  });

  it('returns null on completely malformed chunk (hot path safe)', () => {
    const raw = { candidates: 'not an array' };
    expect(parseGeminiStreamChunk(raw)).toBeNull();
  });
});
