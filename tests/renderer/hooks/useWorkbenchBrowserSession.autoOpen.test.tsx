// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RendererSurfaceSessionProjectionV1,
} from '../../../src/renderer/utils/surfaceExecutionProjection';
import { surfaceExecutionScopeKeyV1 } from '../../../src/renderer/utils/surfaceExecutionProjection';
import {
  selectActiveBrowserSurfaceSessionV1,
  useSurfaceExecutionStore,
} from '../../../src/renderer/stores/surfaceExecutionStore';
import { useManagedBrowserOwnerStore } from '../../../src/renderer/stores/managedBrowserOwnerStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';

const openSurfaceForArtifact = vi.fn();

vi.mock('../../../src/renderer/services/surfaceIntentDispatcher', () => ({
  openSurfaceForArtifact: (input: unknown) => openSurfaceForArtifact(input),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: async () => ({ running: false, tabCount: 0, activeTab: null }),
    on: () => () => undefined,
  },
}));

vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  isNativeDesktopAvailable: () => false,
  getNativeDesktopCapabilities: async () => null,
  getNativeDesktopCollectorStatus: async () => null,
  getNativeDesktopPermissionStatus: async () => null,
  getFrontmostDesktopContext: async () => null,
  getComputerSurfaceState: async () => null,
  listRecentNativeDesktopEvents: async () => [],
  openNativeDesktopSystemSettings: async () => undefined,
  startNativeDesktopCollector: async () => undefined,
}));

function buildSession(input: {
  conversationId: string;
  surfaceSessionId: string;
  surface?: 'browser' | 'computer';
  state?: string;
  updatedAt?: number;
}): RendererSurfaceSessionProjectionV1 {
  const scope = {
    conversationId: input.conversationId,
    runId: 'run-1',
    agentId: 'agent-1',
    surfaceSessionId: input.surfaceSessionId,
  };
  return {
    scope,
    session: {
      version: 1,
      sessionId: input.surfaceSessionId,
      runId: 'run-1',
      conversationId: input.conversationId,
      agentId: 'agent-1',
      surface: input.surface ?? 'browser',
      provider: 'system-chrome-cdp',
      capabilities: { version: 1, surface: input.surface ?? 'browser', entries: [] },
      state: input.state ?? 'running',
      startedAt: 1,
      heartbeatAt: 1,
    },
    updatedAt: input.updatedAt ?? 1,
  } as unknown as RendererSurfaceSessionProjectionV1;
}

function setSessions(sessions: RendererSurfaceSessionProjectionV1[]): void {
  useSurfaceExecutionStore.setState({
    sessionsByScope: Object.fromEntries(
      sessions.map((session) => [surfaceExecutionScopeKeyV1(session.scope), session]),
    ),
  });
}

describe('selectActiveBrowserSurfaceSessionV1', () => {
  it('只认本会话的 browser surface 会话', () => {
    const mine = buildSession({ conversationId: 'session-a', surfaceSessionId: 'surface-mine' });
    const theirs = buildSession({ conversationId: 'session-b', surfaceSessionId: 'surface-theirs' });
    const map = Object.fromEntries([mine, theirs]
      .map((session) => [surfaceExecutionScopeKeyV1(session.scope), session]));

    expect(selectActiveBrowserSurfaceSessionV1(map, 'session-a')?.session.sessionId)
      .toBe('surface-mine');
    expect(selectActiveBrowserSurfaceSessionV1(map, 'session-c')).toBeNull();
    expect(selectActiveBrowserSurfaceSessionV1(map, null)).toBeNull();
  });

  it('computer surface 会话不算数——拿去开浏览器帧流就选错对象了', () => {
    const computer = buildSession({
      conversationId: 'session-a',
      surfaceSessionId: 'surface-computer',
      surface: 'computer',
    });
    const map = { [surfaceExecutionScopeKeyV1(computer.scope)]: computer };

    expect(selectActiveBrowserSurfaceSessionV1(map, 'session-a')).toBeNull();
  });

  it('终态会话不返回——收工了不该继续开流', () => {
    for (const state of ['completed', 'failed']) {
      const done = buildSession({
        conversationId: 'session-a',
        surfaceSessionId: `surface-${state}`,
        state,
      });
      const map = { [surfaceExecutionScopeKeyV1(done.scope)]: done };
      expect(selectActiveBrowserSurfaceSessionV1(map, 'session-a')).toBeNull();
    }
  });

  it('多个活跃会话取最近更新的那个', () => {
    const older = buildSession({
      conversationId: 'session-a', surfaceSessionId: 'surface-old', updatedAt: 1,
    });
    const newer = buildSession({
      conversationId: 'session-a', surfaceSessionId: 'surface-new', updatedAt: 9,
    });
    const map = Object.fromEntries([older, newer]
      .map((session) => [surfaceExecutionScopeKeyV1(session.scope), session]));

    expect(selectActiveBrowserSurfaceSessionV1(map, 'session-a')?.session.sessionId)
      .toBe('surface-new');
  });
});

