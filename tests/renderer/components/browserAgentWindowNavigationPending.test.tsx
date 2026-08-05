// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import type { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';
import type { LiveAgentPointerState } from '../../../src/renderer/hooks/useLiveAgentPointer';
import type { SurfaceLiveFrameStreamState } from '../../../src/renderer/hooks/useSurfaceLiveFrames';

type BrowserSessionState = ReturnType<typeof useWorkbenchBrowserSession>;

const openHttpLinkInRailAsync = vi.fn();
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

function typeAndEnter(value: string): void {
  const input = screen.getByTestId('browser-agent-window-address-input');
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('BrowserAgentWindow 导航 pending 三态（N1）', () => {
  beforeEach(() => {
    openHttpLinkInRailAsync.mockReset();
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

  it('pending：回车瞬间地址栏保留归一化 URL，并显示正在打开反馈；失焦不清空', async () => {
    let resolveNav!: (value: unknown) => void;
    openHttpLinkInRailAsync.mockImplementation(() => new Promise((resolve) => {
      resolveNav = resolve;
    }));

    render(<BrowserAgentWindow />);
    typeAndEnter('example.com');

    const input = screen.getByTestId('browser-agent-window-address-input') as HTMLInputElement;
    expect(input.value).toBe('https://example.com/');
    expect(screen.getByTestId('browser-agent-window-nav-pending')).toBeTruthy();
    expect(screen.getByTestId('browser-agent-window-nav-spinner')).toBeTruthy();
    expect(screen.getAllByText('正在打开…').length).toBeGreaterThanOrEqual(1);

    fireEvent.blur(input);
    expect(input.value).toBe('https://example.com/');

    await act(async () => {
      resolveNav({
        conversationId: 'session-a',
        runId: 'run-a',
        surfaceSessionId: 'surface-user',
        snapshot: { version: 1, conversationId: 'session-a', sessions: [], updatedAt: 1 },
      });
    });
  });

  it('成功：导航落地后 pending 消失，地址栏回写真实 URL', async () => {
    openHttpLinkInRailAsync.mockResolvedValue({
      conversationId: 'session-a',
      runId: 'run-a',
      surfaceSessionId: 'surface-user',
      snapshot: { version: 1, conversationId: 'session-a', sessions: [], updatedAt: 1 },
    });

    const { rerender } = render(<BrowserAgentWindow />);
    typeAndEnter('example.com');

    await vi.waitFor(() => expect(openHttpLinkInRailAsync).toHaveBeenCalled());
    expect(screen.getByTestId('browser-agent-window-nav-pending')).toBeTruthy();

    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 1,
        activeTab: { id: 'tab-1', title: 'Example Domain', url: 'https://example.com/' },
      },
      preview: { mode: 'managed', title: 'Example Domain', url: 'https://example.com/' },
      browserSurfaceSessionId: 'surface-user',
      browserSurfaceTitle: 'Example Domain',
      browserSurfaceOrigin: 'https://example.com',
    });
    rerender(<BrowserAgentWindow />);

    await vi.waitFor(() => {
      expect(screen.queryByTestId('browser-agent-window-nav-pending')).toBeNull();
    });
    const input = screen.getByTestId('browser-agent-window-address-input') as HTMLInputElement;
    expect(input.value).toContain('example.com');
  });

  it('失败：导航 reject 后显示错误，地址栏仍保留目标 URL（不清空无反馈）', async () => {
    openHttpLinkInRailAsync.mockRejectedValue(new Error('DNS failed'));

    render(<BrowserAgentWindow />);
    typeAndEnter('bad.example');

    await vi.waitFor(() => {
      expect(screen.getByText(/打开失败/)).toBeTruthy();
    });
    expect(screen.queryByTestId('browser-agent-window-nav-pending')).toBeNull();
    const input = screen.getByTestId('browser-agent-window-address-input') as HTMLInputElement;
    expect(input.value).toBe('https://bad.example/');
    expect(input.value).not.toBe('');
  });

  it('空态自动建会话：无会话回车静默新建会话并用它导航（2026-08-05 拍板）', async () => {
    useSessionStore.setState({ currentSessionId: null });
    const createSession = vi.fn().mockResolvedValue({ id: 'session-auto', workingDirectory: '/tmp/auto-work' });
    useSessionStore.setState({ createSession } as never);
    openHttpLinkInRailAsync.mockResolvedValue({ snapshot: null });

    render(<BrowserAgentWindow />);
    typeAndEnter('baidu.com');

    await vi.waitFor(() => {
      expect(createSession).toHaveBeenCalled();
      expect(openHttpLinkInRailAsync).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'session-auto', href: 'https://baidu.com/' }),
      );
    });
    expect(screen.queryByText(/Invalid browser navigation request/)).toBeNull();
  });

  it('空态建会话失败：落人话失败态而非内部英文错误', async () => {
    useSessionStore.setState({ currentSessionId: null });
    const createSession = vi.fn().mockResolvedValue(null);
    useSessionStore.setState({ createSession } as never);

    render(<BrowserAgentWindow />);
    typeAndEnter('baidu.com');

    await vi.waitFor(() => {
      expect(screen.getByText(/先新建一个会话/)).toBeTruthy();
    });
    expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();
  });
});
