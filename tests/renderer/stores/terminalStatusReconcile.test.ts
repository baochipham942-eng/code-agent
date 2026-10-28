// ============================================================================
// terminalStatusReconcile.test.ts — N-WORKDETAIL-DEFAULT-SIMPLE-FU2-FU2
//
// 钉住：当前会话的终态 session:updated 广播到达、而转录区最后一条还不是有正文的
// assistant 消息（直连 run 流静默失联、终局事件没到过的形状）时，宽限期后必须走
// 一次快照重灌把 DB 真相拉回页面；健康收尾（宽限期内终局事件先到 / 广播时终稿
// 已在）零重灌。回归背景：真跑复现「答案完整落库、页面 47 分钟不上屏、reload 即现」。
// ============================================================================
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { Message, Session } from '../../../src/shared/contract';
import { createTerminalStatusReconciler } from '../../../src/renderer/stores/terminalStatusReconcile';

/** 与 terminalStatusReconcile 的宽限期同值（导出会顶 knip production 门，测试就地钉值）。 */
const TERMINAL_STATUS_RECONCILE_GRACE_MS = 3_000;

type ReconcilerDeps = Parameters<typeof createTerminalStatusReconciler>[0];

function installMockTransport(): (channel: string, event: Record<string, unknown>) => void {
  const channelListeners = new Map<string, Array<(event: never) => void>>();
  const mockOn = vi.fn((channel: string, callback: (event: never) => void) => {
    const list = channelListeners.get(channel) ?? [];
    list.push(callback);
    channelListeners.set(channel, list);
    return () => {};
  });
  (globalThis as Record<string, unknown>).window = {
    codeAgentAPI: {
      invoke: vi.fn(),
      on: mockOn,
      off: vi.fn(),
    },
  };
  return (channel, event) => {
    for (const listener of [...(channelListeners.get(channel) ?? [])]) listener(event as never);
  };
}

function makeDeps(overrides: Partial<ReconcilerDeps> = {}): ReconcilerDeps & {
  reloadSession: ReturnType<typeof vi.fn>;
  timers: Array<{ run: () => void; delayMs: number }>;
} {
  const reloadSession = vi.fn(async () => {});
  const timers: Array<{ run: () => void; delayMs: number }> = [];
  const base: ReconcilerDeps = {
    getCurrentSessionId: () => 'session-1',
    getLastMessage: () => ({ role: 'user', content: '问题' }),
    reloadSession,
    isRunActive: () => false,
    isTerminalStatus: (status) => ['completed', 'error', 'interrupted', 'orphaned', 'idle'].includes(status ?? ''),
    schedule: (run, delayMs) => { timers.push({ run, delayMs }); },
  };
  return Object.assign(base, overrides, { reloadSession, timers });
}

