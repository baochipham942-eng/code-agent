import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const axiosFn = vi.hoisted(() => {
  const fn = vi.fn();
  return Object.assign(fn, { isCancel: vi.fn(() => false) });
});
vi.mock('axios', () => ({ default: axiosFn }));

import { destroySharedHttpsAgent, electronFetch, getHttpsAgent } from '../../../src/host/model/providers/providerHttp';

// N-EVAL-CI-NOEXIT：共享 keep-alive agent 的空闲 TLS socket 会 ref 住事件循环（持有者点名 TLSWRAP 13），
// 收尾必须能销毁；销毁后缓存清空，下一次 getHttpsAgent 按需重建新实例。
describe('destroySharedHttpsAgent（N-EVAL-CI-NOEXIT）', () => {
  const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'DISABLE_PROXY'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
    delete process.env.NO_PROXY;
    delete process.env.DISABLE_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:17890';
    destroySharedHttpsAgent();
    return () => {
      destroySharedHttpsAgent();
      for (const key of PROXY_ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    };
  });

  it('销毁共享 agent 并清缓存：旧实例被 destroy，下一次取到新实例', () => {
    const agent = getHttpsAgent('https://api.example.com/v1/chat/completions');
    expect(agent).toBeDefined();
    expect(getHttpsAgent('https://api.example.com/v1/chat/completions')).toBe(agent);
    const destroySpy = vi.spyOn(agent!, 'destroy');

    destroySharedHttpsAgent();
    expect(destroySpy).toHaveBeenCalledTimes(1);

    const rebuilt = getHttpsAgent('https://api.example.com/v1/chat/completions');
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(agent);
  });

  it('无代理 env 时是 no-op，不报错', () => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    expect(() => destroySharedHttpsAgent()).not.toThrow();
    expect(getHttpsAgent('https://api.example.com/v1/chat/completions')).toBeUndefined();
  });
});

// N-MODELERR：stream:true 时 axios 的 response.data 是 Node Readable（错误响应也是，
// validateStatus 全放行）。报错体必须含上游原文，不许序列化出 {"_events":{},...} 的流壳。
describe('electronFetch 报错体保真（N-MODELERR）', () => {
  const UPSTREAM_ERROR = '{"error":{"message":"Invalid input: reasoning_content required","type":"invalid_request_error"}}';

  beforeEach(() => {
    axiosFn.mockReset();
  });

  it('stream:true 的非 2xx 响应，text() 返回上游原文而非序列化的流对象', async () => {
    axiosFn.mockResolvedValue({ status: 400, data: Readable.from([UPSTREAM_ERROR]) });
    const response = await electronFetch('https://api.example.com/responses', {
      method: 'POST', body: '{}', stream: true,
    });
    expect(response.ok).toBe(false);
    const text = await response.text();
    expect(text).toBe(UPSTREAM_ERROR);
    expect(text).toContain('Invalid input');
    expect(text).not.toContain('_readableState');
    expect(text).not.toContain('_events');
  });

  it('stream:true 的非 2xx 响应，json() 解析出上游结构化错误', async () => {
    axiosFn.mockResolvedValue({ status: 400, data: Readable.from([UPSTREAM_ERROR]) });
    const response = await electronFetch<{ error: { message: string } }>('https://api.example.com/responses', {
      method: 'POST', body: '{}', stream: true,
    });
    const parsed = await response.json();
    expect(parsed.error.message).toContain('reasoning_content');
  });

  it('非流式响应维持既有行为：对象 data 的 text() 仍是 JSON 序列化', async () => {
    axiosFn.mockResolvedValue({ status: 400, data: { error: { message: 'boom' } } });
    const response = await electronFetch('https://api.example.com/v1/chat/completions', {
      method: 'POST', body: '{}',
    });
    expect(await response.text()).toBe('{"error":{"message":"boom"}}');
    expect(await response.json()).toEqual({ error: { message: 'boom' } });
  });
});
