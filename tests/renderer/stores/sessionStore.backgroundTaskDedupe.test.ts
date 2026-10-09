// N-RUNINPUT-TOBACKGROUND-OPTION：后台任务面板事件机的幂等性。
// SSE 是 at-least-once（断线重连按 lastEventId 重放）——重复 added 若不去重，
// 面板同一条目出现两份（2026-10-09 无槽验证实测）。

import { describe, expect, it } from 'vitest';
import type { BackgroundSessionInfo } from '../../../src/shared/contract/sessionState';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

function makeTask(sessionId: string, overrides: Partial<BackgroundSessionInfo> = {}): BackgroundSessionInfo {
  return {
    sessionId,
    title: '长任务',
    startedAt: 1,
    backgroundedAt: 1,
    status: 'running',
    ...overrides,
  };
}

describe('updateBackgroundTask 事件幂等', () => {
  it('重复 added（SSE 重放）不重复入列', () => {
    useSessionStore.setState({ backgroundSessions: [] } as never);
    const task = makeTask('session-1');

    useSessionStore.getState().updateBackgroundTask({ type: 'added', task });
    useSessionStore.getState().updateBackgroundTask({ type: 'added', task });

    expect(useSessionStore.getState().backgroundSessions).toEqual([task]);
  });

  it('completed 后重放的 added 不把条目退回 running 态', () => {
    useSessionStore.setState({ backgroundSessions: [] } as never);
    const task = makeTask('session-1');
    const completed = makeTask('session-1', { status: 'completed', progress: 100 });

    useSessionStore.getState().updateBackgroundTask({ type: 'added', task });
    useSessionStore.getState().updateBackgroundTask({ type: 'completed', task: completed });
    // SSE 重放窗口里 added 排在 completed 前面再次到达：条目保持 completed，不重复、不回退
    useSessionStore.getState().updateBackgroundTask({ type: 'added', task });

    expect(useSessionStore.getState().backgroundSessions).toEqual([completed]);

    useSessionStore.getState().updateBackgroundTask({ type: 'removed', task: completed });
    expect(useSessionStore.getState().backgroundSessions).toEqual([]);
  });

  it('不同会话互不影响', () => {
    useSessionStore.setState({ backgroundSessions: [] } as never);

    useSessionStore.getState().updateBackgroundTask({ type: 'added', task: makeTask('session-1') });
    useSessionStore.getState().updateBackgroundTask({ type: 'added', task: makeTask('session-2') });

    expect(useSessionStore.getState().backgroundSessions.map((t) => t.sessionId)).toEqual(['session-1', 'session-2']);
  });
});
