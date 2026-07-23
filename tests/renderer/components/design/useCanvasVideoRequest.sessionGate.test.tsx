// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, invokeMock, generateVideoMock } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => unknown>(),
  invokeMock: vi.fn().mockResolvedValue(undefined),
  generateVideoMock: vi.fn().mockResolvedValue({
    ok: true,
    costCny: 1.2,
    durationSec: 5,
    actualModel: 'video-model',
    nodeId: 'video-node',
  }),
}));

vi.mock('../../../../src/renderer/services/ipcService', () => {
  const on = vi.fn((channel: string, callback: (payload: unknown) => unknown) => {
    handlers.set(channel, callback);
    return () => handlers.delete(channel);
  });
  return { default: { on, invoke: invokeMock } };
});

vi.mock('../../../../src/renderer/components/design/designProposedVideoGen', () => ({
  generateVideoToCanvas: generateVideoMock,
}));

import { useCanvasVideoRequest } from '../../../../src/renderer/components/design/useCanvasVideoRequest';
import { useDesignCanvasStore } from '../../../../src/renderer/components/design/designCanvasStore';
import { useSessionStore } from '../../../../src/renderer/stores/sessionStore';
import { useWorkspaceModeStore } from '../../../../src/renderer/stores/workspaceModeStore';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';
import type { CanvasVideoRequest } from '../../../../src/shared/contract';

const SESSION_ID = 'agentic-design-session';

function makeRequest(overrides: Partial<CanvasVideoRequest> = {}): CanvasVideoRequest {
  return {
    requestId: 'video-request',
    commandId: 'video-command',
    sessionId: SESSION_ID,
    mode: 't2v',
    prompt: 'animate the approved design',
    model: 'video-model',
    durationSec: 5,
    ...overrides,
  };
}

async function fireVideoAsk(request = makeRequest()): Promise<void> {
  const handler = handlers.get(IPC_CHANNELS.CANVAS_VIDEO_ASK);
  if (!handler) throw new Error('CANVAS_VIDEO_ASK listener not registered');
  await act(async () => {
    await handler(request);
  });
}

function activateAndClaim(sessionId: string): void {
  useSessionStore.setState({ currentSessionId: sessionId });
  useDesignCanvasStore.getState().markSessionDesignActive(sessionId);
  useDesignCanvasStore.getState().claimCanvasForSession(sessionId);
}

describe('useCanvasVideoRequest per-session design gate', () => {
  beforeEach(() => {
    handlers.clear();
    invokeMock.mockClear();
    generateVideoMock.mockClear();
    useWorkspaceModeStore.setState({ workspaceMode: 'code' });
    useSessionStore.setState({ currentSessionId: null });
    useDesignCanvasStore.setState({
      ownerSessionId: null,
      designActiveSessions: new Set<string>(),
      nodes: [],
      connectors: [],
      shapes: [],
    });
  });

  afterEach(() => {
    useSessionStore.setState({ currentSessionId: null });
    useDesignCanvasStore.setState({
      ownerSessionId: null,
      designActiveSessions: new Set<string>(),
      nodes: [],
      connectors: [],
      shapes: [],
    });
  });

  it('allows the agentic path when workspaceMode stays code but the session is active and owns the canvas', async () => {
    activateAndClaim(SESSION_ID);
    renderHook(() => useCanvasVideoRequest());

    await fireVideoAsk();

    expect(useWorkspaceModeStore.getState().workspaceMode).toBe('code');
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      IPC_CHANNELS.CANVAS_VIDEO_RESPONSE,
      expect.objectContaining({ requestId: 'video-request', status: 'applied' }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      IPC_CHANNELS.CANVAS_VIDEO_RESPONSE,
      expect.objectContaining({ status: 'rejected' }),
    );
  });

  it('rejects when the canvas owner is another session', async () => {
    activateAndClaim('canvas-owner');
    useSessionStore.setState({ currentSessionId: SESSION_ID });
    useDesignCanvasStore.getState().markSessionDesignActive(SESSION_ID);
    renderHook(() => useCanvasVideoRequest());

    await fireVideoAsk();

    expect(generateVideoMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith(
      IPC_CHANNELS.CANVAS_VIDEO_RESPONSE,
      expect.objectContaining({ requestId: 'video-request', status: 'rejected' }),
    );
  });

  it('rejects when the canvas has no owner', async () => {
    useSessionStore.setState({ currentSessionId: SESSION_ID });
    useDesignCanvasStore.getState().markSessionDesignActive(SESSION_ID);
    renderHook(() => useCanvasVideoRequest());

    await fireVideoAsk();

    expect(generateVideoMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith(
      IPC_CHANNELS.CANVAS_VIDEO_RESPONSE,
      expect.objectContaining({ requestId: 'video-request', status: 'rejected' }),
    );
  });
});
