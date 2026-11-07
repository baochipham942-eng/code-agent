// N-SIDEBAR-CRON-RUN-STATUS-STALE：orchestrator 驱动主跑（cron/heartbeat/通道/CLI）的
// 终态 session:updated 广播。此前该广播只有 web 直连轮（/api/run →
// AgentRunController.updateSessionStatus）一个出口，自动化轮收尾只发 agent_complete，
// 已打开的运行会话视图与侧栏 spinner 停在运行态（FB-510：换会话再切回才对账）。
// 这里钉死 agent 终态锚点上的状态分类、落库与广播，以及「非主跑/落库失败不广播」的边界。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionManagerState = vi.hoisted(() => ({
  updateSession: vi.fn(),
  addMessageToSession: vi.fn(),
  updateMessage: vi.fn(),
  getSession: vi.fn(),
}));

const broadcastState = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
}));

const backgroundManagerState = vi.hoisted(() => ({
  isInBackground: vi.fn(),
  isTaskRunning: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
  notificationService: { notifyTaskComplete: vi.fn(), notifyNeedsInput: vi.fn() },
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
  broadcastToRenderer: broadcastState.broadcastToRenderer,
}));

vi.mock('../../../src/host/session/backgroundTaskManager', () => ({
  getBackgroundTaskManager: () => backgroundManagerState,
}));

import { persistTaskManagerEvent } from '../../../src/host/task/taskManagerEventPersistence';
import { MessageDeltaAccumulator } from '../../../src/host/protocol/messageDeltaAccumulator';
import type { BackgroundRunErrorRecord } from '../../../src/host/task/backgroundTaskTerminal';

const SESSION_UPDATED = 'session:updated';
const SESSION_LIST_UPDATED = 'session:list-updated';

interface Harness {
  errors: Map<string, BackgroundRunErrorRecord>;
  persist: (event: unknown, eventKey?: string) => Promise<void>;
}

function createHarness(sessionId = 'cron-session-1'): Harness {
  const errors = new Map<string, BackgroundRunErrorRecord>();
  const accumulator = new MessageDeltaAccumulator();
  return {
    errors,
    persist: (event, eventKey) => persistTaskManagerEvent(
      {
        turnStateBySession: new Map(),
        backgroundPermissionOwners: new Map(),
        backgroundRunTerminalErrors: errors,
        messageDeltaAccumulator: accumulator,
      },
      sessionId,
      event as never,
      undefined,
      eventKey ?? sessionId,
    ),
  };
}

function terminalBroadcasts(): Array<[string, unknown]> {
  return broadcastState.broadcastToRenderer.mock.calls
    .filter(([channel]) => channel === SESSION_UPDATED || channel === SESSION_LIST_UPDATED)
    .map(([channel, data]) => [channel as string, data]);
}

beforeEach(() => {
  sessionManagerState.updateSession.mockReset().mockResolvedValue(undefined);
  broadcastState.broadcastToRenderer.mockReset();
  backgroundManagerState.isInBackground.mockReset().mockReturnValue(false);
  backgroundManagerState.isTaskRunning.mockReset().mockReturnValue(false);
});

describe('主跑 agent 终态的 session 状态收口（cron/自动化轮）', () => {
  it('agent_complete：落库 completed 并广播带终态的 session:updated + session:list-updated', async () => {
    const { persist } = createHarness();

    await persist({ type: 'agent_complete', data: null });

    expect(sessionManagerState.updateSession).toHaveBeenCalledWith(
      'cron-session-1',
      expect.objectContaining({ status: 'completed' }),
    );
    const broadcasts = terminalBroadcasts();
    const updated = broadcasts.find(([channel]) => channel === SESSION_UPDATED);
    expect(updated).toBeDefined();
    expect(updated?.[1]).toMatchObject({
      sessionId: 'cron-session-1',
      updates: { status: 'completed' },
    });
    expect(broadcasts.some(([channel]) => channel === SESSION_LIST_UPDATED)).toBe(true);
  });

  it('run 级终态 error 记账后的 agent_complete：分类为 error（决策表与 /api/run finalStatus 同源）', async () => {
    const { persist, errors } = createHarness();
    errors.set('cron-session-1', { message: 'RUN_FAILED', code: 'RUN_FAILED' });

    await persist({ type: 'agent_complete', data: null });

    expect(sessionManagerState.updateSession).toHaveBeenCalledWith(
      'cron-session-1',
      expect.objectContaining({ status: 'error' }),
    );
    expect(terminalBroadcasts()[0]?.[1]).toMatchObject({
      sessionId: 'cron-session-1',
      updates: { status: 'error' },
    });
  });

  it('agent_cancelled：分类为 interrupted（取消压过终态 error 记账）', async () => {
    const { persist, errors } = createHarness();
    errors.set('cron-session-1', { message: 'boom' });

    await persist({ type: 'agent_cancelled', data: null });

    expect(sessionManagerState.updateSession).toHaveBeenCalledWith(
      'cron-session-1',
      expect.objectContaining({ status: 'interrupted' }),
    );
    // 账目被 closeBackgroundRunAtTerminal 消费，后续轮不会重复分类为 error
    expect(errors.has('cron-session-1')).toBe(false);
  });

  it('子代理/后台 lane 的 agent_complete（eventKey ≠ sessionId）：不落状态、不广播', async () => {
    const { persist } = createHarness();

    await persist({ type: 'agent_complete', data: null }, 'background-lane-key');

    expect(sessionManagerState.updateSession).not.toHaveBeenCalled();
    expect(terminalBroadcasts()).toEqual([]);
  });

  it('非终态锚点事件（turn_end/task_complete/error 记账）单独到达时不触发状态收口', async () => {
    const { persist } = createHarness();

    await persist({ type: 'turn_end', data: { turnId: 'turn-1' } });
    await persist({ type: 'task_complete', data: { turnId: 'turn-1', summary: 'ok' } });
    await persist({ type: 'error', data: { message: 'boom', terminal: true } });

    expect(sessionManagerState.updateSession).not.toHaveBeenCalled();
    expect(terminalBroadcasts()).toEqual([]);
  });

  it('落库失败：只留痕、不广播（与 AgentRunController.updateSessionStatus 同口径）', async () => {
    sessionManagerState.updateSession.mockRejectedValueOnce(new Error('db locked'));
    const { persist } = createHarness();

    await persist({ type: 'agent_complete', data: null });

    expect(terminalBroadcasts()).toEqual([]);
  });
});
