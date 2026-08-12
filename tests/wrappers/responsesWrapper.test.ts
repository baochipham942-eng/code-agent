import { describe, expect, it } from 'vitest';

import { parseResponsesResponse } from '../../src/host/model/providers/wrappers/responsesWrapper';

describe('responsesWrapper / parseResponsesResponse', () => {
  // 形态取自 2026-08-12 对 api.deepseek.com/responses 的真机调用：一次问答返回 7 条 message，
  // 前 6 条是每次工具调用前的过程旁白，只有最后一次 web_search_call 之后那条才是答案。
  it('treats messages before the last tool call as narration, not answer text', () => {
    const output = [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '先定检索策略' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '让我打开官方文档核实。' }] },
      { type: 'web_search_call', id: 'ws_1', action: { type: 'search', query: 'claude models' } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '直接访问被拦截了，改用搜索。' }] },
      { type: 'web_search_call', id: 'ws_2', action: { type: 'open_page', url: 'https://example.com/news' } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '以下是核实后的结论：……' }] },
    ];

    const result = parseResponsesResponse({ output });

    expect(result.content).toBe('以下是核实后的结论：……');
    expect(result.content).not.toContain('让我打开官方文档核实');
    expect(result.content).not.toContain('直接访问被拦截了');
    expect(result.thinking).toContain('让我打开官方文档核实。');
    expect(result.searchTrace).toHaveLength(2);
  });

  // 真机 usage：input_tokens 是含缓存的总量，缓存命中量在 input_tokens_details.cached_tokens。
  // 仓内统一口径是 inputTokens 只算非缓存部分，缓存读单列（单价约 1/10），不拆会让成本虚高。
  it('splits cached input tokens out of inputTokens', () => {
    const result = parseResponsesResponse({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '答案' }] }],
      usage: { input_tokens: 87479, output_tokens: 4244, input_tokens_details: { cached_tokens: 64256 } },
    });

    expect(result.usage).toMatchObject({
      inputTokens: 87479 - 64256,
      outputTokens: 4244,
      cacheReadTokens: 64256,
    });
  });

  it('parses mixed reasoning, web search, and message output without losing input tokens', () => {
    const output = [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '先查最新资料' }] },
      { type: 'web_search_call', id: 'ws_1', action: { type: 'search', query: 'Neo Responses API' } },
      { type: 'web_search_call', id: 'ws_2', action: { type: 'open_page', url: 'https://example.com/docs' } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '查到结果了。' }] },
    ];

    const result = parseResponsesResponse({ output, usage: { input_tokens: 16903, output_tokens: 42 } });

    expect(result).toMatchObject({
      type: 'text',
      content: '查到结果了。',
      thinking: '先查最新资料',
      usage: { inputTokens: 16903, outputTokens: 42 },
      responsesOutput: output,
    });
    expect(result.searchTrace).toEqual([
      { id: 'ws_1', action: 'search', query: 'Neo Responses API' },
      { id: 'ws_2', action: 'open_page', url: 'https://example.com/docs' },
    ]);
  });

  it('degrades safely for unknown output items and missing fields', () => {
    expect(() => parseResponsesResponse({ output: [{ type: 'future_item', extra: true }, { type: 'message' }] })).not.toThrow();
    expect(parseResponsesResponse({ output: [{ type: 'future_item', extra: true }, { type: 'message' }] })).toMatchObject({
      type: 'text', content: '', responsesOutput: [{ type: 'future_item', extra: true }, { type: 'message' }],
    });
  });
});