describe('createTerminalStatusReconciler', () => {
  it('终态广播 + 转录区无 assistant 终稿：宽限期后重灌当前会话（修复的核心不变量）', () => {
    const deps = makeDeps();
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    expect(deps.reloadSession).not.toHaveBeenCalled(); // 宽限期内先不动
    expect(deps.timers).toHaveLength(1);
    expect(deps.timers[0].delayMs).toBe(TERMINAL_STATUS_RECONCILE_GRACE_MS);

    deps.timers[0].run();
    expect(deps.reloadSession).toHaveBeenCalledTimes(1);
    expect(deps.reloadSession).toHaveBeenCalledWith('session-1');
  });

  it('健康收尾：宽限期内 assistant 终稿经 run 流到了 → 不重灌', () => {
    const deps = makeDeps();
    let last: { role: string; content: string } = { role: 'user', content: '问题' };
    deps.getLastMessage = () => last;
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    last = { role: 'assistant', content: '答案已到' };
    deps.timers[0].run();
    expect(deps.reloadSession).not.toHaveBeenCalled();
  });

  it('广播时最后一条已是 assistant 终稿 → 不排程（健康轮零开销）', () => {
    const deps = makeDeps({ getLastMessage: () => ({ role: 'assistant', content: '答案已到' }) });
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    expect(deps.timers).toHaveLength(0);
    expect(deps.reloadSession).not.toHaveBeenCalled();
  });

  it('非终态广播与他席会话的终态广播：不排程不重灌', () => {
    const deps = makeDeps();
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'running' } });
    handler({ sessionId: 'session-other', updates: { status: 'completed' } });
    expect(deps.timers).toHaveLength(0);
    expect(deps.reloadSession).not.toHaveBeenCalled();
  });

  it('宽限期内又开新轮（isRunActive=true）→ 不重灌，让新轮自己的终态再对账', () => {
    const deps = makeDeps({ isRunActive: () => true });
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    deps.timers[0].run();
    expect(deps.reloadSession).not.toHaveBeenCalled();
  });

  it('宽限期内用户切走会话 → 尾随检查不动别的会话', () => {
    let current: string | null = 'session-1';
    const deps = makeDeps({ getCurrentSessionId: () => current });
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    current = 'session-2';
    deps.timers[0].run();
    expect(deps.reloadSession).not.toHaveBeenCalled();
  });

  it('同一窗口内重复终态广播只排一个检查', () => {
    const deps = makeDeps();
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    handler({ sessionId: 'session-1', updates: { status: 'idle' } });
    expect(deps.timers).toHaveLength(1);

    deps.timers[0].run();
    expect(deps.reloadSession).toHaveBeenCalledTimes(1);
    // 检查跑完后新广播重新可排（下一个缺口仍可恢复）
    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    expect(deps.timers).toHaveLength(2);
  });

  it('空 assistant 正文（无内容终稿）不算已收口', () => {
    const deps = makeDeps({ getLastMessage: () => ({ role: 'assistant', content: '   ' }) });
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    expect(deps.timers).toHaveLength(1);
    deps.timers[0].run();
    expect(deps.reloadSession).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 接线钉：真实 bindInitializedSessionBroadcasts ← SESSION_UPDATED 广播
// ============================================================================

describe('sessionStoreBroadcasts 接线（SESSION_UPDATED → 终态对账）', () => {
  let emit: (channel: string, event: Record<string, unknown>) => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    emit = installMockTransport();
    const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    const { bindInitializedSessionBroadcasts } = await import('../../../src/renderer/stores/sessionStoreBroadcasts');
    const userMsg: Message = { id: 'u-1', role: 'user', content: '问题', timestamp: 1 };
    useSessionStore.setState({
      currentSessionId: 'session-1',
      messages: [userMsg],
      sessions: [{ id: 'session-1', title: 's1', messageCount: 1, turnCount: 1 } as Session & { messageCount: number; turnCount: number }],
    });
    await bindInitializedSessionBroadcasts((session) => session as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('终态广播进来 → 3s 宽限后 switchSession(force) 重读消息', async () => {
    const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    const switchSpy = vi.spyOn(useSessionStore.getState(), 'switchSession').mockResolvedValue(undefined);

    emit(IPC_CHANNELS.SESSION_UPDATED, { sessionId: 'session-1', updates: { status: 'completed', updatedAt: 123 } });
    expect(switchSpy).not.toHaveBeenCalled(); // 宽限期内不动

    await vi.advanceTimersByTimeAsync(TERMINAL_STATUS_RECONCILE_GRACE_MS + 10);
    expect(switchSpy).toHaveBeenCalledTimes(1);
    expect(switchSpy).toHaveBeenCalledWith('session-1', { force: true });
    switchSpy.mockRestore();
  });

  it('宽限期内终稿消息落进 store → 不重灌（健康轮零额外 load）', async () => {
    const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    const switchSpy = vi.spyOn(useSessionStore.getState(), 'switchSession').mockResolvedValue(undefined);

    emit(IPC_CHANNELS.SESSION_UPDATED, { sessionId: 'session-1', updates: { status: 'completed', updatedAt: 123 } });
    useSessionStore.setState({
      messages: [
        { id: 'u-1', role: 'user', content: '问题', timestamp: 1 },
        { id: 'a-1', role: 'assistant', content: '答案', timestamp: 2 },
      ],
    });
    await vi.advanceTimersByTimeAsync(TERMINAL_STATUS_RECONCILE_GRACE_MS + 10);
    expect(switchSpy).not.toHaveBeenCalled();
    switchSpy.mockRestore();
  });
});
