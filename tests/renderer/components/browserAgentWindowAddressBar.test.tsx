// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import type { SurfaceConversationSnapshotV1 } from '../../../src/shared/contract/surfaceExecution';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../src/shared/contract/surfaceExecution';
import type { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';
import type { LiveAgentPointerState } from '../../../src/renderer/hooks/useLiveAgentPointer';
import type { SurfaceLiveFrameStreamState } from '../../../src/renderer/hooks/useSurfaceLiveFrames';

type BrowserSessionState = ReturnType<typeof useWorkbenchBrowserSession>;

const openHttpLinkInRailAsync = vi.fn(async (_input: unknown) => ({
  conversationId: 'session-a',
  runId: 'run-a',
  surfaceSessionId: 'surface-user',
  snapshot: { version: 1, conversationId: 'session-a', sessions: [], updatedAt: 1 },
}));
const closeUserBrowserLinkRun = vi.fn(async (..._args: unknown[]) => undefined);
const controlUserBrowserHistory = vi.fn(async (..._args: unknown[]) => null);

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
}));

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

/** 种一条活跃（running）browser surface 会话投影；agentId 决定归属（agent run vs 用户链接 run）。 */
function seedActiveAgentSession(agentId: string): void {
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
          origin: 'https://agent.example',
          title: 'Agent Page',
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

function typeAndEnter(value: string): void {
  const input = screen.getByTestId('browser-agent-window-address-input');
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('BrowserAgentWindow 地址栏（2026-08-04 工单）', () => {
  beforeEach(() => {
    openHttpLinkInRailAsync.mockClear();
    openHttpLinkInRailAsync.mockResolvedValue({
      conversationId: 'session-a',
      runId: 'run-a',
      surfaceSessionId: 'surface-user',
      snapshot: { version: 1, conversationId: 'session-a', sessions: [], updatedAt: 1 },
    });
    closeUserBrowserLinkRun.mockClear();
    controlUserBrowserHistory.mockClear();
    useAppStore.setState({
      language: 'zh',
      showLocalOpsPanel: false,
      localOpsTab: 'desktop',
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
    liveFrameState = { frame: null, streaming: false, unavailableReason: null };
    browserSessionState = buildBrowserSessionState();
  });

  afterEach(() => cleanup());

  it('空态下地址栏照常在：输入域名回车即补 https 并走 #926 同一条链接导航链路', async () => {
    render(<BrowserAgentWindow />);

    expect(screen.getByTestId('browser-agent-window-empty')).toBeTruthy();
    const input = screen.getByTestId('browser-agent-window-address-input') as HTMLInputElement;
    expect(input.disabled).toBe(false);

    typeAndEnter('example.com');

    await vi.waitFor(() => expect(openHttpLinkInRailAsync).toHaveBeenCalledWith({
      href: 'https://example.com/',
      conversationId: 'session-a',
      workspace: '/tmp/workspace-a',
    }));
  });

  it('明显是搜索词的输入提示无效地址，不触发导航（本单不做搜索）', () => {
    render(<BrowserAgentWindow />);

    typeAndEnter('hello world');

    expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/不是有效网址/)).toBeTruthy();
  });

  it('agent 忙（活跃 browser surface 属于 agent run）时回车先弹确认，确认前不导航', async () => {
    seedActiveAgentSession('agent-a');
    browserSessionState = buildBrowserSessionState({
      browserSurfaceSessionId: 'surface-1',
      browserSurfaceTitle: 'Agent Page',
      browserSurfaceOrigin: 'https://agent.example',
    });
    render(<BrowserAgentWindow />);

    typeAndEnter('example.com');

    expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();
    expect(screen.getByText('中断当前浏览任务？')).toBeTruthy();

    fireEvent.click(screen.getByText('中断并打开'));

    await vi.waitFor(() => expect(openHttpLinkInRailAsync).toHaveBeenCalledWith({
      href: 'https://example.com/',
      conversationId: 'session-a',
      workspace: '/tmp/workspace-a',
    }));
  });

  it('确认框取消则不导航', () => {
    seedActiveAgentSession('agent-a');
    browserSessionState = buildBrowserSessionState({
      browserSurfaceSessionId: 'surface-1',
      browserSurfaceTitle: 'Agent Page',
      browserSurfaceOrigin: 'https://agent.example',
    });
    render(<BrowserAgentWindow />);

    typeAndEnter('example.com');
    fireEvent.click(screen.getByText('取消'));

    expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();
    expect(screen.queryByText('中断当前浏览任务？')).toBeNull();
  });

  it('agent 空闲（无活跃 surface）时直接导航，不弹确认', async () => {
    render(<BrowserAgentWindow />);

    typeAndEnter('example.com');

    expect(screen.queryByText('中断当前浏览任务？')).toBeNull();
    await vi.waitFor(() => expect(openHttpLinkInRailAsync).toHaveBeenCalled());
  });

  it('活跃 surface 是用户自己开的（user-browser-link）时不弹确认，直接导航', async () => {
    seedActiveAgentSession(SURFACE_USER_BROWSER_AGENT_ID);
    browserSessionState = buildBrowserSessionState({
      browserSurfaceSessionId: 'surface-1',
      browserSurfaceTitle: 'Agent Page',
      browserSurfaceOrigin: 'https://agent.example',
    });
    render(<BrowserAgentWindow />);

    typeAndEnter('example.com');

    expect(screen.queryByText('中断当前浏览任务？')).toBeNull();
    await vi.waitFor(() => expect(openHttpLinkInRailAsync).toHaveBeenCalled());
  });

  it('地址栏实时跟随页面跳转：activeUrl 变化且未在编辑时同步（常态只显域名）', () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 1,
        activeTab: { id: 'tab-1', title: 'One', url: 'https://one.example/' },
      },
      preview: { mode: 'managed', title: 'One', url: 'https://one.example/' },
    });
    const { rerender } = render(<BrowserAgentWindow />);

    const input = screen.getByTestId('browser-agent-window-address-input') as HTMLInputElement;
    expect(input.value).toBe('one.example');

    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 1,
        activeTab: { id: 'tab-1', title: 'Two', url: 'https://two.example/' },
      },
      preview: { mode: 'managed', title: 'Two', url: 'https://two.example/' },
    });
    rerender(<BrowserAgentWindow />);

    expect(input.value).toBe('two.example');
  });

  it('编辑中不被远端 URL 覆盖；聚焦展开完整 URL；失焦回到当前页域名', () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 1,
        activeTab: { id: 'tab-1', title: 'One', url: 'https://one.example/' },
      },
      preview: { mode: 'managed', title: 'One', url: 'https://one.example/' },
    });
    const { rerender } = render(<BrowserAgentWindow />);

    const input = screen.getByTestId('browser-agent-window-address-input') as HTMLInputElement;
    fireEvent.focus(input);
    // 聚焦后展开完整 URL
    expect(input.value).toBe('https://one.example/');
    fireEvent.change(input, { target: { value: 'draft.example' } });

    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 1,
        activeTab: { id: 'tab-1', title: 'Two', url: 'https://two.example/' },
      },
      preview: { mode: 'managed', title: 'Two', url: 'https://two.example/' },
    });
    rerender(<BrowserAgentWindow />);
    expect(input.value).toBe('draft.example');

    fireEvent.blur(input);
    expect(input.value).toBe('two.example');
  });

  it('现场属于别的会话时地址栏禁用', () => {
    browserSessionState = buildBrowserSessionState({ ownedByCurrentSession: false });
    render(<BrowserAgentWindow />);

    const input = screen.getByTestId('browser-agent-window-address-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
