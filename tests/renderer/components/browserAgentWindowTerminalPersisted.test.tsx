// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import { surfaceExecutionScopeKeyV1 } from '../../../src/renderer/utils/surfaceExecutionProjection';
import type { SurfaceConversationSnapshotV1 } from '../../../src/shared/contract/surfaceExecution';
import type { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';
import type { LiveAgentPointerState } from '../../../src/renderer/hooks/useLiveAgentPointer';
import type { SurfaceLiveFrameStreamState } from '../../../src/renderer/hooks/useSurfaceLiveFrames';

type BrowserSessionState = ReturnType<typeof useWorkbenchBrowserSession>;

let browserSessionState: BrowserSessionState;
let pointerState: LiveAgentPointerState;
let liveFrameState: SurfaceLiveFrameStreamState;

vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => browserSessionState,
}));
vi.mock('../../../src/renderer/hooks/useLiveAgentPointer', () => ({
  useLiveAgentPointer: () => pointerState,
}));
vi.mock('../../../src/renderer/hooks/useSurfaceLiveFrames', () => ({
  useSurfaceLiveFrames: () => liveFrameState,
}));

const mocks = vi.hoisted(() => ({
  getPersistedSurfaceTerminalFrame: vi.fn(),
}));

vi.mock('../../../src/renderer/services/surfaceExecutionClient', () => ({
  getPersistedSurfaceTerminalFrame: mocks.getPersistedSurfaceTerminalFrame,
  deletePersistedSurfaceTerminalFrames: vi.fn(),
}));

const DISK_FRAME_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function buildBrowserSessionState(): BrowserSessionState {
  return {
    mode: 'managed',
    managedSession: { running: false, tabCount: 0, activeTab: null },
    computerSurface: null,
    preview: null,
    readinessItems: [],
    blocked: false,
    repairActions: [],
    busyActionKind: null,
    actionError: null,
    ownedByCurrentSession: true,
    browserSurfaceSessionId: null,
    browserSurfaceTitle: null,
    browserSurfaceOrigin: null,
    refresh: async () => undefined,
    probePermissions: async () => undefined,
    runRepairAction: async () => undefined,
  } as BrowserSessionState;
}

/** 种一条终态 browser surface 会话投影（不带内存留影帧，模拟重启后的状态） */
function seedTerminalSessionWithoutFrame(): void {
  const snapshot: SurfaceConversationSnapshotV1 = {
    version: 1,
    conversationId: 'session-a',
    sessions: [{
      version: 1,
      session: {
        version: 1,
        sessionId: 'surface-1',
        conversationId: 'session-a',
        runId: 'run-a',
        agentId: 'agent-a',
        surface: 'browser',
        provider: 'managed',
        capabilities: {
          version: 1,
          surface: 'browser',
          provider: 'managed',
          protocolVersion: '2',
          operations: ['observe'],
          observationKinds: ['screenshot'],
          supports: {
            cancel: true,
            pause: false,
            takeover: true,
            cleanup: true,
            successorObservation: false,
          },
        },
        state: 'completed',
        activeTarget: {
          kind: 'browser',
          browserInstanceId: 'browser-1',
          windowRef: 'win-1',
          tabRef: 'tab-1',
          documentRevision: 'rev-1',
          origin: 'https://example.com',
          title: 'Example Domain',
        },
        startedAt: 1_000,
        heartbeatAt: 61_000,
      },
      grant: { state: 'none', capabilities: [], actionClasses: [], dataScopes: [] },
      events: [],
      evidence: [],
      outputs: [],
      availableControls: [],
      source: 'persisted',
      writable: false,
      updatedAt: 61_000,
    }],
    updatedAt: 61_000,
  };
  useSurfaceExecutionStore.getState().setNativeSnapshot('session-a', snapshot);
}

describe('BrowserAgentWindow 终态留影：重启后从盘上读回', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      language: 'zh',
      showLocalOpsPanel: false,
      localOpsTab: 'desktop',
      activeWorkbenchTab: 'browser',
      workbenchCollapsed: false,
    });
    useSessionStore.setState({ currentSessionId: 'session-a' });
    useSurfaceExecutionStore.getState().reset();
    pointerState = { event: null, lastEvent: null, isLive: false, timeline: [] };
    liveFrameState = { frame: null, streaming: false, unavailableReason: null };
    browserSessionState = buildBrowserSessionState();
  });

  afterEach(() => cleanup());

  it('frameByScope 空 + 盘上有帧：读回后渲染留影而非摘要卡，帧写回 store 标 stale', async () => {
    seedTerminalSessionWithoutFrame();
    mocks.getPersistedSurfaceTerminalFrame.mockResolvedValue({
      version: 1,
      frame: { dataUrl: DISK_FRAME_DATA_URL, bytes: 1234 },
    });
    render(<BrowserAgentWindow />);

    const frame = await screen.findByTestId('browser-agent-window-terminal-frame') as HTMLImageElement;
    expect(frame.getAttribute('src')).toBe(DISK_FRAME_DATA_URL);
    expect(screen.queryByTestId('browser-agent-window-terminal-summary')).toBeNull();

    // 读回的帧已按原 scope 键写回 store（后续渲染不再依赖 IPC）
    expect(mocks.getPersistedSurfaceTerminalFrame).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'session-a',
      surfaceSessionId: 'surface-1',
    });
    const scopeKey = surfaceExecutionScopeKeyV1({
      conversationId: 'session-a',
      runId: 'run-a',
      agentId: 'agent-a',
      surfaceSessionId: 'surface-1',
    });
    const frameState = useSurfaceExecutionStore.getState().frameByScope[scopeKey];
    expect(frameState?.status).toBe('stale');
    expect(frameState?.dataUrl).toBe(DISK_FRAME_DATA_URL);
  });

  it('盘上也没帧：留在摘要卡兜底，不报错，且同一 scope 不重复请求', async () => {
    seedTerminalSessionWithoutFrame();
    mocks.getPersistedSurfaceTerminalFrame.mockResolvedValue({ version: 1, frame: null });
    const { rerender } = render(<BrowserAgentWindow />);

    await waitFor(() => {
      expect(mocks.getPersistedSurfaceTerminalFrame).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('browser-agent-window-terminal-summary')).toBeTruthy();
    expect(screen.queryByTestId('browser-agent-window-terminal-frame')).toBeNull();

    rerender(<BrowserAgentWindow />);
    await waitFor(() => {
      expect(screen.getByTestId('browser-agent-window-terminal-summary')).toBeTruthy();
    });
    expect(mocks.getPersistedSurfaceTerminalFrame).toHaveBeenCalledTimes(1);
  });

  it('读回请求失败（IPC 抛错）：留在摘要卡，不崩', async () => {
    seedTerminalSessionWithoutFrame();
    mocks.getPersistedSurfaceTerminalFrame.mockRejectedValue(new Error('ipc down'));
    render(<BrowserAgentWindow />);

    await waitFor(() => {
      expect(mocks.getPersistedSurfaceTerminalFrame).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('browser-agent-window-terminal-summary')).toBeTruthy();
    expect(screen.queryByTestId('browser-agent-window-terminal-frame')).toBeNull();
  });
});
