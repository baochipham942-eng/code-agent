import { describe, expect, it } from 'vitest';

import {
  parseDeepSeekResponse,
  parseDeepSeekStreamChunk,
  extractReasoningDelta,
} from '../../src/main/model/providers/wrappers/deepseekWrapper';

describe('deepseekWrapper / parseDeepSeekResponse', () => {
  it('success: parses text response identical to OpenAI shape', () => {
    const raw = {
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    };
    const result = parseDeepSeekResponse(raw);
    expect(result.type).toBe('text');
    expect(result.content).toBe('hello');
  });

  it('tool_use: parses tool_calls array', () => {
    const raw = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'searchWeb', arguments: '{"q":"deepseek"}' },
              },
            ],
          },
        },
      ],
    };
    const result = parseDeepSeekResponse(raw);
    expect(result.type).toBe('tool_use');
    expect(result.toolCalls?.[0].arguments).toEqual({ q: 'deepseek' });
  });

  it('multi_tool_use: handles multiple tool_calls', () => {
    const raw = {
      choices: [
        {
          message: {
            tool_calls: [
              { id: 't1', function: { name: 'a', arguments: '{}' } },
              { id: 't2', function: { name: 'b', arguments: '{}' } },
            ],
          },
        },
      ],
    };
    const result = parseDeepSeekResponse(raw);
    expect(result.toolCalls).toHaveLength(2);
  });

  it('refusal: returns plain text', () => {
    const raw = { choices: [{ message: { content: 'I cannot.' } }] };
    const result = parseDeepSeekResponse(raw);
    expect(result.type).toBe('text');
    expect(result.content).toBe('I cannot.');
  });

  it('unknown_field_passthrough: tolerates DeepSeek/Kimi reasoning_content + unknown fields', () => {
    const raw = {
      choices: [
        {
          message: {
            content: 'final answer',
            // DeepSeek/GLM 风格 thinking-mode 字段
            reasoning_content: '内部推理: 步骤1...',
          },
          finish_reason: 'stop',
        },
      ],
      // 未来扩展字段
      experimental_audio: { url: 'x' },
    };
    expect(() => parseDeepSeekResponse(raw)).not.toThrow();
    const result = parseDeepSeekResponse(raw);
    expect(result.type).toBe('text');
    expect(result.content).toBe('final answer');
  });
});

describe('deepseekWrapper / parseDeepSeekStreamChunk', () => {
  it('parses reasoning_content delta', () => {
    const raw = { choices: [{ delta: { reasoning_content: 'step 1' } }] };
    const chunk = parseDeepSeekStreamChunk(raw);
    expect(chunk?.choices?.[0].delta?.reasoning_content).toBe('step 1');
  });

  it('parses Kimi reasoning delta', () => {
    const raw = { choices: [{ delta: { reasoning: 'kimi thinking' } }] };
    const chunk = parseDeepSeekStreamChunk(raw);
    expect(chunk?.choices?.[0].delta?.reasoning).toBe('kimi thinking');
  });
});

describe('deepseekWrapper / extractReasoningDelta', () => {
  it('returns reasoning_content (DeepSeek/GLM)', () => {
    expect(extractReasoningDelta({ reasoning_content: 'a' })).toBe('a');
  });
  it('returns reasoning (Kimi)', () => {
    expect(extractReasoningDelta({ reasoning: 'b' })).toBe('b');
  });
  it('prefers reasoning_content when both present', () => {
    expect(extractReasoningDelta({ reasoning_content: 'rc', reasoning: 'r' })).toBe('rc');
  });
  it('returns undefined when neither present', () => {
    expect(extractReasoningDelta({ content: 'normal text' })).toBeUndefined();
  });
  it('handles undefined delta', () => {
    expect(extractReasoningDelta(undefined)).toBeUndefined();
  });
});
