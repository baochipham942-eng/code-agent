// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
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
const openExternalLink = vi.fn((_href?: string) => true);

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
  dispatchUserBrowserInput: vi.fn(async () => null),
  setUserBrowserViewport: vi.fn(async () => null),
}));
vi.mock('../../../src/renderer/utils/platform', async () => {
  const actual = await vi.importActual<typeof import('../../../src/renderer/utils/platform')>(
    '../../../src/renderer/utils/platform',
  );
  return {
    ...actual,
    openExternalLink: (href: string | undefined) => openExternalLink(href),
  };
});

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

describe('BrowserAgentWindow 工具条可用态（N2）', () => {
  beforeEach(() => {
    openHttpLinkInRailAsync.mockClear();
    controlUserBrowserHistory.mockClear();
    openExternalLink.mockClear();
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
    liveFrameState = { frame: null, streaming: false, unavailableReason: null };
    browserSessionState = buildBrowserSessionState();
  });

  afterEach(() => cleanup());

  it('无页面时后退/前进/刷新置灰', () => {
    render(<BrowserAgentWindow />);
    expect((screen.getByTestId('browser-agent-window-nav-back') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('browser-agent-window-nav-forward') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('browser-agent-window-nav-reload') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('browser-agent-window-open-external') as HTMLButtonElement).disabled).toBe(true);
  });

  it('有页面但无历史时后退/前进置灰，刷新可点', async () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 1,
        activeTab: {
          id: 'tab-1',
          title: 'Example',
          url: 'https://example.com/',
          canGoBack: false,
          canGoForward: false,
        },
      },
      preview: { mode: 'managed', title: 'Example', url: 'https://example.com/' },
      browserSurfaceSessionId: 'surface-1',
      browserSurfaceTitle: 'Example',
      browserSurfaceOrigin: 'https://example.com',
    });
    render(<BrowserAgentWindow />);

    expect((screen.getByTestId('browser-agent-window-nav-back') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('browser-agent-window-nav-forward') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('browser-agent-window-nav-reload') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('browser-agent-window-nav-reload'));
    await vi.waitFor(() => expect(controlUserBrowserHistory).toHaveBeenCalledWith({
      conversationId: 'session-a',
      workspace: '/tmp/workspace-a',
      action: 'reload',
    }));
  });

  it('有历史时后退可点并调用 host history control', async () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 1,
        activeTab: {
          id: 'tab-1',
          title: 'Example',
          url: 'https://example.com/page',
          canGoBack: true,
          canGoForward: true,
        },
      },
      preview: { mode: 'managed', title: 'Example', url: 'https://example.com/page' },
      browserSurfaceSessionId: 'surface-1',
      browserSurfaceTitle: 'Example',
      browserSurfaceOrigin: 'https://example.com',
    });
    render(<BrowserAgentWindow />);

    fireEvent.click(screen.getByTestId('browser-agent-window-nav-back'));
    await vi.waitFor(() => expect(controlUserBrowserHistory).toHaveBeenCalledWith({
      conversationId: 'session-a',
      workspace: '/tmp/workspace-a',
      action: 'back',
    }));

    fireEvent.click(screen.getByTestId('browser-agent-window-open-external'));
    expect(openExternalLink).toHaveBeenCalledWith('https://example.com/page');
  });
});
