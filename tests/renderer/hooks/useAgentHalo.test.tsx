// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AgentEventListener = (event: { type: string; data?: unknown; sessionId?: string }) => void;

let agentEventListener: AgentEventListener | null = null;
const invokeNative = vi.fn(async (_action: string, _payload?: unknown) => undefined);

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
  invokeNativeCommandAction: (...args: [string, unknown?]) => invokeNative(...args),
}));

import { useAgentHalo } from '../../../src/renderer/hooks/useAgentHalo';

function capability(status: 'native' | 'fallback' | 'unavailable') {
  return status === 'native'
    ? {
        enabled: true,
        status,
        provider: 'cua-driver',
        supportsSystemOverlay: true,
        reason: 'start_session_available',
        fallbackSurface: null,
        checkedAtMs: 100,
      }
    : {
        enabled: false,
        status,
        provider: 'renderer',
        supportsSystemOverlay: false,
        reason: 'native_cursor_not_confirmed',
        fallbackSurface: 'renderer',
        checkedAtMs: 101,
      };
}

function cuaToolResult(options: {
  sessionId?: string;
  status?: 'native' | 'fallback' | 'unavailable';
  toolName?: string;
  serverName?: string;
  capabilityOverride?: Record<string, unknown>;
  legacyPath?: 'agentPointerEvent' | 'browserComputerProof';
} = {}) {
  const nativeCursor = {
    ...capability(options.status ?? 'native'),
    ...options.capabilityOverride,
  };
  const pointer = {
    id: 'evt-1',
    surface: 'computer',
    tone: 'computer',
    phase: 'click',
    coordSpace: 'screen',
    point: { x: 10, y: 20, unit: 'px' },
    nativeCursor,
  };
  const metadata: Record<string, unknown> = {
    serverName: options.serverName ?? 'cua-driver',
    toolName: options.toolName ?? 'click',
  };
  if (options.legacyPath === 'agentPointerEvent') {
    metadata.agentPointerEvent = pointer;
  } else if (options.legacyPath === 'browserComputerProof') {
    metadata.browserComputerProof = { agentPointerEvent: pointer };
  } else {
    metadata.agentPointerNativeCursor = nativeCursor;
  }
  return {
    type: 'tool_call_end',
    sessionId: options.sessionId ?? 'session-owner',
    data: {
      toolCallId: `tool-${options.toolName ?? 'click'}`,
      success: true,
      metadata,
    },
  };
}

