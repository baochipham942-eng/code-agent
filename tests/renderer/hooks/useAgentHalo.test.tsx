// @vitest-environment jsdom
// useAgentHalo 的 renderHook 测试：门控（只在 nativeCursor=native 后显示）、
// active/idle 降档时序、run 结束隐藏。mock ipcService.on + nativeCommandFacade。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

type AgentEventListener = (event: { type: string; data?: unknown }) => void;

let agentEventListener: AgentEventListener | null = null;
const invokeNative = vi.fn(async () => undefined);

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (_channel: string, listener: AgentEventListener) => {
      agentEventListener = listener;
      return () => {
        agentEventListener = null;
      };
    },
  },
}));

vi.mock('../../../src/renderer/services/nativeCommandFacade', () => ({
  invokeNativeCommandAction: (...args: unknown[]) => invokeNative(...args as [never]),
}));

import { useAgentHalo } from '../../../src/renderer/hooks/useAgentHalo';

function pointerToolEnd(nativeStatus: string | null) {
  return {
    type: 'tool_call_end',
    data: {
      metadata: {
        agentPointerEvent: {
          id: 'evt-1',
          surface: 'computer',
          tone: 'computer',
          phase: 'click',
          coordSpace: 'screen',
          point: { x: 10, y: 20, unit: 'px' },
          nativeCursor: nativeStatus
            ? { enabled: nativeStatus === 'native', status: nativeStatus, provider: 'cua-driver', supportsSystemOverlay: true }
            : null,
        },
      },
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useAgentHalo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeNative.mockClear();
    agentEventListener = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores computer pointer events until a native-confirmed one arrives', async () => {
    const view = renderHook(() => useAgentHalo());
    act(() => agentEventListener?.(pointerToolEnd('fallback')));
    await flush();
    expect(invokeNative).not.toHaveBeenCalled();

    act(() => agentEventListener?.(pointerToolEnd('native')));
    await flush();
    expect(invokeNative.mock.calls.map((c) => c[0])).toEqual(['showAgentHalo', 'setAgentHaloMode']);
    expect(invokeNative.mock.calls[1][1]).toEqual({ mode: 'active' });
    view.unmount();
  });

  it('keeps halo shown for follow-up fallback events and decays to idle after hold', async () => {
    const view = renderHook(() => useAgentHalo());
    act(() => agentEventListener?.(pointerToolEnd('native')));
    await flush();
    invokeNative.mockClear();

    // 已显示后，后续普通动作事件（fallback capability）继续保持 active
    act(() => agentEventListener?.(pointerToolEnd('fallback')));
    await flush();
    expect(invokeNative.mock.calls[0]).toEqual(['setAgentHaloMode', { mode: 'active' }]);
    invokeNative.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(2300);
      await Promise.resolve();
    });
    expect(invokeNative.mock.calls[0]).toEqual(['setAgentHaloMode', { mode: 'idle' }]);
    view.unmount();
  });

  it('hides halo when the run ends', async () => {
    const view = renderHook(() => useAgentHalo());
    act(() => agentEventListener?.(pointerToolEnd('native')));
    await flush();
    invokeNative.mockClear();

    act(() => agentEventListener?.({ type: 'agent_complete' }));
    await flush();
    expect(invokeNative.mock.calls[0][0]).toBe('hideAgentHalo');
    view.unmount();
  });
});
