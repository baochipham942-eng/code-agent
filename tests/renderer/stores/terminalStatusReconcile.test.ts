// ============================================================================
// terminalStatusReconcile.test.ts — N-WORKDETAIL-DEFAULT-SIMPLE-FU2-FU2 (+FU2-FU2-FU1)
//
// 钉住：当前会话的终态 session:updated 广播到达、而转录区最后一条还不是有正文的
// assistant 消息（直连 run 流静默失联、终局事件没到过的形状）时，宽限期后必须走
// 一次快照重灌把 DB 真相拉回页面；健康收尾（宽限期内终局事件先到 / 广播时终稿
// 已在）零重灌。回归背景：真跑复现「答案完整落库、页面 47 分钟不上屏、reload 即现」。
//
// FU2-FU2-FU1 补口：流式半途失联——部分正文已上屏，末条「看起来已收口」（assistant
// + 非空正文），父版判据提前返回、页面永停半答案。「未收口 run」记录（见过
// turn_start、没见过 agent_complete/agent_cancelled/终态 error）是唯一还能作证的
// 证据：排程与 fire 双条件「尾部未收口 或 run 未收口」任一成立即重灌；重灌后吞掉
// 记录，重复终态广播不二灌。
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
  clearUnendedRun: ReturnType<typeof vi.fn>;
  timers: Array<{ run: () => void; delayMs: number }>;
} {
  const reloadSession = vi.fn(async () => {});
  const clearUnendedRun = vi.fn();
  const timers: Array<{ run: () => void; delayMs: number }> = [];
  const base: ReconcilerDeps = {
    getCurrentSessionId: () => 'session-1',
    getLastMessage: () => ({ role: 'user', content: '问题' }),
    reloadSession,
    isRunActive: () => false,
    isTerminalStatus: (status) => ['completed', 'error', 'interrupted', 'orphaned', 'idle'].includes(status ?? ''),
    hasUnendedRun: () => false,
    clearUnendedRun,
    schedule: (run, delayMs) => { timers.push({ run, delayMs }); },
  };
  // reloadSession/timers 是断言句柄必须兜底；clearUnendedRun 允许 override（用例要带
  // 真实 store 语义的可变实现），故不重铺。
  return Object.assign(base, overrides, { reloadSession, timers }) as ReconcilerDeps & {
    reloadSession: ReturnType<typeof vi.fn>;
    clearUnendedRun: ReturnType<typeof vi.fn>;
    timers: Array<{ run: () => void; delayMs: number }>;
  };
}

