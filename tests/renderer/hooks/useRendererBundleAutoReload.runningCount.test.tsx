// @vitest-environment jsdom
// ============================================================================
// useRendererBundleAutoReload 的后台行计数契约（N-BGPANEL-STOP-TERMINAL）
// ============================================================================
// 终态行（完成/失败/停止）现在常驻面板直到用户清除——它们不该挡住 renderer 热更新
// 的自动重载：重载不打断任何东西，反而让用户尽早拿到带新面板的 bundle。这里钉
// backgroundSessionCount 只数 status === 'running' 行。

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RendererBundleStatus } from '@shared/contract';

const invokeDomainSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: invokeDomainSpy },
}));

import { useRendererBundleAutoReload } from '../../../src/renderer/hooks/useRendererBundleAutoReload';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import type { BackgroundSessionInfo } from '@shared/contract/sessionState';

const PENDING_STATUS: RendererBundleStatus = {
  schemaVersion: 1,
  activeBundle: { version: 'v-next', contentHash: 'hash-next' },
  lastAttempt: null,
};

function task(sessionId: string, status: BackgroundSessionInfo['status']): BackgroundSessionInfo {
  return { sessionId, title: '长任务', startedAt: 1, backgroundedAt: 1, status };
}

const originalBundle = (window as unknown as { __CODE_AGENT_RENDERER_BUNDLE__?: unknown }).__CODE_AGENT_RENDERER_BUNDLE__;

beforeEach(() => {
  invokeDomainSpy.mockReset().mockResolvedValue(PENDING_STATUS);
  (window as unknown as { __CODE_AGENT_RENDERER_BUNDLE__?: unknown }).__CODE_AGENT_RENDERER_BUNDLE__ = {
    version: 'v-current',
    contentHash: 'hash-current',
  };
});

afterEach(() => {
  (window as unknown as { __CODE_AGENT_RENDERER_BUNDLE__?: unknown }).__CODE_AGENT_RENDERER_BUNDLE__ = originalBundle;
  useSessionStore.setState({ backgroundSessions: [] } as never);
  vi.useRealTimers();
});

function mountAutoReload(reload: () => void) {
  return renderHook(() => useRendererBundleAutoReload({
    enabled: true,
    initialDelayMs: 0,
    pollIntervalMs: 1_000_000,
    minIdleMs: 0,
    reload,
  }));
}

describe('backgroundSessionCount 只数 running 行', () => {
  it('只有终态行：待激活 bundle 也不会被挡，立即重载', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    useSessionStore.setState({
      backgroundSessions: [task('s1', 'completed'), task('s2', 'failed')],
    } as never);

    mountAutoReload(reload);
    await vi.advanceTimersByTimeAsync(0);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('有 running 行：重载被挡（终态常驻不能让热更新永远不生效）', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    useSessionStore.setState({
      backgroundSessions: [task('s1', 'running'), task('s2', 'completed')],
    } as never);

    mountAutoReload(reload);
    await vi.advanceTimersByTimeAsync(0);

    expect(reload).not.toHaveBeenCalled();
  });
});
