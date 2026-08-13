import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/model/providers/providerHttp', () => ({ electronFetch }));

import { ResponsesProvider } from '../../../src/host/model/providers/responsesProvider';
// 直接从 wrapper 取：provider 侧不为测试单独 re-export（那条 re-export 在生产侧无消费者，
// production profile 的 knip 门会判成新增 dead export）。
import { convertToolsToResponses } from '../../../src/host/model/providers/wrappers/responsesWrapper';

const READ_TOOL = {
  name: 'read_file', description: 'Read a file', inputSchema: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
  }, requiresPermission: false, permissionLevel: 'read',
} as any;

/** 走真实调用路径断言最终请求 URL——端点拼接是内部实现，不为测试单独导出（knip production 门会判 dead export）。 */
async function requestUrlFor(baseUrl: string, provider = 'deepseek', model = 'deepseek-v4-flash'): Promise<string> {
  electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
  await new ResponsesProvider().inference([{ role: 'user', content: 'ping' }], [], {
    provider, model, apiKey: 'test-key', protocol: 'responses', baseUrl,
  } as any);
  return electronFetch.mock.calls.at(-1)![0] as string;
}

function sseResponse(events: unknown[]) {
  const encoder = new TextEncoder();
  return {
    ok: true, status: 200,
    text: vi.fn(), json: vi.fn(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    }),
  };
}