/** 未收口 run 记录的可变实现：与真实 terminalRunGuardStore 的 rearm/mark 语义同形。 */
function makeUnendedRuns(initial: string[] = []): {
  has: (sessionId: string) => boolean;
  clear: (sessionId: string) => void;
} {
  const set = new Set(initial);
  return {
    has: (sessionId) => set.has(sessionId),
    clear: (sessionId) => { set.delete(sessionId); },
  };
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

  // ---- FU2-FU2-FU1：流式半途失联（部分正文已上屏）----

  it('半途失联形状（末条=带部分正文的 assistant + run 未收口）：排程且宽限期后重灌——本单核心不变量', () => {
    const unended = makeUnendedRuns(['session-1']);
    const deps = makeDeps({
      getLastMessage: () => ({ role: 'assistant', content: '快速排序的原理是' }), // 部分正文：父版判据把它当已收口提前返回
      hasUnendedRun: unended.has,
      clearUnendedRun: unended.clear,
    });
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    expect(deps.timers).toHaveLength(1); // 父版在这里不排程——正是永停半答案的缺口
    deps.timers[0].run();
    expect(deps.reloadSession).toHaveBeenCalledTimes(1);
    expect(deps.reloadSession).toHaveBeenCalledWith('session-1');
    expect(unended.has('session-1')).toBe(false); // 重灌前吞掉未收口记录
  });

  it('宽限期内终局事件经 run 流到了（agent_complete 收口记录）→ 半途失联形状也不重灌', () => {
    const unended = makeUnendedRuns(['session-1']);
    const deps = makeDeps({
      getLastMessage: () => ({ role: 'assistant', content: '完整答案' }),
      hasUnendedRun: unended.has,
      clearUnendedRun: unended.clear,
    });
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    expect(deps.timers).toHaveLength(1);
    unended.clear('session-1'); // 宽限期内 agent_complete → markRunEndObserved 收口
    deps.timers[0].run();
    expect(deps.reloadSession).not.toHaveBeenCalled();
  });

  it('刷新后的新页面没见过 turn_start（无未收口记录）→ 半截尾巴不算证据，零排程零重灌', () => {
    const deps = makeDeps({
      getLastMessage: () => ({ role: 'assistant', content: '历史半截答案' }),
      hasUnendedRun: () => false,
    });
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    expect(deps.timers).toHaveLength(0);
    expect(deps.reloadSession).not.toHaveBeenCalled();
  });

  it('重灌之后的重复终态广播不二次重灌（未收口记录已吞，即使尾巴仍停在半截）', () => {
    const unended = makeUnendedRuns(['session-1']);
    const deps = makeDeps({
      getLastMessage: () => ({ role: 'assistant', content: '快速排序的原理是' }),
      hasUnendedRun: unended.has,
      clearUnendedRun: unended.clear,
    });
    const handler = createTerminalStatusReconciler(deps);

    handler({ sessionId: 'session-1', updates: { status: 'completed' } });
    deps.timers[0].run();
    expect(deps.reloadSession).toHaveBeenCalledTimes(1);

    // 重灌没能换回终稿的形状也只灌一次：记录已吞，第二次广播直接短路
    handler({ sessionId: 'session-1', updates: { status: 'idle' } });
    expect(deps.timers).toHaveLength(1);
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
    const { useTerminalRunGuardStore } = await import('../../../src/renderer/stores/terminalRunGuardStore');
    // 未收口记录是模块级持久 store：不重置会跨用例泄漏，把「零重灌」用例误触发成重灌
    useTerminalRunGuardStore.setState({ terminalBySession: new Map(), unendedRuns: new Set() });
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

  it('半途失联形状（部分正文 + 未收口记录）→ 宽限后 switchSession(force)；重复广播不二灌', async () => {
    const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    const { useTerminalRunGuardStore } = await import('../../../src/renderer/stores/terminalRunGuardStore');
    const guard = useTerminalRunGuardStore.getState();
    guard.rearmForNewRun('session-1'); // turn_start 的效果（公开 store 方法）
    useSessionStore.setState({
      messages: [
        { id: 'u-1', role: 'user', content: '问题', timestamp: 1 },
        { id: 'a-1', role: 'assistant', content: '快速排序的原理是', timestamp: 2 }, // 流式半截
      ],
    });
    const switchSpy = vi.spyOn(useSessionStore.getState(), 'switchSession').mockResolvedValue(undefined);

    emit(IPC_CHANNELS.SESSION_UPDATED, { sessionId: 'session-1', updates: { status: 'completed', updatedAt: 123 } });
    expect(switchSpy).not.toHaveBeenCalled(); // 宽限期内不动
    await vi.advanceTimersByTimeAsync(TERMINAL_STATUS_RECONCILE_GRACE_MS + 10);
    expect(switchSpy).toHaveBeenCalledTimes(1);
    expect(switchSpy).toHaveBeenCalledWith('session-1', { force: true });
    expect(useTerminalRunGuardStore.getState().hasUnendedRun('session-1')).toBe(false); // 灌前吞掉

    emit(IPC_CHANNELS.SESSION_UPDATED, { sessionId: 'session-1', updates: { status: 'idle', updatedAt: 124 } });
    await vi.advanceTimersByTimeAsync(TERMINAL_STATUS_RECONCILE_GRACE_MS + 10);
    expect(switchSpy).toHaveBeenCalledTimes(1); // 重复终态广播不二灌
    switchSpy.mockRestore();
  });
});

// ============================================================================
// 未收口 run 记录语义钉子：真实 agent 事件路径（ipcService 'agent:event' → 真实
// useConversationStreamEffects + useSessionLifecycleEffects）驱动 terminalRunGuardStore。
// 款式同 terminalStickyRunState.test.ts。httpTransport 在 reader 正常结束时也会合成
// stream_end——所以只有 run 流的终局事件（agent_complete / agent_cancelled / 终态
// error）才算「答案到过」的证据，stream_end 与终态广播都不算。
// ============================================================================

describe('terminalRunGuardStore 未收口记录（agent 事件路径）', () => {
  const SESSION_ID = 'unended-session';
  const ipcListeners = new Map<string, Set<(payload: unknown) => void>>();
  let agentSeq = 0;
  let emitAgentEvent: (event: Record<string, unknown>) => void;
  let guardHasUnended: () => boolean;

  beforeEach(async () => {
    vi.useFakeTimers();
    ipcListeners.clear(); // 前一用例的桥接回调不带走（ipcService 侧靠 useEffect 清理 + seq 去重兜底）
    const bridge = {
      invoke: vi.fn(async () => undefined),
      on: (channel: string, callback: (payload: unknown) => void) => {
        const bucket = ipcListeners.get(channel) ?? new Set<(payload: unknown) => void>();
        bucket.add(callback);
        ipcListeners.set(channel, bucket);
        return () => bucket.delete(callback);
      },
      off: () => undefined,
    };
    Object.assign(window, { codeAgentAPI: bridge, electronAPI: bridge, domainAPI: { invoke: vi.fn(async () => ({ success: true, data: null })) } });

    const { act, cleanup, renderHook } = await import('@testing-library/react');
    const { useConversationStreamEffects } = await import('../../../src/renderer/hooks/agent/effects/useConversationStreamEffects');
    const { useSessionLifecycleEffects } = await import('../../../src/renderer/hooks/agent/effects/useSessionLifecycleEffects');
    const { useTerminalRunGuardStore } = await import('../../../src/renderer/stores/terminalRunGuardStore');
    const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    const { useAppStore } = await import('../../../src/renderer/stores/appStore');
    // 终态广播路径也要进场景：bind 之后 SESSION_UPDATED 才有监听者
    const { bindInitializedSessionBroadcasts } = await import('../../../src/renderer/stores/sessionStoreBroadcasts');
    await bindInitializedSessionBroadcasts((session) => session as never);

    useTerminalRunGuardStore.setState({ terminalBySession: new Map(), unendedRuns: new Set() });
    useAppStore.setState({ processingSessionIds: new Set(), isProcessing: false });
    useSessionStore.setState({ currentSessionId: SESSION_ID, messages: [], sessions: [], todos: [], sessionTasks: [] } as never);
    guardHasUnended = () => useTerminalRunGuardStore.getState().hasUnendedRun(SESSION_ID);

    const noop = () => undefined;
    const props = {
      addMessage: useSessionStore.getState().addMessage,
      appendStreamingMessageDelta: noop,
      currentSessionId: SESSION_ID,
      currentTurnMessageIdRef: { current: null },
      enqueuePermissionRequest: useAppStore.getState().enqueuePermissionRequest,
      flushRef: { current: noop },
      flushStreamingMessages: noop,
      lastEventAtRef: { current: Date.now() },
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queueUpdate: noop,
      setActiveToolProgress: noop,
      setIsInterrupting: noop,
      setIsProcessing: useAppStore.getState().setIsProcessing,
      setPendingPermissionRequest: useAppStore.getState().setPendingPermissionRequest,
      setResearchDetected: noop,
      setSessionTaskComplete: useAppStore.getState().setSessionTaskComplete,
      setSessionTaskProgress: useAppStore.getState().setSessionTaskProgress,
      setSessionTasks: useSessionStore.getState().setSessionTasks,
      setTodos: useSessionStore.getState().setTodos,
      setToolTimeoutWarning: noop,
      shiftQueuedPermissionRequest: useAppStore.getState().shiftQueuedPermissionRequest,
      updateMessage: useSessionStore.getState().updateMessage,
    } as Parameters<typeof useSessionLifecycleEffects>[0];
    renderHook(() => {
      useConversationStreamEffects(props);
      useSessionLifecycleEffects(props);
    });

    emitAgentEvent = (event: Record<string, unknown>) => {
      agentSeq += 1;
      act(() => {
        const bucket = ipcListeners.get('agent:event');
        if (!bucket) throw new Error('no agent:event listener');
        for (const callback of [...bucket]) callback({ streamEpoch: 'http:test', seq: agentSeq, sessionId: SESSION_ID, ...event });
      });
    };
    // renderHook 返回值本用例不需要，但 cleanup 必须在用例后调用
    afterEach(() => {
      cleanup();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });
  });

  it('turn_start 登记 → stream_end 不收口（合成事件不是证据）→ agent_complete 收口', () => {
    expect(guardHasUnended()).toBe(false); // 刷新后的页面：没见过 turn_start，记录为空
    emitAgentEvent({ type: 'turn_start', data: { turnId: 'turn-1' } });
    expect(guardHasUnended()).toBe(true);
    emitAgentEvent({ type: 'stream_end', data: null });
    expect(guardHasUnended()).toBe(true); // stream_end 单独不收口
    emitAgentEvent({ type: 'agent_complete', data: null });
    expect(guardHasUnended()).toBe(false);
  });

  it('agent_cancelled 与终态 error 同样收口', () => {
    emitAgentEvent({ type: 'turn_start', data: { turnId: 'turn-2' } });
    emitAgentEvent({ type: 'agent_cancelled', data: null });
    expect(guardHasUnended()).toBe(false);

    emitAgentEvent({ type: 'turn_start', data: { turnId: 'turn-3' } });
    emitAgentEvent({ type: 'error', data: { code: 'RUN_FAILED', message: 'boom' } });
    expect(guardHasUnended()).toBe(false);
  });

  it('终态 session:updated 广播不收口——广播健康不代表 run 流把终局事件送到了', () => {
    emitAgentEvent({ type: 'turn_start', data: { turnId: 'turn-4' } });
    const bucket = ipcListeners.get(IPC_CHANNELS.SESSION_UPDATED);
    expect(bucket).toBeDefined();
    for (const callback of [...(bucket ?? [])]) callback({ sessionId: SESSION_ID, updates: { status: 'completed', updatedAt: 999 } });
    expect(guardHasUnended()).toBe(true); // 正是半途失联形状里唯一的「流死了」证据
  });
});
