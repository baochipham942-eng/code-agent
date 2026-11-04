// N-BGPANEL-STOP-TERMINAL：后台任务终态行的宿主真源契约。
// FB-536/FB-518：完成/停止的行 3 秒自动消失、运行中的行没法停。现在终态行常驻列表
// 直到用户清除（dismissTerminal），Stop 走 AGENT_CANCEL → agent_cancelled →
// resolveBackgroundRunSettlement(interrupted) → markCompleted(USER_CANCELLED)。
// 这里用真 BackgroundTaskManager 钉三件事：
//   1. markCompleted/markFailed 后条目仍在（不再 3 秒自动删，也不排任何定时器）；
//   2. 用户停止的通知恰好一次（running-guard 挡掉重放/迟到收口）；
//   3. dismissTerminal 只清终态；终态残留条目再次 moveToBackground 重置回 running。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_TASK_CANCELLED } from '../../../src/shared/constants';
import type { BackgroundTaskUpdateEvent } from '../../../src/shared/contract/sessionState';

const sessionManagerState = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const notifyState = vi.hoisted(() => ({
  notifyTaskComplete: vi.fn(),
  notifyNeedsInput: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
  notificationService: notifyState,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/platform', () => ({
  AppWindow: class MockAppWindow {},
  broadcastToRenderer: vi.fn(),
}));

import {
  getBackgroundTaskManager,
  resetBackgroundTaskManager,
} from '../../../src/host/session/backgroundTaskManager';
import {
  closeBackgroundRunAtTerminal,
  settleBackgroundOnTaskComplete,
} from '../../../src/host/task/backgroundTaskTerminal';

async function backgroundSession(sessionId: string): Promise<void> {
  const moved = await getBackgroundTaskManager().moveToBackground(sessionId);
  expect(moved).toBe(true);
}

function collectUpdates(): BackgroundTaskUpdateEvent[] {
  const events: BackgroundTaskUpdateEvent[] = [];
  getBackgroundTaskManager().on('update', (event: BackgroundTaskUpdateEvent) => events.push(event));
  return events;
}

beforeEach(() => {
  resetBackgroundTaskManager();
  sessionManagerState.getSession.mockReset().mockResolvedValue({
    id: 'session-1',
    title: '长任务',
  });
  notifyState.notifyTaskComplete.mockClear();
});

afterEach(() => {
  resetBackgroundTaskManager();
});

describe('终态行常驻（不自动删除）', () => {
  it('markCompleted 后条目仍是 completed，不排定时器也不发 removed', async () => {
    vi.useFakeTimers();
    try {
      await backgroundSession('session-1');
      const events = collectUpdates();

      await getBackgroundTaskManager().markCompleted('session-1');

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);

      const tasks = getBackgroundTaskManager().getAllTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('completed');
      expect(events.some((event) => event.type === 'removed')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('用户停止（USER_CANCELLED 收线）后条目仍是 completed 常驻', async () => {
    await backgroundSession('session-1');

    // Stop 的真实收线路径：agent_cancelled → settlement(interrupted)
    await closeBackgroundRunAtTerminal('session-1', 'agent_cancelled', new Map());

    const tasks = getBackgroundTaskManager().getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('completed');
    expect(tasks[0].completionMessage).toBe(BACKGROUND_TASK_CANCELLED);
    expect(getBackgroundTaskManager().isTaskRunning('session-1')).toBe(false);
  });

  it('markFailed 后条目常驻（此前也不删，钉住防回归）', async () => {
    await backgroundSession('session-1');

    getBackgroundTaskManager().markFailed('session-1', 'Provider auth failure');

    const tasks = getBackgroundTaskManager().getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('failed');
  });
});

describe('用户停止的通知恰好一次', () => {
  it('agent_cancelled 收线 → 一次「任务已停止」（force）；SSE 重放/迟到收口不再响', async () => {
    await backgroundSession('session-1');

    await closeBackgroundRunAtTerminal('session-1', 'agent_cancelled', new Map());
    // 重放的 agent_cancelled（SSE at-least-once）
    await closeBackgroundRunAtTerminal('session-1', 'agent_cancelled', new Map());
    // 迟到的 task_complete 收口
    await settleBackgroundOnTaskComplete('session-1', 'session-1', { summary: '周报已写好' });

    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', summary: '任务已停止' }),
      expect.objectContaining({ force: true }),
    );
  });

  it('成功收口（task_complete）后 agent_cancelled 迟到：仍只响一次（完成文案）', async () => {
    await backgroundSession('session-1');

    await settleBackgroundOnTaskComplete('session-1', 'session-1', { summary: '周报已写好' });
    await closeBackgroundRunAtTerminal('session-1', 'agent_cancelled', new Map());

    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', summary: '周报已写好' }),
      expect.objectContaining({ force: true }),
    );
  });
});

describe('dismissTerminal（终态行手动清除）', () => {
  it('running 条目 no-op：不清除、不发 removed', async () => {
    await backgroundSession('session-1');
    const events = collectUpdates();

    expect(getBackgroundTaskManager().dismissTerminal('session-1')).toBe(false);

    expect(getBackgroundTaskManager().getAllTasks()).toHaveLength(1);
    expect(events.some((event) => event.type === 'removed')).toBe(false);
  });

  it('终态条目清除：条目消失并发 removed（completed 与 stopped 同形）', async () => {
    await backgroundSession('session-1');
    await closeBackgroundRunAtTerminal('session-1', 'agent_cancelled', new Map());
    const events = collectUpdates();

    expect(getBackgroundTaskManager().dismissTerminal('session-1')).toBe(true);

    expect(getBackgroundTaskManager().getAllTasks()).toHaveLength(0);
    expect(events.filter((event) => event.type === 'removed')).toHaveLength(1);
  });

  it('不在后台的会话 no-op', () => {
    expect(getBackgroundTaskManager().dismissTerminal('nope')).toBe(false);
  });
});

describe('终态残留条目再次转后台（重置回 running）', () => {
  it('同一会话停止后再次 moveToBackground：旧终态行被移除、新行 running，终态收线能重新生效', async () => {
    await backgroundSession('session-1');
    await closeBackgroundRunAtTerminal('session-1', 'agent_cancelled', new Map());
    const events = collectUpdates();

    await backgroundSession('session-1');

    const tasks = getBackgroundTaskManager().getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('running');
    // 旧终态行先 removed（renderer 才不会因 added 去重把新行丢掉）
    expect(events.some((event) => event.type === 'removed')).toBe(true);
    expect(getBackgroundTaskManager().isTaskRunning('session-1')).toBe(true);

    // 新 run 的终态能再次收线（没有被旧终态条目挡住）
    await closeBackgroundRunAtTerminal('session-1', 'agent_complete', new Map());
    expect(getBackgroundTaskManager().getAllTasks()[0].status).toBe('completed');
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(2);
  });

  it('running 条目重复 moveToBackground 仍是 no-op（不重置计时）', async () => {
    await backgroundSession('session-1');
    const before = getBackgroundTaskManager().getAllTasks()[0];

    await backgroundSession('session-1');

    expect(getBackgroundTaskManager().getAllTasks()[0]).toBe(before);
  });
});
