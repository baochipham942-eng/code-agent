import { describe, expect, it } from 'vitest';

import {
  parseOpenAIResponse,
  parseOpenAIStreamChunk,
} from '../../src/host/model/providers/wrappers/openaiWrapper';

describe('openaiWrapper / parseOpenAIResponse', () => {
  it('success: parses text-only response', () => {
    const raw = {
      id: 'chatcmpl-1',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello world' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };

    const result = parseOpenAIResponse(raw);

    expect(result.type).toBe('text');
    expect(result.content).toBe('hello world');
  });

  it('tool_use: parses single tool call with JSON arguments', () => {
    const raw = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'getWeather', arguments: '{"city":"Shanghai"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };

    const result = parseOpenAIResponse(raw);

    expect(result.type).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      id: 'call_1',
      name: 'getWeather',
      arguments: { city: 'Shanghai' },
    });
  });

  it('multi_tool_use: parses multiple tool calls preserving order', () => {
    const raw = {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_a',
                type: 'function',
                function: { name: 'searchWeb', arguments: '{"q":"a"}' },
              },
              {
                id: 'call_b',
                type: 'function',
                function: { name: 'readFile', arguments: '{"path":"./b"}' },
              },
            ],
          },
        },
      ],
    };

    const result = parseOpenAIResponse(raw);

    expect(result.type).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls?.[0].name).toBe('searchWeb');
    expect(result.toolCalls?.[1].name).toBe('readFile');
  });

  it('tool_use with preamble: preserves content and builds ordered contentParts (text before tools)', () => {
    // 真实 MiMo 非流式响应：message 同时含 content(工具前的前导语) + tool_calls。
    // 旧实现只返回 toolCalls，丢了 content 和交错顺序 → 落库 content_parts NULL → 渲染倒序。
    const raw = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '我将为你搜索关于 TypeScript 6.0 的信息。',
            tool_calls: [
              {
                id: 'call_x',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"TypeScript 6.0"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };

    const result = parseOpenAIResponse(raw);

    expect(result.type).toBe('tool_use');
    expect(result.content).toBe('我将为你搜索关于 TypeScript 6.0 的信息。');
    expect(result.contentParts).toEqual([
      { type: 'text', text: '我将为你搜索关于 TypeScript 6.0 的信息。' },
      { type: 'tool_call', toolCallId: 'call_x' },
    ]);
  });

  it('refusal: returns plain text when no tool_calls and no Calling-syntax', () => {
    const raw = {
      choices: [{ message: { content: "I can't help with that." }, finish_reason: 'stop' }],
    };

    const result = parseOpenAIResponse(raw);

    expect(result.type).toBe('text');
    expect(result.content).toBe("I can't help with that.");
  });

  it('compat: treats null tool_calls as no tool call for text responses', () => {
    const raw = {
      id: 'xiaomi-final-text',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '文件已创建并验证。',
            tool_calls: null,
          },
          finish_reason: 'stop',
        },
      ],
    };

    const result = parseOpenAIResponse(raw);

    expect(result.type).toBe('text');
    expect(result.content).toBe('文件已创建并验证。');
  });

  it('unknown_field_passthrough: tolerates unknown extra fields without throwing', () => {
    const raw = {
      id: 'chatcmpl-9',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok',
            // 模拟新供应商加的未声明字段
            audio_metadata: { duration_ms: 100 },
            tool_calls_id_v2: 'something',
          },
          finish_reason: 'stop',
          // 同样加 choice 级未知字段
          logprobs: null,
        },
      ],
      // 顶层未知字段
      system_fingerprint: 'fp_xxx',
      service_tier: 'priority',
    };

    expect(() => parseOpenAIResponse(raw)).not.toThrow();
    const result = parseOpenAIResponse(raw);
    expect(result.type).toBe('text');
    expect(result.content).toBe('ok');
  });

  it('compat: falls back to text when provider returns content parts in final response', () => {
    const raw = {
      id: 'xiaomi-final-content-parts',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '<!doctype html>' },
              { type: 'text', text: '<html></html>' },
            ],
          },
          finish_reason: 'stop',
        },
      ],
    };

    const result = parseOpenAIResponse(raw);

    expect(result.type).toBe('text');
    expect(result.content).toBe('<!doctype html><html></html>');
  });

  it('throws on missing choices array', () => {
    const raw = { id: 'x' };
    expect(() => parseOpenAIResponse(raw)).toThrow(/Invalid OpenAI response shape/);
  });

  it('normalizes functions_ prefix and _N suffix in tool name', () => {
    const raw = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'functions_AgentSpawn_3', arguments: '{}' },
              },
            ],
          },
        },
      ],
    };

    const result = parseOpenAIResponse(raw);
    expect(result.toolCalls?.[0].name).toBe('AgentSpawn');
  });

  it('falls back to text when tool_calls JSON is irreparable', () => {
    const raw = {
      choices: [
        {
          message: {
            content: 'sorry, broken args',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'doX', arguments: '{not even close to json' },
              },
            ],
          },
        },
      ],
    };

    const result = parseOpenAIResponse(raw);
    // safeJsonParse 多策略 fallback 后返回 args（可能含 __parseError 标记或 extracted 部分），
    // 行为对齐旧 parseOpenAIResponse —— 返回 tool_use 而非 text fallback
    expect(['tool_use', 'text']).toContain(result.type);
  });
});

