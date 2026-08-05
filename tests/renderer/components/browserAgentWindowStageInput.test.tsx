// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import type { SurfaceConversationSnapshotV1 } from '../../../src/shared/contract/surfaceExecution';
import type { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';
import type { LiveAgentPointerState } from '../../../src/renderer/hooks/useLiveAgentPointer';
import type { SurfaceLiveFrameStreamState } from '../../../src/renderer/hooks/useSurfaceLiveFrames';

type BrowserSessionState = ReturnType<typeof useWorkbenchBrowserSession>;

const openHttpLinkInRailAsync = vi.fn(async (_input: unknown) => ({
  conversationId: 'session-a',
  runId: 'run-a',
  surfaceSessionId: 'surface-user',
  snapshot: { version: 1 as const, conversationId: 'session-a', sessions: [], updatedAt: 1 },
}));
const closeUserBrowserLinkRun = vi.fn(async (..._args: unknown[]) => undefined);
const controlUserBrowserHistory = vi.fn(async (..._args: unknown[]) => null);
const dispatchUserBrowserInput = vi.fn(async (_input: unknown) => null);
const setUserBrowserViewport = vi.fn(async (_input: unknown) => null);

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
vi.mock('../../../src/renderer/services/userBrowserLink', () => ({
  openHttpLinkInRailAsync: (input: unknown) => openHttpLinkInRailAsync(input),
  closeUserBrowserLinkRun: (...args: unknown[]) => closeUserBrowserLinkRun(...args),
  controlUserBrowserHistory: (...args: unknown[]) => controlUserBrowserHistory(...args),
  dispatchUserBrowserInput: (input: unknown) => dispatchUserBrowserInput(input),
  setUserBrowserViewport: (input: unknown) => setUserBrowserViewport(input),
}));

function buildBrowserSessionState(overrides: Partial<BrowserSessionState> = {}): BrowserSessionState {
  return {
    mode: 'managed',
    managedSession: {
      running: true,
      tabCount: 1,
      activeTab: {
        id: 'tab-1',
        url: 'https://www.baidu.com/',
        title: '百度一下',
        canGoBack: true,
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
    browserSurfaceSessionId: 'surface-user',
    browserSurfaceTitle: '百度一下',
    browserSurfaceOrigin: 'https://www.baidu.com',
    refresh: async () => undefined,
    probePermissions: async () => undefined,
    runRepairAction: async () => undefined,
    ...overrides,
  } as BrowserSessionState;
}

/** 种一条活跃 agent browser surface（与地址栏抢占测试同源）。 */
function seedActiveAgentSession(agentId: string): void {
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
            pause: false,
            takeover: true,
            cleanup: true,
            successorObservation: false,
          },
        },
        state: 'running',
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
      availableControls: [],
      source: 'live',
      writable: true,
      updatedAt: 2_000,
    }],
    updatedAt: 2_000,
  };
  useSurfaceExecutionStore.getState().setNativeSnapshot('session-a', snapshot);
}

describe('BrowserAgentWindow 画面交互透传（P1）', () => {
  beforeEach(() => {
    dispatchUserBrowserInput.mockClear();
    openHttpLinkInRailAsync.mockClear();
    setUserBrowserViewport.mockClear();
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
        surfaceSessionId: 'surface-user',
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

  it('用户空闲时点击画面会 dispatch click', async () => {
    render(<BrowserAgentWindow />);
    const stage = screen.getByTestId('browser-agent-window-stage');
    // mock 布局尺寸：jsdom getBoundingClientRect 默认 0
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
    fireEvent.click(stage, { clientX: 320, clientY: 180 });
    await waitFor(() => expect(dispatchUserBrowserInput).toHaveBeenCalled());
    const payload = dispatchUserBrowserInput.mock.calls[0][0] as {
      conversationId: string;
      input: { kind: string; x: number; y: number };
    };
    expect(payload.conversationId).toBe('session-a');
    expect(payload.input.kind).toBe('click');
    expect(payload.input.x).toBeCloseTo(640);
    expect(payload.input.y).toBeCloseTo(360);
  });

  // R2 真机：快速对话 workingDirectory=null，open 能导航但 client 曾因 workspace 必填
  // 静默丢 click。本 case 若再要求 workspace 非空会立刻红。
  it('快速对话无 workingDirectory 时点击仍会 dispatch', async () => {
    useAppStore.setState({ workingDirectory: null });
    render(<BrowserAgentWindow />);
    const stage = screen.getByTestId('browser-agent-window-stage');
    expect(stage.getAttribute('role')).toBe('application');
    // R4 F4：可交互态用 default 箭头，不再用 crosshair（用户读成「加号」）
    expect(stage.className).toContain('cursor-default');
    expect(stage.className).not.toContain('cursor-crosshair');
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
    fireEvent.click(stage, { clientX: 320, clientY: 180 });
    await waitFor(() => expect(dispatchUserBrowserInput).toHaveBeenCalled());
    const payload = dispatchUserBrowserInput.mock.calls[0][0] as {
      conversationId: string;
      workspace: string | null | undefined;
      input: { kind: string };
    };
    expect(payload.conversationId).toBe('session-a');
    expect(payload.input.kind).toBe('click');
  });

  it('外会话不透传', async () => {
    browserSessionState = buildBrowserSessionState({ ownedByCurrentSession: false });
    render(<BrowserAgentWindow />);
    const stage = screen.getByTestId('browser-agent-window-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.click(stage, { clientX: 100, clientY: 100 });
    await new Promise((r) => setTimeout(r, 30));
    expect(dispatchUserBrowserInput).not.toHaveBeenCalled();
  });

  it('agent 忙时首次交互弹抢占确认，确认后才透传', async () => {
    seedActiveAgentSession('agent-a');
    browserSessionState = buildBrowserSessionState({
      browserSurfaceSessionId: 'surface-agent',
    });

    render(<BrowserAgentWindow />);
    // 确认 agent 忙门控已生效（与地址栏同一投影源）
    expect(
      useSurfaceExecutionStore.getState().sessionsByScope,
    ).not.toEqual({});

    const stage = screen.getByTestId('browser-agent-window-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.click(stage, { clientX: 100, clientY: 100, button: 0, detail: 1 });

    // 未确认前不得透传
    expect(dispatchUserBrowserInput).not.toHaveBeenCalled();
    expect(screen.getByText('中断当前浏览任务？')).toBeTruthy();

    fireEvent.click(screen.getByText('中断并操作'));
    await waitFor(() => expect(dispatchUserBrowserInput).toHaveBeenCalled());
  });

  // R4 F3：pointer 拖过阈值应 dispatch drag，且帧 img 禁原生拖图
  it('拖拽超过阈值时 dispatch drag，且 live frame 禁止 draggable', async () => {
    render(<BrowserAgentWindow />);
    const stage = screen.getByTestId('browser-agent-window-stage');
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
    const frame = screen.getByTestId('browser-agent-window-frame');
    expect(frame.getAttribute('draggable')).toBe('false');

    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
      });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      fireEvent(stage, event);
    };
    pointer('pointerdown', 100, 180);
    pointer('pointermove', 220, 180);
    pointer('pointerup', 220, 180);

    await waitFor(() => expect(dispatchUserBrowserInput).toHaveBeenCalled());
    const payload = dispatchUserBrowserInput.mock.calls[0]![0] as {
      input: { kind: string; fromX: number; toX: number };
    };
    expect(payload.input.kind).toBe('drag');
    expect(Number.isFinite(payload.input.fromX)).toBe(true);
    expect(payload.input.toX).toBeGreaterThan(payload.input.fromX);
  });
});
