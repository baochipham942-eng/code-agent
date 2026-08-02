// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import { surfaceExecutionScopeKeyV1 } from '../../../src/renderer/utils/surfaceExecutionProjection';
import type { SurfaceExecutionScopeV1 } from '../../../src/renderer/utils/surfaceExecutionProjection';
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

const FRAME_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

const TERMINAL_SCOPE: SurfaceExecutionScopeV1 = {
  conversationId: 'session-a',
  runId: 'run-a',
  agentId: 'agent-a',
  surfaceSessionId: 'surface-1',
};

function buildBrowserSessionState(overrides: Partial<BrowserSessionState> = {}): BrowserSessionState {
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
    ...overrides,
  } as BrowserSessionState;
}

/** 种一条终态 browser surface 会话投影（startedAt 1000 / updatedAt 61000 → 用时 1 分钟） */
function seedTerminalSession(options: { state?: 'completed' | 'failed'; withFrame?: boolean } = {}): void {
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
        state: options.state ?? 'completed',
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
  if (options.withFrame) {
    useSurfaceExecutionStore.getState().setFrameState(TERMINAL_SCOPE, {
      status: 'stale',
      dataUrl: FRAME_DATA_URL,
    });
  }
}

describe('BrowserAgentWindow 终态留影', () => {
  beforeEach(() => {
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

  it('终态有留影帧：置灰最后一帧 +「已结束」角标，chrome 条 title/origin + 灰点，不再是空态谎言', () => {
    seedTerminalSession({ withFrame: true });
    render(<BrowserAgentWindow />);

    const frame = screen.getByTestId('browser-agent-window-terminal-frame') as HTMLImageElement;
    expect(frame.getAttribute('src')).toBe(FRAME_DATA_URL);
    expect(frame.className).toContain('grayscale');
    expect(screen.getByTestId('browser-agent-window-ended-badge').textContent).toBe('已结束');
    // 不再出现「还没有打开页面」，也不落常规空态
    expect(screen.queryByText('还没有打开页面')).toBeNull();
    expect(screen.queryByTestId('browser-agent-window-empty')).toBeNull();
    expect(screen.queryByTestId('browser-agent-window-terminal-summary')).toBeNull();

    // chrome 条：title/origin 恢复显示，状态点是灰的（灰点是对的，别改绿）
    const chrome = screen.getByTestId('browser-agent-window-chrome');
    expect(chrome.textContent).toContain('Example Domain');
    expect(chrome.textContent).toContain('https://example.com');
    const dot = screen.getByTestId('browser-agent-window-status-dot');
    expect(dot.getAttribute('title')).toBe('未启动');
    expect(dot.className).toContain('bg-zinc-600');
  });

  it('终态无留影帧（reload 后）：摘要卡兜底——标题 / origin / 用时 / 状态角标', () => {
    seedTerminalSession();
    render(<BrowserAgentWindow />);

    const summary = screen.getByTestId('browser-agent-window-terminal-summary');
    expect(summary.textContent).toContain('Example Domain');
    expect(summary.textContent).toContain('https://example.com');
    expect(summary.textContent).toContain('用时 1 分钟');
    expect(summary.textContent).toContain('已结束');
    expect(summary.textContent).toContain('已完成');
    expect(screen.queryByText('还没有打开页面')).toBeNull();
    expect(screen.queryByTestId('browser-agent-window-terminal-frame')).toBeNull();
  });

  it('failed 终态的摘要卡：状态角标走 state 表（执行失败）', () => {
    seedTerminalSession({ state: 'failed' });
    render(<BrowserAgentWindow />);

    const summary = screen.getByTestId('browser-agent-window-terminal-summary');
    expect(summary.textContent).toContain('执行失败');
  });

  it('scope 键隔离：切到无 surface 的会话，不显示别人会话的留影/摘要卡', () => {
    seedTerminalSession({ withFrame: true });
    useSessionStore.setState({ currentSessionId: 'session-b' });
    render(<BrowserAgentWindow />);

    expect(screen.queryByTestId('browser-agent-window-terminal-frame')).toBeNull();
    expect(screen.queryByTestId('browser-agent-window-terminal-summary')).toBeNull();
    // 这个会话确实没开过页面，空态在这里是诚实的
    expect(screen.getByTestId('browser-agent-window-empty')).toBeTruthy();
  });

  it('scope 键隔离：本会话终态无帧时，不拿别的 scope 键下的 dataUrl 充数', () => {
    seedTerminalSession();
    // 另一个会话的 scope 上挂着留影帧——跟本会话的 surface-1 不是同一个键
    useSurfaceExecutionStore.getState().setFrameState(
      {
        conversationId: 'session-b',
        runId: 'run-b',
        agentId: 'agent-b',
        surfaceSessionId: 'surface-1',
      },
      { status: 'stale', dataUrl: FRAME_DATA_URL },
    );
    render(<BrowserAgentWindow />);

    expect(screen.queryByTestId('browser-agent-window-terminal-frame')).toBeNull();
    expect(screen.getByTestId('browser-agent-window-terminal-summary')).toBeTruthy();
    // 别人的帧确实还在 store 里（只是不许显示在这）
    const foreignKey = surfaceExecutionScopeKeyV1({
      conversationId: 'session-b',
      runId: 'run-b',
      agentId: 'agent-b',
      surfaceSessionId: 'surface-1',
    });
    expect(useSurfaceExecutionStore.getState().frameByScope[foreignKey]?.dataUrl).toBe(FRAME_DATA_URL);
  });
});
