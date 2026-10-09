// N-RUNINPUT-TOBACKGROUND-OPTION：后台切换通道在 web（HTTP bridge）模式下的形状。
// Tauri IPC 侧 background:move-to-* 是单 string 参数；web 路由吃 {sessionId} 对象、
// background:get-tasks 对应 GET /background/tasks。修的是 transport 边界的映射。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: {
    getState: () => ({ status: 'disconnected' }),
  },
}));

vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({
    invokeTool: vi.fn(),
  }),
}));

(globalThis as Record<string, unknown>).window = {
  __CODE_AGENT_TOKEN__: 'test-token',
};

import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

describe('httpTransport background 通道（web 模式）', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ success: true, data: { sessionId: 'session-1' } }),
      text: async () => '',
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('background:move-to-background 把单 string 参数包成 {sessionId} 对象发给 web 路由', async () => {
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await api.invoke(IPC_CHANNELS.BACKGROUND_MOVE_TO_BACKGROUND, 'session-1');

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8180/api/background/move-to-background');
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe('POST');
    expect(JSON.parse(String(requestInit.body))).toEqual({ sessionId: 'session-1' });
  });

  it('background:move-to-foreground 同样包 {sessionId}', async () => {
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await api.invoke(IPC_CHANNELS.BACKGROUND_MOVE_TO_FOREGROUND, 'session-1');

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8180/api/background/move-to-foreground');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ sessionId: 'session-1' });
  });

  it('background:get-tasks 映射到 GET /api/background/tasks（而非通用 get-tasks 路径）', async () => {
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await api.invoke(IPC_CHANNELS.BACKGROUND_GET_TASKS);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8180/api/background/tasks');
    expect((init as RequestInit).method).toBe('GET');
  });
});
