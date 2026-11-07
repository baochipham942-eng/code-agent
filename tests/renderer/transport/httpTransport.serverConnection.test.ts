// ============================================================================
// HttpTransport ↔ ServerConnectionMonitor 接线（N-WEBSERVER-DEATH-SUPERVISE-BANNER）
// ============================================================================
// 三个触发口（SSE onerror / invoke 网络失败 / /api/run 网络失败）与两条红线：
// HTTP 4xx/5xx 不触发监视器；横幅在（state != ok）时 /api/run 的网络失败给人话
// 文案而不是 WebKit 的裸 `TypeError: Load failed`。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { WEB_SERVER_CONNECTION_MONITOR } from '../../../src/shared/constants';

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

const fetchMock = vi.fn();
const reloadSpy = vi.fn();

type TransportModule = typeof import('../../../src/renderer/api/httpTransport');

async function loadModules(): Promise<{
  createHttpCodeAgentAPI: TransportModule['createHttpCodeAgentAPI'];
  status: () => string;
}> {
  const { createHttpCodeAgentAPI } = await import('../../../src/renderer/api/httpTransport');
  const store = await import('../../../src/renderer/stores/serverConnectionStore');
  return {
    createHttpCodeAgentAPI,
    status: () => store.useServerConnectionStore.getState().status,
  };
}

/** 网络失败的 fetch（fetch 拒绝、无 HTTP 响应）；/api/health 单独可控。 */
function installNetworkDownFetch(healthReachable = false): void {
  fetchMock.mockImplementation(async (input: unknown) => {
    if (String(input).includes('/api/health') && healthReachable) {
      return { ok: true, status: 200 } as unknown as Response;
    }
    throw new TypeError('Load failed');
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function healthProbeCalls(): unknown[][] {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/health'));
}

describe('httpTransport → serverConnectionMonitor 接线', () => {
  let originalWindow: unknown;
  let originalFetch: unknown;
  let originalEventSource: unknown;
  let originalLocalStorage: unknown;
  let sseInstances: Array<{ onerror: (() => void) | null; close: () => void }>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    reloadSpy.mockClear();
    fetchMock.mockReset();
    originalWindow = (globalThis as Record<string, unknown>).window;
    originalFetch = (globalThis as Record<string, unknown>).fetch;
    originalEventSource = (globalThis as Record<string, unknown>).EventSource;
    originalLocalStorage = (globalThis as Record<string, unknown>).localStorage;
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    (globalThis as Record<string, unknown>).window = {
      __CODE_AGENT_TOKEN__: undefined,
      location: { search: '', origin: 'http://localhost:8180', reload: reloadSpy },
    };
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    // 与 sseReconnect 测试同款 EventSource 桩，只保留 onerror/close
    sseInstances = [];
    (globalThis as Record<string, unknown>).EventSource = function (this: {
      onerror: (() => void) | null; close: () => void;
    }) {
      this.onerror = null;
      this.close = () => {};
      sseInstances.push(this);
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as Record<string, unknown>).window = originalWindow;
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    (globalThis as Record<string, unknown>).EventSource = originalEventSource;
    (globalThis as Record<string, unknown>).localStorage = originalLocalStorage;
  });

  it('invoke 网络失败（fetch 拒绝）触发 /api/health 探测；探测成功则不出横幅不刷新', async () => {
    installNetworkDownFetch(true); // 业务端点全挂，但服务进程活着（health 可达）
    const { createHttpCodeAgentAPI, status } = await loadModules();
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await expect(api.invoke(IPC_CHANNELS.SETTINGS_GET)).resolves.toBeUndefined();
    expect(status()).toBe('ok');

    await vi.advanceTimersByTimeAsync(0); // 首发探测
    expect(healthProbeCalls()).toHaveLength(1);
    expect(String(healthProbeCalls()[0][0])).toBe('http://localhost:8180/api/health');
    await vi.advanceTimersByTimeAsync(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS * 2);
    expect(status()).toBe('ok');
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('invoke 收到 HTTP 500（有 HTTP 响应）不触发连接监视器', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).includes('/api/health')) {
        throw new Error('probe should not happen');
      }
      return jsonResponse(500, { error: { message: 'boom' } });
    });
    const { createHttpCodeAgentAPI, status } = await loadModules();
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await api.invoke(IPC_CHANNELS.SETTINGS_GET);
    await vi.advanceTimersByTimeAsync(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS * 3);
    expect(healthProbeCalls()).toHaveLength(0);
    expect(status()).toBe('ok');
  });

  it('SSE onerror 触发探测：连续失败出 recovering，随后恢复回 ok 且恰好 reload 一次', async () => {
    installNetworkDownFetch(false);
    const { createHttpCodeAgentAPI, status } = await loadModules();
    const api = createHttpCodeAgentAPI('http://localhost:8180');
    api.on('swarm:event', () => {});
    expect(sseInstances).toHaveLength(1);

    sseInstances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(0); // 探测失败 #1
    expect(status()).toBe('ok');
    await vi.advanceTimersByTimeAsync(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS); // #2
    expect(status()).toBe('recovering');
    expect(reloadSpy).not.toHaveBeenCalled();

    // 服务被壳拉起来了：探测成功 → ok + 一次 reload（新 boot/auth 状态）
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200 }) as unknown as Response);
    await vi.advanceTimersByTimeAsync(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    expect(status()).toBe('ok');
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('/api/run 网络失败在 recovering 态抛人话文案，而不是裸 Load failed', async () => {
    installNetworkDownFetch(false);
    const { createHttpCodeAgentAPI, status } = await loadModules();
    const api = createHttpCodeAgentAPI('http://localhost:8180');
    api.on('swarm:event', () => {});
    sseInstances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    expect(status()).toBe('recovering');

    let thrown: Error | undefined;
    try {
      await api.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, '你好');
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain('正在重新连接后台服务');
    expect(thrown?.message).not.toContain('Load failed');
  });

  it('/api/run 网络失败在 ok 态（阈值未到）原样上抛原始错误', async () => {
    installNetworkDownFetch(false);
    const { createHttpCodeAgentAPI, status } = await loadModules();
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await expect(api.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, '你好')).rejects.toThrow('Load failed');
    expect(status()).toBe('ok'); // 探测刚起步，还没到出横幅的阈值
  });
});
