// @vitest-environment jsdom
// ============================================================================
// useDesktopPresence 心跳测试（N-NOTIFY-PRESENCE-HEARTBEAT ⑤）
// ============================================================================
// 挂载即报一拍、按 interval 续报、隐藏窗口立即加报 visible:false、卸载后监听与
// 心跳全部移除、输入事件按拍采样 lastInputAt。ipcService mock 掉，sessionStore 用真store。
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';

// 参数签名要显式声明，否则 mock.calls 的元组是 []，按索引取参过不了类型检查
const invokeDomain = vi.hoisted(() => vi.fn((_domain: string, _action: string, _payload?: unknown) => Promise.resolve({ success: true })));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain },
}));

import { useDesktopPresence } from '../../../src/renderer/hooks/useDesktopPresence';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const lastPayload = (): { visible: boolean; focused: boolean; lastInputAt: number; viewingSessionId: string | null } =>
  invokeDomain.mock.calls.at(-1)![2] as never;

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom 无真实窗口焦点，钉成聚焦态（与 useCronOsNotification 测试同款先例）
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  invokeDomain.mockClear();
  useSessionStore.setState({ currentSessionId: 'presence-hook-sess' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useDesktopPresence 心跳', () => {
  it('挂载即发一拍，随后按心跳间隔续发（domain/action/payload 同形）', () => {
    renderHook(() => useDesktopPresence());
    expect(invokeDomain).toHaveBeenCalledTimes(1);
    expect(invokeDomain.mock.calls[0]![0]).toBe(IPC_DOMAINS.NOTIFICATION);
    expect(invokeDomain.mock.calls[0]![1]).toBe('reportPresence');
    expect(lastPayload()).toMatchObject({ visible: true, focused: true, viewingSessionId: 'presence-hook-sess' });
    expect(typeof lastPayload().lastInputAt).toBe('number');
    act(() => { vi.advanceTimersByTime(L.desktopPresenceHeartbeatMs); });
    expect(invokeDomain).toHaveBeenCalledTimes(2);
    act(() => { vi.advanceTimersByTime(L.desktopPresenceHeartbeatMs); });
    expect(invokeDomain).toHaveBeenCalledTimes(3);
  });

  it('窗口隐藏：visibilitychange 立即加报一拍 visible:false（不等下一拍）', () => {
    renderHook(() => useDesktopPresence());
    expect(invokeDomain).toHaveBeenCalledTimes(1);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(invokeDomain).toHaveBeenCalledTimes(2);
    expect(lastPayload().visible).toBe(false);
  });

  it('输入事件按拍采样：keydown 后下一拍心跳带出新的 lastInputAt', () => {
    renderHook(() => useDesktopPresence());
    const first = lastPayload().lastInputAt;
    act(() => { vi.advanceTimersByTime(L.desktopPresenceInputSampleMs * 2); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });
    act(() => { vi.advanceTimersByTime(L.desktopPresenceHeartbeatMs); });
    expect(invokeDomain).toHaveBeenCalledTimes(2);
    expect(lastPayload().lastInputAt).toBeGreaterThan(first);
  });

  it('卸载后心跳与全部监听移除：走时间、切可见性、focus 都不再上报', () => {
    const { unmount } = renderHook(() => useDesktopPresence());
    expect(invokeDomain).toHaveBeenCalledTimes(1);
    unmount();
    act(() => { vi.advanceTimersByTime(L.desktopPresenceHeartbeatMs * 3); });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { window.dispatchEvent(new Event('focus')); });
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(invokeDomain).toHaveBeenCalledTimes(1);
  });

  it('IPC 失败被吞：reject 不冒泡，也不影响下一拍', async () => {
    invokeDomain.mockRejectedValueOnce(new Error('channel down'));
    renderHook(() => useDesktopPresence());
    await act(async () => { await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(L.desktopPresenceHeartbeatMs); });
    expect(invokeDomain).toHaveBeenCalledTimes(2);
  });
});