async function emit(event: ReturnType<typeof cuaToolResult> | { type: string; data?: unknown; sessionId?: string }) {
  await act(async () => {
    agentEventListener?.(event);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('useAgentHalo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeNative.mockReset();
    invokeNative.mockResolvedValue(undefined);
    agentEventListener = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims from the production ToolResult native cursor payload', async () => {
    const view = renderHook(() => useAgentHalo());

    await emit(cuaToolResult());

    expect(invokeNative.mock.calls).toEqual([
      ['showAgentHalo'],
      ['setAgentHaloMode', { mode: 'active' }],
    ]);
    view.unmount();
  });

  it('requires every native claim field and ignores fallback before confirmation', async () => {
    const view = renderHook(() => useAgentHalo());

    await emit(cuaToolResult({ status: 'fallback' }));
    await emit(cuaToolResult({ capabilityOverride: { enabled: false } }));
    await emit(cuaToolResult({ capabilityOverride: { supportsSystemOverlay: false } }));
    await emit(cuaToolResult({ capabilityOverride: { provider: 'renderer' } }));
    expect(invokeNative).not.toHaveBeenCalled();

    await emit(cuaToolResult());
    expect(invokeNative.mock.calls.map(([action]) => action)).toEqual([
      'showAgentHalo',
      'setAgentHaloMode',
    ]);
    view.unmount();
  });

  it('lets fallback cua-driver activity from the owner refresh active and idle timing', async () => {
    const view = renderHook(() => useAgentHalo());
    await emit(cuaToolResult());
    invokeNative.mockClear();

    await advance(1_000);
    await emit(cuaToolResult({ status: 'fallback', toolName: 'click' }));
    expect(invokeNative).toHaveBeenCalledWith('setAgentHaloMode', { mode: 'active' });

    invokeNative.mockClear();
    await advance(2_199);
    expect(invokeNative).not.toHaveBeenCalled();
    await advance(1);
    expect(invokeNative).toHaveBeenCalledWith('setAgentHaloMode', { mode: 'idle' });
    view.unmount();
  });

  it('does not refresh confirmed ownership from an unavailable capability', async () => {
    const view = renderHook(() => useAgentHalo());
    await emit(cuaToolResult());
    invokeNative.mockClear();

    await emit(cuaToolResult({ status: 'unavailable' }));

    expect(invokeNative).not.toHaveBeenCalled();
    view.unmount();
  });

  it('does not let foreign sessions change mode, timer, or visibility', async () => {
    const view = renderHook(() => useAgentHalo());
    await emit(cuaToolResult());
    invokeNative.mockClear();

    await advance(1_000);
    await emit(cuaToolResult({ sessionId: 'session-foreign', status: 'fallback' }));
    await emit({ type: 'agent_complete', data: null, sessionId: 'session-foreign' });
    expect(invokeNative).not.toHaveBeenCalled();

    await advance(1_200);
    expect(invokeNative.mock.calls).toEqual([
      ['setAgentHaloMode', { mode: 'idle' }],
    ]);
    view.unmount();
  });

  it('retries a native claim after show rejects', async () => {
    const view = renderHook(() => useAgentHalo());
    invokeNative.mockRejectedValueOnce(new Error('web mode'));

    await emit(cuaToolResult());
    expect(invokeNative.mock.calls.map(([action]) => action)).toEqual(['showAgentHalo']);

    await emit(cuaToolResult());
    expect(invokeNative.mock.calls.map(([action]) => action)).toEqual([
      'showAgentHalo',
      'showAgentHalo',
      'setAgentHaloMode',
    ]);
    view.unmount();
  });

  it('finishes hidden when the owner terminates while show is pending', async () => {
    const view = renderHook(() => useAgentHalo());
    const pendingShow = deferred<void>();
    invokeNative.mockImplementationOnce(() => pendingShow.promise);

    await emit(cuaToolResult());
    expect(invokeNative).toHaveBeenCalledWith('showAgentHalo');

    await emit({ type: 'stream_end', data: null, sessionId: 'session-owner' });
    expect(invokeNative).toHaveBeenCalledWith('hideAgentHalo');

    pendingShow.resolve();
    await act(async () => {
      await pendingShow.promise;
      await Promise.resolve();
    });
    expect(invokeNative).not.toHaveBeenCalledWith('setAgentHaloMode', { mode: 'active' });
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
  });

  it('finishes hidden when unmounted while show is pending', async () => {
    const view = renderHook(() => useAgentHalo());
    const pendingShow = deferred<void>();
    invokeNative.mockImplementationOnce(() => pendingShow.promise);

    await emit(cuaToolResult());
    view.unmount();
    expect(invokeNative).toHaveBeenCalledWith('hideAgentHalo');

    pendingShow.resolve();
    await act(async () => {
      await pendingShow.promise;
      await Promise.resolve();
    });
    expect(invokeNative).not.toHaveBeenCalledWith('setAgentHaloMode', { mode: 'active' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hides immediately for owner end_session and cancels the idle timer', async () => {
    const view = renderHook(() => useAgentHalo());
    await emit(cuaToolResult());
    invokeNative.mockClear();

    await emit(cuaToolResult({ toolName: 'end_session' }));
    expect(invokeNative.mock.calls).toEqual([['hideAgentHalo']]);
    expect(vi.getTimerCount()).toBe(0);

    await advance(3_000);
    expect(invokeNative.mock.calls).toEqual([['hideAgentHalo']]);
    view.unmount();
  });

  it('keeps owner visibility for warnings and hides for terminal errors', async () => {
    const view = renderHook(() => useAgentHalo());
    await emit(cuaToolResult());
    invokeNative.mockClear();

    await emit({
      type: 'error',
      sessionId: 'session-owner',
      data: { message: 'retrying', level: 'warning' },
    });
    expect(invokeNative).not.toHaveBeenCalled();

    await emit({
      type: 'error',
      sessionId: 'session-owner',
      data: { message: 'run failed', code: 'RUN_FAILED' },
    });
    expect(invokeNative.mock.calls).toEqual([['hideAgentHalo']]);
    view.unmount();
  });

  it.each(['agentPointerEvent', 'browserComputerProof'] as const)(
    'keeps the legacy %s ToolResult metadata path compatible',
    async (legacyPath) => {
      const view = renderHook(() => useAgentHalo());

      await emit(cuaToolResult({ legacyPath }));

      expect(invokeNative.mock.calls.map(([action]) => action)).toEqual([
        'showAgentHalo',
        'setAgentHaloMode',
      ]);
      view.unmount();
    },
  );
});
