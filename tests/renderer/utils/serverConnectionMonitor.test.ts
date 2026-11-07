// ============================================================================
// ServerConnectionMonitor — 后台服务死亡期间的状态机（N-WEBSERVER-DEATH-SUPERVISE-BANNER）
// ============================================================================
// fake timers + fetch mock，只走公共入口（reportServerUnreachable / retryNow /
// useServerConnectionStore 的 status）。vi.resetModules 让每个用例拿到全新的
// 单例状态（监视器的 probing/故障计数是模块级）。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WEB_SERVER_CONNECTION_MONITOR } from '../../../src/shared/constants';

const reloadSpy = vi.fn();
const fetchMock = vi.fn();

type MonitorModule = typeof import('../../../src/renderer/utils/serverConnectionMonitor');
type StoreModule = typeof import('../../../src/renderer/stores/serverConnectionStore');

async function freshMonitor(): Promise<{ monitor: MonitorModule; store: StoreModule }> {
  const monitor = await import('../../../src/renderer/utils/serverConnectionMonitor');
  const store = await import('../../../src/renderer/stores/serverConnectionStore');
  return { monitor, store };
}

function statusOf(store: StoreModule): string {
  return store.useServerConnectionStore.getState().status;
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('serverConnectionMonitor 状态机', () => {
  let monitor: MonitorModule;
  let store: StoreModule;
  let originalWindow: unknown;
  let originalFetch: unknown;
  let originalLocalStorage: unknown;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    reloadSpy.mockClear();
    fetchMock.mockReset();
    originalWindow = (globalThis as Record<string, unknown>).window;
    originalFetch = (globalThis as Record<string, unknown>).fetch;
    originalLocalStorage = (globalThis as Record<string, unknown>).localStorage;
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    // getApiBaseUrl 需要 window.location 与裸 localStorage；reload 走 spy 探测「恰好一次」。
    (globalThis as Record<string, unknown>).window = {
      __CODE_AGENT_TOKEN__: undefined,
      location: { search: '', origin: 'http://localhost:8180', reload: reloadSpy },
    };
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    ({ monitor, store } = await freshMonitor());
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as Record<string, unknown>).window = originalWindow;
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    (globalThis as Record<string, unknown>).localStorage = originalLocalStorage;
  });

  it('初始态是 ok，没有任何探测定时器', () => {
    expect(statusOf(store)).toBe('ok');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('1 次失败后成功：不出横幅（仍 ok）、不刷新页面，探测停表', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce({ ok: true, status: 200 } as unknown as Response);
    monitor.reportServerUnreachable();

    await advance(0); // 首发探测失败（第 1 次，未到阈值）
    expect(statusOf(store)).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS); // 第 2 发成功
    expect(statusOf(store)).toBe('ok');
    expect(reloadSpy).not.toHaveBeenCalled();

    // 已停表：再走一个探测间隔也不该有新 fetch
    const calls = fetchMock.mock.calls.length;
    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS * 3);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('连续 2 次探测失败进入 recovering（横幅出现），还不刷新', async () => {
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    monitor.reportServerUnreachable();

    await advance(0);
    expect(statusOf(store)).toBe('ok'); // 第 1 次失败不惊动用户

    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    expect(statusOf(store)).toBe('recovering');
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('持续不可达满 30s 升级为 unavailable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    monitor.reportServerUnreachable();

    await advance(0);
    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    expect(statusOf(store)).toBe('recovering');

    // t=2s → t=30s：探测持续失败，出事时长满 UNAVAILABLE_AFTER_MS
    await advance(
      WEB_SERVER_CONNECTION_MONITOR.UNAVAILABLE_AFTER_MS - WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS,
    );
    expect(statusOf(store)).toBe('unavailable');
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('横幅出过之后首次成功：回 ok 且恰好 reload 一次；HTTP 500 的健康响应也算服务活着', async () => {
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    monitor.reportServerUnreachable();
    await advance(0);
    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    expect(statusOf(store)).toBe('recovering');

    // /api/health 返回 500：进程活着（fetch resolve 即可达），横幅该撤
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);
    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    expect(statusOf(store)).toBe('ok');
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('第二轮故障恢复会再次 reload（按故障计次，不是每页一生一次）', async () => {
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    monitor.reportServerUnreachable();
    await advance(0);
    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as unknown as Response);
    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    // 第二轮故障
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    monitor.reportServerUnreachable();
    await advance(0);
    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    expect(statusOf(store)).toBe('recovering');

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as unknown as Response);
    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    expect(statusOf(store)).toBe('ok');
    expect(reloadSpy).toHaveBeenCalledTimes(2);
  });

  it('unavailable 态 retryNow() 立即探测，成功后回 ok 并 reload', async () => {
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    monitor.reportServerUnreachable();
    await advance(0);
    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    await advance(
      WEB_SERVER_CONNECTION_MONITOR.UNAVAILABLE_AFTER_MS - WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS,
    );
    expect(statusOf(store)).toBe('unavailable');

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as unknown as Response);
    monitor.retryNow();
    await advance(0); // 不等 PROBE_INTERVAL_MS，立即收口
    expect(statusOf(store)).toBe('ok');
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('ok 态 retryNow() 是 no-op（没有探测循环时不起表）', async () => {
    monitor.retryNow();
    await advance(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusOf(store)).toBe('ok');
  });
});
