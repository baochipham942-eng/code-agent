// @vitest-environment jsdom
// 401 auth-token 恢复路径会排一个 250ms 的 reload 定时器；jsdom 环境先于定时器被拆掉时，
// 回调里的 window 变成未声明全局，抛 ReferenceError 让 vitest shard 随机变红。
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: { getState: () => ({ status: 'disconnected' }) },
}));
vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({ invokeTool: vi.fn() }),
}));

import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

describe('httpTransport auth-token reload timer', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    window.sessionStorage.clear();
  });

  it('does not throw when the window global is gone before the reload timer fires', async () => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: 'Invalid auth token' } }),
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await expect(
      api.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-401', 'allow', 'session-x'),
    ).rejects.toThrow('Invalid auth token');

    // 模拟环境拆除：定时器还没触发，window 已不存在
    vi.stubGlobal('window', undefined);
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
  });
});