describe('B1-R·R2 auto-open 挂 browser surface 会话启动', () => {
  beforeEach(() => {
    openSurfaceForArtifact.mockClear();
    useManagedBrowserOwnerStore.getState().resetManagedBrowserOwnerForTests();
    useSessionStore.setState({ currentSessionId: 'session-a' });
    setSessions([]);
  });

  afterEach(() => cleanup());

  it('本会话起 browser surface 会话 → 抢焦点开浏览器现场（composer 模式仍是 none）', async () => {
    const { rerender } = renderHook(() => useWorkbenchBrowserSession());
    expect(openSurfaceForArtifact).not.toHaveBeenCalled();

    setSessions([buildSession({ conversationId: 'session-a', surfaceSessionId: 'surface-1' })]);
    rerender();

    await waitFor(() => expect(openSurfaceForArtifact).toHaveBeenCalledWith({
      artifact: { kind: 'managed-browser' },
      artifactSessionId: 'session-a',
    }));
  });

  it('同一会话反复观察只抢一次焦点', async () => {
    setSessions([buildSession({ conversationId: 'session-a', surfaceSessionId: 'surface-1' })]);
    const { rerender } = renderHook(() => useWorkbenchBrowserSession());
    await waitFor(() => expect(openSurfaceForArtifact).toHaveBeenCalledTimes(1));

    rerender();
    rerender();
    expect(openSurfaceForArtifact).toHaveBeenCalledTimes(1);
  });

  it('别的会话的 browser surface 会话不抢本会话焦点', async () => {
    setSessions([buildSession({ conversationId: 'session-b', surfaceSessionId: 'surface-1' })]);
    renderHook(() => useWorkbenchBrowserSession());

    await waitFor(() => expect(
      useSurfaceExecutionStore.getState().sessionsByScope,
    ).not.toEqual({}));
    expect(openSurfaceForArtifact).not.toHaveBeenCalled();
  });

  it('会话结束不抢焦点', async () => {
    setSessions([buildSession({ conversationId: 'session-a', surfaceSessionId: 'surface-1' })]);
    const { rerender } = renderHook(() => useWorkbenchBrowserSession());
    await waitFor(() => expect(openSurfaceForArtifact).toHaveBeenCalledTimes(1));

    setSessions([]);
    rerender();
    expect(openSurfaceForArtifact).toHaveBeenCalledTimes(1);
  });

  it('S4 升级：有本会话 surface 会话时归属直接判本会话，不再靠猜', async () => {
    setSessions([buildSession({ conversationId: 'session-a', surfaceSessionId: 'surface-1' })]);
    const { result } = renderHook(() => useWorkbenchBrowserSession());

    await waitFor(() => expect(result.current.browserSurfaceSessionId).toBe('surface-1'));
    expect(result.current.ownedByCurrentSession).toBe(true);
  });
});
