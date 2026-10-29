// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../src/shared/contract/surfaceExecution';
import type { SurfaceConversationSnapshotV1, SurfaceSessionStateV1 } from '../../../src/shared/contract/surfaceExecution';
import type { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';
import type { LiveAgentPointerState } from '../../../src/renderer/hooks/useLiveAgentPointer';
import type { SurfaceLiveFrameStreamState } from '../../../src/renderer/hooks/useSurfaceLiveFrames';

type BrowserSessionState = ReturnType<typeof useWorkbenchBrowserSession>;

const { controlMock, openHttpLinkInRailAsync, dispatchUserBrowserInput } = vi.hoisted(() => ({
  controlMock: vi.fn<(intent: unknown) => Promise<void>>(async () => undefined),
  openHttpLinkInRailAsync: vi.fn<(input: unknown) => Promise<{
    conversationId: string;
    runId: string;
    surfaceSessionId: string;
    snapshot: { version: 1; conversationId: string; sessions: []; updatedAt: number };
  }>>(async () => ({
    conversationId: 'session-a',
    runId: 'run-a',
    surfaceSessionId: 'surface-agent',
    snapshot: { version: 1, conversationId: 'session-a', sessions: [], updatedAt: 1 },
  })),
  dispatchUserBrowserInput: vi.fn<(input: unknown) => Promise<null>>(async () => null),
}));

vi.mock('../../../src/renderer/services/surfaceExecutionController', () => ({
  executeSurfaceExecutionControl: (intent: unknown) => controlMock(intent),
}));
vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => browserSessionState,
}));
vi.mock('../../../src/renderer/hooks/useLiveAgentPointer', () => ({
  useLiveAgentPointer: () => pointerState,
}));
vi.mock('../../../src/renderer/hooks/useSurfaceLiveFrames', () => ({
  useSurfaceLiveFrames: () => liveFrameState,
}));
vi.mock('../../../src/renderer/services/userBrowserLink', () => ({
  getKeptResultPage: vi.fn(async () => ({ state: 'none', url: null, title: null })),
  adoptKeptResultPage: vi.fn(async () => { throw new Error('not kept'); }),
  openHttpLinkInRailAsync: (input: unknown) => openHttpLinkInRailAsync(input),
  closeUserBrowserLinkRun: vi.fn(async () => undefined),
  controlUserBrowserHistory: vi.fn(async () => null),
  dispatchUserBrowserInput: (input: unknown) => dispatchUserBrowserInput(input),
  setUserBrowserViewport: vi.fn(async () => null),
}));

let browserSessionState: BrowserSessionState;
let pointerState: LiveAgentPointerState;
let liveFrameState: SurfaceLiveFrameStreamState;

function buildBrowserSessionState(): BrowserSessionState {
  return {
    mode: 'managed',
    managedSession: {
      running: true,
      tabCount: 1,
      activeTab: {
        id: 'tab-1',
        url: 'https://www.baidu.com/',
        title: '百度一下',
        canGoBack: false,
        canGoForward: false,
      },
      viewport: { width: 1280, height: 720 },
    },
    computerSurface: null,
    preview: null,
    readinessItems: [],
    blocked: false,
    repairActions: [],
    busyActionKind: null,
    actionError: null,
    ownedByCurrentSession: true,
    browserSurfaceSessionId: 'surface-agent',
    browserSurfaceTitle: '百度一下',
    browserSurfaceOrigin: 'https://www.baidu.com',
    refresh: async () => undefined,
    probePermissions: async () => undefined,
    runRepairAction: async () => undefined,
  } as BrowserSessionState;
}

function seedSession(agentId: string, state: SurfaceSessionStateV1): void {
  const snapshot: SurfaceConversationSnapshotV1 = {
    version: 1,
    conversationId: 'session-a',
    sessions: [{
      version: 1,
      session: {
        version: 1,
        sessionId: 'surface-agent',
        conversationId: 'session-a',
        runId: 'run-agent',
        agentId,
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
            pause: true,
            takeover: true,
            cleanup: true,
            successorObservation: false,
          },
        },
        state,
        activeTarget: {
          kind: 'browser',
          browserInstanceId: 'browser-1',
          windowRef: 'win-1',
          tabRef: 'tab-1',
          documentRevision: 'rev-1',
          origin: 'https://www.baidu.com',
          title: '百度一下',
        },
        startedAt: 1_000,
        heartbeatAt: 2_000,
      },
      grant: { state: 'none', capabilities: [], actionClasses: [], dataScopes: [] },
      events: [],
      evidence: [],
      outputs: [],
      availableControls: state === 'waiting_human' ? ['resume', 'stop'] : ['takeover', 'stop'],
      source: 'live',
      writable: true,
      updatedAt: 2_000,
    }],
    updatedAt: 2_000,
  };
  useSurfaceExecutionStore.getState().setNativeSnapshot('session-a', snapshot);
}

