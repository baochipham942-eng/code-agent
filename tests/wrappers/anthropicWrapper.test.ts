import { describe, expect, it } from 'vitest';

import {
  parseClaudeResponse,
  parseClaudeSSEEvent,
} from '../../src/main/model/providers/wrappers/anthropicWrapper';

describe('anthropicWrapper / parseClaudeResponse', () => {
  it('success: parses text-only message', () => {
    const raw = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi from Claude' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 4 },
    };

    const result = parseClaudeResponse(raw);

    expect(result.type).toBe('text');
    expect(result.content).toBe('Hi from Claude');
  });

  it('tool_use: parses single tool_use block', () => {
    const raw = {
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'searchWeb',
          input: { query: 'claude api' },
        },
      ],
    };

    const result = parseClaudeResponse(raw);

    expect(result.type).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      id: 'toolu_1',
      name: 'searchWeb',
      arguments: { query: 'claude api' },
    });
  });

  it('multi_tool_use: parses multiple tool_use blocks', () => {
    const raw = {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'foo', input: { a: 1 } },
        { type: 'tool_use', id: 't2', name: 'bar', input: { b: 2 } },
      ],
    };

    const result = parseClaudeResponse(raw);

    expect(result.type).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls?.map((t) => t.name)).toEqual(['foo', 'bar']);
  });

  it('text+tool_use: preserves leading text and builds ordered contentParts', () => {
    // Claude content blocks 本身就是真实顺序：前导文本 block 在 tool_use block 之前。
    // 旧实现只抽 tool_use、丢了文本与顺序 → content_parts NULL → 渲染倒序。
    const raw = {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: '我先查一下当前目录。' },
        { type: 'tool_use', id: 'toolu_x', name: 'list_directory', input: { path: '.' } },
      ],
    };

    const result = parseClaudeResponse(raw);

    expect(result.type).toBe('tool_use');
    expect(result.content).toBe('我先查一下当前目录。');
    expect(result.contentParts).toEqual([
      { type: 'text', text: '我先查一下当前目录。' },
      { type: 'tool_call', toolCallId: 'toolu_x' },
    ]);
  });

  it('refusal: returns text when only text blocks (joined with newlines)', () => {
    const raw = {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'I cannot help with that.' },
        { type: 'text', text: 'Please rephrase.' },
      ],
    };

    const result = parseClaudeResponse(raw);

    expect(result.type).toBe('text');
    expect(result.content).toBe('I cannot help with that.\nPlease rephrase.');
  });

  it('unknown_field_passthrough: tolerates unknown extra fields and content block types', () => {
    const raw = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      // 顶层未知字段
      model: 'claude-4-opus',
      stop_sequence: null,
      // server_tool_use 块 — schema 含
      content: [
        { type: 'text', text: 'partial' },
        {
          type: 'server_tool_use',
          id: 'srv_1',
          name: 'web_search',
          input: { q: 'x' },
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    };

    expect(() => parseClaudeResponse(raw)).not.toThrow();
    const result = parseClaudeResponse(raw);
    // server_tool_use 不进入 toolCalls (跟旧 filter type=='tool_use' 行为一致)
    expect(result.type).toBe('text');
    expect(result.content).toBe('partial');
  });

  it('throws on empty content array', () => {
    const raw = { type: 'message', role: 'assistant', content: [] };
    expect(() => parseClaudeResponse(raw)).toThrow(/No response from model/);
  });
});

describe('anthropicWrapper / parseClaudeSSEEvent', () => {
  it('parses message_start event with usage', () => {
    const event = parseClaudeSSEEvent('message_start', {
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    });
    expect(event?.type).toBe('message_start');
    if (event?.type === 'message_start') {
      expect(event.message.usage?.input_tokens).toBe(5);
    }
  });

  it('parses content_block_start tool_use', () => {
    const event = parseClaudeSSEEvent('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'foo', input: {} },
    });
    expect(event?.type).toBe('content_block_start');
    if (event?.type === 'content_block_start') {
      expect(event.content_block.type).toBe('tool_use');
    }
  });

  it('parses content_block_delta text_delta', () => {
    const event = parseClaudeSSEEvent('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: 'hello' },
    });
    expect(event?.type).toBe('content_block_delta');
    if (event?.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      expect(event.delta.text).toBe('hello');
    }
  });

  it('parses content_block_delta input_json_delta', () => {
    const event = parseClaudeSSEEvent('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"k":' },
    });
    expect(event?.type).toBe('content_block_delta');
    if (event?.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
      expect(event.delta.partial_json).toBe('{"k":');
    }
  });

  it('parses content_block_delta thinking_delta', () => {
    const event = parseClaudeSSEEvent('content_block_delta', {
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'reasoning chunk' },
    });
    expect(event?.type).toBe('content_block_delta');
    if (event?.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
      expect(event.delta.thinking).toBe('reasoning chunk');
    }
  });

  it('parses message_delta with stop_reason and usage', () => {
    const event = parseClaudeSSEEvent('message_delta', {
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 42 },
    });
    expect(event?.type).toBe('message_delta');
    if (event?.type === 'message_delta') {
      expect(event.delta.stop_reason).toBe('end_turn');
      expect(event.usage?.output_tokens).toBe(42);
    }
  });

  it('parses message_stop / content_block_stop / ping events', () => {
    expect(parseClaudeSSEEvent('message_stop', {})?.type).toBe('message_stop');
    expect(parseClaudeSSEEvent('content_block_stop', { index: 0 })?.type).toBe(
      'content_block_stop',
    );
    expect(parseClaudeSSEEvent('ping', {})?.type).toBe('ping');
  });

  it('parses error event', () => {
    const event = parseClaudeSSEEvent('error', {
      error: { type: 'overloaded_error', message: 'service overloaded' },
    });
    expect(event?.type).toBe('error');
    if (event?.type === 'error') {
      expect(event.error.message).toBe('service overloaded');
    }
  });

  it('returns null on unknown event type (hot path safe)', () => {
    const event = parseClaudeSSEEvent('completely_new_event', { foo: 'bar' });
    expect(event).toBeNull();
  });

  it('passthrough: tolerates unknown fields on known events', () => {
    const event = parseClaudeSSEEvent('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: 'hi', cache_control: { type: 'ephemeral' } },
      // 未知顶层字段
      next_protocol_marker: 'v2',
    });
    expect(event?.type).toBe('content_block_delta');
  });
});
