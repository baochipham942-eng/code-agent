import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/model/providers/providerHttp', () => ({ electronFetch }));

import { ResponsesProvider } from '../../../src/host/model/providers/responsesProvider';

/** 走真实调用路径断言最终请求 URL——端点拼接是内部实现，不为测试单独导出。 */
async function requestUrlFor(baseUrl: string): Promise<string> {
  electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
  await new ResponsesProvider().inference([{ role: 'user', content: 'ping' }], [], {
    provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'test-key', protocol: 'responses', baseUrl,
  } as any);
  return electronFetch.mock.calls.at(-1)![0] as string;
}

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

  it('does not mount web_search when the matrix says none', async () => {
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
    await new ResponsesProvider().inference([{ role: 'user', content: 'hello' }], [], {
      provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key', protocol: 'responses',
    } as any);
    expect(JSON.parse(electronFetch.mock.calls[0][1].body).tools).toBeUndefined();
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
