// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceLiveFrameV1 } from '../../../src/shared/contract/surfaceExecution';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import {
  shouldStreamSurfaceFrames,
  useSurfaceLiveFrames,
} from '../../../src/renderer/hooks/useSurfaceLiveFrames';

const startSurfaceLiveStream = vi.fn(async (request: { surfaceSessionId: string }) => ({
  version: 1 as const,
  surfaceSessionId: request.surfaceSessionId,
  streaming: true,
}));
const stopSurfaceLiveStream = vi.fn(async (request: { surfaceSessionId: string }) => ({
  version: 1 as const,
  surfaceSessionId: request.surfaceSessionId,
  streaming: false,
}));

const channelListeners = new Map<string, (payload: unknown) => void>();

vi.mock('../../../src/renderer/services/surfaceExecutionClient', () => ({
  startSurfaceLiveStream: (request: { surfaceSessionId: string }) => startSurfaceLiveStream(request),
  stopSurfaceLiveStream: (request: { surfaceSessionId: string }) => stopSurfaceLiveStream(request),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (channel: string, listener: (payload: unknown) => void) => {
      channelListeners.set(channel, listener);
      return () => channelListeners.delete(channel);
    },
  },
}));

function buildFrame(overrides: Partial<SurfaceLiveFrameV1> = {}): SurfaceLiveFrameV1 {
  return {
    version: 1,
    conversationId: 'session-a',
    surfaceSessionId: 'surface-1',
    mimeType: 'image/jpeg',
    dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    width: 960,
    height: 600,
    capturedAtMs: 1,
    ...overrides,
  };
}

const READY = {
  conversationId: 'session-a',
  surfaceSessionId: 'surface-1',
  visible: true,
  sessionRunning: true,
};

describe('shouldStreamSurfaceFrames 节流护栏', () => {
  it('四条都成立才开流', () => {
    expect(shouldStreamSurfaceFrames(READY)).toBe(true);
  });

  it('tab 不可见时不开流——后台无人看不许持续截帧', () => {
    expect(shouldStreamSurfaceFrames({ ...READY, visible: false })).toBe(false);
  });

  it('会话不在跑时不开流', () => {
    expect(shouldStreamSurfaceFrames({ ...READY, sessionRunning: false })).toBe(false);
  });

  it('没有 surface 会话或会话归属不全时不开流', () => {
    expect(shouldStreamSurfaceFrames({ ...READY, surfaceSessionId: null })).toBe(false);
    expect(shouldStreamSurfaceFrames({ ...READY, conversationId: null })).toBe(false);
  });
});

describe('useSurfaceLiveFrames', () => {
  beforeEach(() => {
    startSurfaceLiveStream.mockClear();
    stopSurfaceLiveStream.mockClear();
    channelListeners.clear();
  });

  afterEach(() => cleanup());

  it('无流空态：护栏不通过时既不请求开流也不订阅帧', () => {
    const { result } = renderHook(() => useSurfaceLiveFrames({ ...READY, visible: false }));

    expect(startSurfaceLiveStream).not.toHaveBeenCalled();
    expect(channelListeners.has(IPC_CHANNELS.SURFACE_LIVE_FRAME)).toBe(false);
    expect(result.current.frame).toBeNull();
    expect(result.current.streaming).toBe(false);
  });

  it('有帧：开流后推来的帧进 state', async () => {
    const { result } = renderHook(() => useSurfaceLiveFrames(READY));

    await waitFor(() => expect(startSurfaceLiveStream).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'session-a',
      surfaceSessionId: 'surface-1',
    }));
    await waitFor(() => expect(result.current.streaming).toBe(true));

    channelListeners.get(IPC_CHANNELS.SURFACE_LIVE_FRAME)?.(buildFrame());
    await waitFor(() => expect(result.current.frame?.width).toBe(960));
  });

  it('别的会话 / 别的 surface 会话的帧一律丢弃，不串现场', async () => {
    const { result } = renderHook(() => useSurfaceLiveFrames(READY));
    await waitFor(() => expect(result.current.streaming).toBe(true));
    const push = channelListeners.get(IPC_CHANNELS.SURFACE_LIVE_FRAME);

    push?.(buildFrame({ surfaceSessionId: 'surface-other' }));
    push?.(buildFrame({ conversationId: 'session-b' }));
    push?.({ version: 1, surfaceSessionId: 'surface-1' });
    expect(result.current.frame).toBeNull();
  });

  it('tab 切走后停流：请求 stop、退订、清掉上一帧', async () => {
    const { rerender, result } = renderHook(
      (input: Parameters<typeof useSurfaceLiveFrames>[0]) => useSurfaceLiveFrames(input),
      { initialProps: READY },
    );
    await waitFor(() => expect(result.current.streaming).toBe(true));
    channelListeners.get(IPC_CHANNELS.SURFACE_LIVE_FRAME)?.(buildFrame());
    await waitFor(() => expect(result.current.frame).not.toBeNull());

    rerender({ ...READY, visible: false });

    await waitFor(() => expect(stopSurfaceLiveStream).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'session-a',
      surfaceSessionId: 'surface-1',
    }));
    expect(channelListeners.has(IPC_CHANNELS.SURFACE_LIVE_FRAME)).toBe(false);
    expect(result.current.frame).toBeNull();
    expect(result.current.streaming).toBe(false);
  });

  it('卸载时也停流，不留后台跑着的帧流', async () => {
    const { result, unmount } = renderHook(() => useSurfaceLiveFrames(READY));
    await waitFor(() => expect(result.current.streaming).toBe(true));

    unmount();
    await waitFor(() => expect(stopSurfaceLiveStream).toHaveBeenCalledTimes(1));
  });

  it('host 拒绝开流时给出原因，供 UI 落降级文案', async () => {
    startSurfaceLiveStream.mockResolvedValueOnce({
      version: 1,
      surfaceSessionId: 'surface-1',
      streaming: false,
      reason: 'no_active_page',
    } as never);
    const { result } = renderHook(() => useSurfaceLiveFrames(READY));

    await waitFor(() => expect(result.current.unavailableReason).toBe('no_active_page'));
    expect(result.current.streaming).toBe(false);
  });
});