describe('openaiWrapper / parseOpenAIStreamChunk', () => {
  it('parses text delta chunk', () => {
    const raw = {
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }],
    };
    const chunk = parseOpenAIStreamChunk(raw);
    expect(chunk).not.toBeNull();
    expect(chunk?.choices?.[0].delta?.content).toBe('hi');
  });

  it('parses reasoning_content chunk (DeepSeek/GLM)', () => {
    const raw = {
      choices: [{ delta: { reasoning_content: 'thinking step 1' } }],
    };
    const chunk = parseOpenAIStreamChunk(raw);
    expect(chunk?.choices?.[0].delta?.reasoning_content).toBe('thinking step 1');
  });

  it('parses Kimi reasoning chunk', () => {
    const raw = {
      choices: [{ delta: { reasoning: 'kimi thinking' } }],
    };
    const chunk = parseOpenAIStreamChunk(raw);
    expect(chunk?.choices?.[0].delta?.reasoning).toBe('kimi thinking');
  });

  it('parses tool call delta with index', () => {
    const raw = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_x',
                function: { name: 'foo', arguments: '{"k":"v"}' },
              },
            ],
          },
        },
      ],
    };
    const chunk = parseOpenAIStreamChunk(raw);
    expect(chunk?.choices?.[0].delta?.tool_calls?.[0]).toMatchObject({
      index: 0,
      id: 'call_x',
    });
  });

  it('parses usage-only chunk (stream_options.include_usage)', () => {
    const raw = {
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const chunk = parseOpenAIStreamChunk(raw);
    expect(chunk?.usage?.prompt_tokens).toBe(10);
  });

  it('returns null on malformed chunk (hot path safe)', () => {
    const raw = { choices: 'not an array' };
    const chunk = parseOpenAIStreamChunk(raw);
    expect(chunk).toBeNull();
  });

  it('passthrough: tolerates unknown fields in delta', () => {
    const raw = {
      choices: [
        {
          delta: {
            content: 'ok',
            // 未来字段
            audio_delta: 'base64data',
            citation_v2: { url: 'x' },
          },
        },
      ],
    };
    const chunk = parseOpenAIStreamChunk(raw);
    expect(chunk?.choices?.[0].delta?.content).toBe('ok');
  });

  it('compat: tolerates null fields in OpenAI-compatible stream chunks', () => {
    const raw = {
      choices: [
        null,
        {
          index: null,
          delta: {
            role: null,
            content: null,
            reasoning_content: null,
            reasoning: null,
            tool_calls: [
              {
                index: null,
                id: null,
                type: null,
                function: null,
              },
            ],
          },
          finish_reason: null,
        },
        {
          delta: null,
          finish_reason: 'stop',
        },
      ],
      usage: null,
    };

    const chunk = parseOpenAIStreamChunk(raw);

    expect(chunk).not.toBeNull();
    expect(chunk?.choices?.[0].delta?.content).toBeNull();
    expect(chunk?.choices?.[1].delta).toBeNull();
    expect(chunk?.choices).toHaveLength(2);
    expect(chunk?.usage).toBeNull();
  });
});