describe('responses endpoint per provider', () => {
  it('strips /vN only when the Responses API lives at the API root', async () => {
    // 官方 DeepSeek：Responses 在 api.deepseek.com 根路径，剥掉 /v1。
    expect(await requestUrlFor('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/responses');
    // 中转站：Responses 在 /v1/responses，/v1 必须保留（剥掉实测 405+HTML）。
    expect(await requestUrlFor('https://tokenrhythm.studio/v1', 'custom-tokenrhythm', 'deepseek-v4-flash-0731'))
      .toBe('https://tokenrhythm.studio/v1/responses');
  });
});

describe('ResponsesProvider', () => {
  beforeEach(() => electronFetch.mockReset());

  it('uses /responses beside a /v1 base URL and gates DeepSeek web_search by the matrix', async () => {
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
    const provider = new ResponsesProvider();
    await provider.inference([{ role: 'user', content: '查今天新闻' }], [], {
      provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', protocol: 'responses',
    } as any);

    expect(electronFetch).toHaveBeenCalledWith('https://api.deepseek.com/responses', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(electronFetch.mock.calls[0][1].body)).toMatchObject({
      model: 'deepseek-v4-flash', input: [{ role: 'user', content: '查今天新闻' }], store: false,
      tools: [{ type: 'web_search' }],
    });
  });

  it('strips a trailing /v1 but leaves other base paths intact', async () => {
    expect(await requestUrlFor('https://relay.test/v1/')).toBe('https://relay.test/responses');
    expect(await requestUrlFor('https://relay.test/api')).toBe('https://relay.test/api/responses');
  });

  it('converts function tools to the flat Responses shape, alongside web_search', async () => {
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
    await new ResponsesProvider().inference([{ role: 'user', content: 'read it' }], [READ_TOOL], {
      provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', protocol: 'responses',
    } as any);
    expect(convertToolsToResponses([READ_TOOL])).toEqual([expect.objectContaining({
      type: 'function', name: 'read_file', parameters: READ_TOOL.inputSchema,
    })]);
    expect(convertToolsToResponses([READ_TOOL])[0]).not.toHaveProperty('function');
    expect(JSON.parse(electronFetch.mock.calls[0][1].body).tools).toEqual([
      { type: 'web_search' },
      expect.objectContaining({ type: 'function', name: 'read_file', parameters: READ_TOOL.inputSchema }),
    ]);
  });

  it('parses function calls and returns their raw output for the tool-result round trip', async () => {
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({
      output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'functions_read_file_1', arguments: '{"path":"a.txt"}' }],
    }) });
    const result = await new ResponsesProvider().inference([{ role: 'user', content: 'read it' }], [READ_TOOL], {
      provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', protocol: 'responses',
    } as any);
    expect(result).toMatchObject({ type: 'tool_use', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } }] });
    expect(result.responsesOutput).toEqual([{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'functions_read_file_1', arguments: '{"path":"a.txt"}' }]);
  });

  it('returns function_call_output as the next Responses input without losing the preceding output', async () => {
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
    const priorOutput = [{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }];
    await new ResponsesProvider().inference([
      { role: 'assistant', content: '', responsesOutput: priorOutput },
      { role: 'tool', toolCallId: 'call_1', content: 'file contents' },
    ], [READ_TOOL], { provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key' } as any);
    expect(JSON.parse(electronFetch.mock.calls[0][1].body).input).toEqual([
      ...priorOutput, { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    ]);
  });

  it('streams answer deltas, reasoning/search progress, function arguments and cached usage without leaking process messages into text', async () => {
    electronFetch.mockResolvedValue(sseResponse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', content: [] } },
      { type: 'response.output_text.delta', delta: '先查资料。' },
      { type: 'response.web_search_call.in_progress', item: { type: 'web_search_call', id: 'ws_1', action: { type: 'search', query: 'Neo' } } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'read_file' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a' },
      { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"path":"a.txt"}' },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'message', content: [] } },
      { type: 'response.output_text.delta', output_index: 2, delta: '最终答案' },
      { type: 'response.completed', response: { output: [
        { type: 'message', content: [{ type: 'output_text', text: '先查资料。' }] },
        { type: 'web_search_call', id: 'ws_1', action: { type: 'search', query: 'Neo' } },
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
        { type: 'message', content: [{ type: 'output_text', text: '最终答案' }] },
      ], usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 8 } } } },
    ]));
    const onStream = vi.fn();
    const result = await new ResponsesProvider().inference([{ role: 'user', content: '查并读' }], [READ_TOOL], {
      provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', protocol: 'responses',
    } as any, onStream);
    expect(JSON.parse(electronFetch.mock.calls[0][1].body)).toMatchObject({ stream: true });
    expect(onStream).toHaveBeenCalledWith({ type: 'text', content: '最终答案' });
    expect(onStream).not.toHaveBeenCalledWith({ type: 'text', content: '先查资料。' });
    // 真机 2026-08-12 抓到的漏子：旁白只在最终 content 里被剔除，却照样沿 text 轨推给了用户
    // （流式 2459 字 vs 最终 2062 字）。判据必须是「推出去的正文」与「最终 content」逐字一致，
    // 光断言某句话没出现挡不住这个。
    const streamedText = onStream.mock.calls
      .map((call) => (call[0]?.type === 'text' ? String(call[0].content ?? '') : ''))
      .join('');
    expect(streamedText).toBe(result.content);
    expect(streamedText).not.toContain('先查资料。');
    expect(onStream).toHaveBeenCalledWith(expect.objectContaining({ type: 'reasoning', content: expect.stringContaining('Neo') }));
    expect(onStream).toHaveBeenCalledWith({ type: 'tool_call_delta', toolCall: { index: 1, argumentsDelta: '{"path":"a' } });
    expect(onStream).toHaveBeenCalledWith({ type: 'usage', inputTokens: 12, outputTokens: 5, cacheReadTokens: 8 });
    expect(result).toMatchObject({ type: 'tool_use', content: '最终答案', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } }] });
  });

  it('在 function_call 参数流开始前下发同轮 preamble 正文', async () => {
    electronFetch.mockResolvedValue(sseResponse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: '我先读取这个文件。' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'read_file' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a.txt"}' },
      { type: 'response.completed', response: { output: [
        { type: 'message', content: [{ type: 'output_text', text: '我先读取这个文件。' }] },
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      ] } },
    ]));
    const events: Array<{ type?: string; content?: string }> = [];

    const result = await new ResponsesProvider().inference([{ role: 'user', content: '读取文件' }], [READ_TOOL], {
      provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', protocol: 'responses',
    } as any, (event) => {
      if (typeof event !== 'string') events.push(event);
    });

    const preambleAt = events.findIndex((event) => event.type === 'text' && event.content === '我先读取这个文件。');
    const toolDeltaAt = events.findIndex((event) => event.type === 'tool_call_delta');
    expect(preambleAt).toBeGreaterThanOrEqual(0);
    expect(toolDeltaAt).toBeGreaterThan(preambleAt);
    // 铁律：推给用户的流式正文之和 === 最终 content，逐字一致、不双发
    const streamedText = events.filter((event) => event.type === 'text').map((event) => event.content).join('');
    expect(result.content).toBe('我先读取这个文件。');
    expect(streamedText).toBe(result.content);
  });

  it('does not mount web_search when the matrix says none', async () => {
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
    await new ResponsesProvider().inference([{ role: 'user', content: 'hello' }], [], {
      provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key', protocol: 'responses',
    } as any);
    expect(JSON.parse(electronFetch.mock.calls[0][1].body).tools).toBeUndefined();
  });

  it('omits web_search when the per-turn search toggle is off, even when the matrix allows it', async () => {
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
    await new ResponsesProvider().inference([{ role: 'user', content: '查今天新闻' }], [], {
      provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', protocol: 'responses',
    } as any, undefined, undefined, { searchEnabled: false });
    expect(JSON.parse(electronFetch.mock.calls[0][1].body).tools).toBeUndefined();
  });

  it('mounts web_search when the per-turn search toggle is explicitly on', async () => {
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
    await new ResponsesProvider().inference([{ role: 'user', content: '查今天新闻' }], [], {
      provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', protocol: 'responses',
    } as any, undefined, undefined, { searchEnabled: true });
    expect(JSON.parse(electronFetch.mock.calls[0][1].body).tools).toEqual([{ type: 'web_search' }]);
  });

  it('feeds the previous Responses output back into the next input unchanged', async () => {
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
    const priorOutput = [{ type: 'web_search_call', id: 'ws_1', action: { type: 'search', query: 'q' } }, { type: 'message', content: [{ type: 'output_text', text: 'a' }] }];
    await new ResponsesProvider().inference([
      { role: 'assistant', content: 'a', responsesOutput: priorOutput },
      { role: 'user', content: '再说一点' },
    ], [], { provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', protocol: 'responses' } as any);
    expect(JSON.parse(electronFetch.mock.calls[0][1].body).input).toEqual([...priorOutput, { role: 'user', content: '再说一点' }]);
  });
});
