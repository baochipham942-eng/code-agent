// @vitest-environment jsdom
// terminal_open 的「亮出来」这条线：host 事件 → surfaceIntent → 右栏切到 terminal。
// 这段 glue 坏掉的表现是「什么也没发生」，最难自查，所以单独钉一条。

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

type RevealListener = (payload: { sessionId: string }) => void;
let subscribed: { channel: string; listener: RevealListener } | null = null;
const unsubscribe = vi.fn();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (channel: string, listener: RevealListener) => {
      subscribed = { channel, listener };
      return unsubscribe;
    },
  },
}));

const { useTerminalRevealBridge } = await import('../../../src/renderer/hooks/useTerminalRevealBridge');
const { useAppStore } = await import('../../../src/renderer/stores/appStore');
const { resetSurfaceIntentRuntimeForTests } = await import('../../../src/renderer/services/surfaceIntentRuntime');
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');

beforeEach(() => {
  subscribed = null;
  unsubscribe.mockClear();
  resetSurfaceIntentRuntimeForTests();
  useSessionStore.setState({ currentSessionId: 'session-a', messages: [] });
  useAppStore.setState({ workbenchTabs: [], activeWorkbenchTab: null });
});

describe('useTerminalRevealBridge', () => {
  it('opens the terminal view when the host asks to reveal this session', () => {
    renderHook(() => useTerminalRevealBridge());

    expect(subscribed?.channel).toBe(IPC_CHANNELS.TERMINAL_REVEAL);
    subscribed?.listener({ sessionId: 'session-a' });

    expect(useAppStore.getState().activeWorkbenchTab).toBe('terminal');
  });

  it('ignores a reveal aimed at a background conversation', () => {
    renderHook(() => useTerminalRevealBridge());

    subscribed?.listener({ sessionId: 'session-b' });

    expect(useAppStore.getState().activeWorkbenchTab).toBeNull();
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useTerminalRevealBridge());
    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });
});