function stageRect(stage: HTMLElement): void {
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
    width: 640,
    height: 360,
    top: 0,
    left: 0,
    right: 640,
    bottom: 360,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

describe('Browser live view human takeover', () => {
  beforeEach(() => {
    controlMock.mockReset().mockResolvedValue(undefined);
    openHttpLinkInRailAsync.mockClear();
    dispatchUserBrowserInput.mockReset().mockResolvedValue(null);
    useAppStore.setState({
      language: 'zh',
      activeWorkbenchTab: 'browser',
      workbenchCollapsed: false,
      workingDirectory: '/tmp/workspace-a',
    });
    useSessionStore.setState({ currentSessionId: 'session-a' });
    useSurfaceExecutionStore.setState({
      nativeByConversation: {},
      compatibilityByConversation: {},
      sessionsByScope: {},
      frameByScope: {},
      evidenceByScope: {},
      controlByScope: {},
    });
    pointerState = { event: null, lastEvent: null, isLive: false, timeline: [] };
    liveFrameState = {
      frame: {
        version: 1,
        conversationId: 'session-a',
        surfaceSessionId: 'surface-agent',
        mimeType: 'image/jpeg',
        dataUrl: 'data:image/jpeg;base64,abc',
        width: 1280,
        height: 720,
        capturedAtMs: Date.now(),
      },
      streaming: true,
      unavailableReason: null,
    };
    browserSessionState = buildBrowserSessionState();
  });

  afterEach(() => cleanup());

  it('shows the continue bar only while the agent session is waiting_human and resume is called', async () => {
    seedSession('agent-a', 'running');
    const view = render(<BrowserAgentWindow />);
    expect(screen.queryByTestId('browser-human-takeover-bar')).toBeNull();

    seedSession('agent-a', 'waiting_human');
    view.rerender(<BrowserAgentWindow />);
    expect(screen.getByTestId('browser-human-takeover-bar')).toBeTruthy();
    expect(screen.getByText('你正在操作这个页面，Neo 已暂停')).toBeTruthy();

    fireEvent.click(screen.getByTestId('browser-human-takeover-continue'));
    await waitFor(() => expect(controlMock).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'session-a',
      surfaceSessionId: 'surface-agent',
      action: 'resume',
    }));

    seedSession('agent-a', 'running');
    view.rerender(<BrowserAgentWindow />);
    expect(screen.queryByTestId('browser-human-takeover-bar')).toBeNull();
  });

  it('does not show the bar for a page the user opened', () => {
    seedSession(SURFACE_USER_BROWSER_AGENT_ID, 'waiting_human');
    render(<BrowserAgentWindow />);
    expect(screen.queryByTestId('browser-human-takeover-bar')).toBeNull();
  });

  it('address-bar confirm calls takeover before navigation', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    controlMock.mockImplementation((intent: unknown) => new Promise<void>((resolve) => {
      order.push(String((intent as { action?: string }).action));
      release = resolve;
    }));
    openHttpLinkInRailAsync.mockImplementation(async () => {
      order.push('navigate');
      return {
        conversationId: 'session-a',
        runId: 'run-a',
        surfaceSessionId: 'surface-agent',
        snapshot: { version: 1 as const, conversationId: 'session-a', sessions: [], updatedAt: 1 },
      };
    });
    seedSession('agent-a', 'running');
    render(<BrowserAgentWindow />);
    const input = screen.getByTestId('browser-agent-window-address-input');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByText('中断并打开'));

    await waitFor(() => expect(order).toEqual(['takeover']));
    expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();
    await actRelease(release);
    await waitFor(() => expect(order).toEqual(['takeover', 'navigate']));
  });

  it('stage confirm calls takeover before the click is dispatched', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    controlMock.mockImplementation((intent: unknown) => new Promise<void>((resolve) => {
      order.push(String((intent as { action?: string }).action));
      release = resolve;
    }));
    dispatchUserBrowserInput.mockImplementation(async () => {
      order.push('dispatch');
      return null;
    });
    seedSession('agent-a', 'running');
    render(<BrowserAgentWindow />);
    const stage = screen.getByTestId('browser-agent-window-stage');
    stageRect(stage);
    fireEvent.click(stage, { clientX: 100, clientY: 100, button: 0, detail: 1 });
    fireEvent.click(screen.getByText('中断并操作'));

    await waitFor(() => expect(order).toEqual(['takeover']));
    expect(dispatchUserBrowserInput).not.toHaveBeenCalled();
    await actRelease(release);
    await waitFor(() => expect(order).toEqual(['takeover', 'dispatch']));
  });

  it('keeps clicks on the takeover bar off the live page and keeps Continue working', async () => {
    seedSession('agent-a', 'running');
    const view = render(<BrowserAgentWindow />);
    const stage = screen.getByTestId('browser-agent-window-stage');
    stageRect(stage);
    // 真实用户序列：点画面 → 确认「中断并操作」（此后透传门开）→ 会话 waiting_human → 条出现
    fireEvent.click(stage, { clientX: 100, clientY: 100, button: 0, detail: 1 });
    fireEvent.click(screen.getByText('中断并操作'));
    await waitFor(() => expect(dispatchUserBrowserInput).toHaveBeenCalledTimes(1));

    dispatchUserBrowserInput.mockClear();
    controlMock.mockClear();
    seedSession('agent-a', 'waiting_human');
    view.rerender(<BrowserAgentWindow />);
    const bar = screen.getByTestId('browser-human-takeover-bar');
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(bar, { button: 0, pointerId: 1 });
    fireEvent.click(bar, { detail: 1 });
    await actRelease(() => undefined);
    // 条上的指针/点击不透传成页面点击，也不弹中断确认
    expect(dispatchUserBrowserInput).not.toHaveBeenCalled();
    expect(screen.queryByText('中断当前浏览任务？')).toBeNull();

    // 继续按钮自身仍走 resume；它冒泡出去的 click 同样不透传
    fireEvent.click(screen.getByTestId('browser-human-takeover-continue'));
    await waitFor(() => expect(controlMock).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'session-a',
      surfaceSessionId: 'surface-agent',
      action: 'resume',
    }));
    expect(dispatchUserBrowserInput).not.toHaveBeenCalled();
  });
});

async function actRelease(release: () => void): Promise<void> {
  release();
  await Promise.resolve();
}
