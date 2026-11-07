import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';
import { NOTIFICATION_BUDGET } from '../../../../src/shared/constants';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: mocks.broadcast,
}));
vi.mock('../../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

const { notificationService } =
  await import('../../../../src/host/services/infra/notificationService');

const task = (id: string) => ({ sessionId: id, sessionTitle: `T-${id}`, duration: 1000, toolsUsed: [] }) as never;
const infoCalls = (msg: string) => mocks.info.mock.calls.filter((c) => c[0] === msg);

beforeEach(() => {
  vi.useFakeTimers();
  mocks.broadcast.mockClear();
  mocks.info.mockClear();
  notificationService.clearRecentNotifications();
});

describe('通知未送达/折叠的日志留痕', () => {
  it('needs-input 重复 dedupeKey：info 级 dedupe-duplicate', () => {
    const data = { sessionId: 's', title: 't', body: 'b', dedupeKey: 'dk-trace' };
    notificationService.notifyNeedsInput(data);
    notificationService.notifyNeedsInput(data);
    expect(infoCalls('Notification not delivered')).toEqual([
      ['Notification not delivered', { reason: 'dedupe-duplicate', dedupeKey: 'dk-trace' }],
    ]);
  });

  it('预算窗口内第二条被 held：budget-held，且不再记 dispatched', () => {
    notificationService.notifyTaskComplete(task('a'));
    expect(infoCalls('Notification dispatched to renderer')).toHaveLength(1);
    notificationService.notifyTaskComplete(task('b'));
    expect(infoCalls('Notification dispatched to renderer')).toHaveLength(1);
    expect(infoCalls('Notification held by budget')).toEqual([
      ['Notification held by budget', { reason: 'budget-held', intent: 'task_complete', sessionId: 'b' }],
    ]);
  });

  it('窗尾 ≥2 条折成摘要：budget-digest 带 count', () => {
    notificationService.notifyTaskComplete(task('a'));
    notificationService.notifyTaskComplete(task('b'));
    notificationService.notifyTaskComplete(task('c'));
    vi.runOnlyPendingTimers();
    expect(infoCalls('Notification folded into digest')).toEqual([
      ['Notification folded into digest', { reason: 'budget-digest', count: 2 }],
    ]);
    vi.clearAllTimers();
  });

  it('同一名称定时任务 15 分钟窗内三次完成（+0s/+42s/+112s）：首条投递，后两条暂存不广播，窗尾合为 count=2 摘要；task_failed 绕过预算对比', async () => {
    const sessionTitle = '[定时] 回复四个字：定时完成';
    vi.setSystemTime(new Date('2026-11-07T07:46:25.425Z'));

    // +0s: completion #1
    notificationService.notifyTaskComplete(
      { sessionId: 'run-1', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    expect(mocks.info.mock.calls).toEqual([
      ['Notification dispatched to renderer', { sessionTitle }],
    ]);
    expect(mocks.broadcast.mock.calls).toHaveLength(1);
    expect(mocks.broadcast.mock.calls[0][0]).toBe(IPC_CHANNELS.NOTIFICATION_SHOW);
    expect(mocks.broadcast.mock.calls[0][1]).toMatchObject({
      sessionId: 'run-1',
      title: `任务完成 - ${sessionTitle}`,
    });

    // +42s (07:47:07.431Z): completion #2
    vi.advanceTimersByTime(42_006);
    notificationService.notifyTaskComplete(
      { sessionId: 'run-2', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    expect(infoCalls('Notification dispatched to renderer')).toHaveLength(1);
    expect(mocks.broadcast.mock.calls).toHaveLength(1);
    expect(infoCalls('Notification held by budget')).toEqual([
      ['Notification held by budget', { reason: 'budget-held', intent: 'task_complete', sessionId: 'run-2' }],
    ]);

    // +112s (07:48:17.369Z, +69.938s from #2): completion #3
    vi.advanceTimersByTime(69_938);
    notificationService.notifyTaskComplete(
      { sessionId: 'run-3', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    expect(infoCalls('Notification dispatched to renderer')).toHaveLength(1);
    expect(mocks.broadcast.mock.calls).toHaveLength(1);
    expect(infoCalls('Notification held by budget')).toEqual([
      ['Notification held by budget', { reason: 'budget-held', intent: 'task_complete', sessionId: 'run-2' }],
      ['Notification held by budget', { reason: 'budget-held', intent: 'task_complete', sessionId: 'run-3' }],
    ]);

    // Advance past remaining window to reach +15m (08:01:25.425Z)
    vi.advanceTimersByTime(NOTIFICATION_BUDGET.WINDOW_MS - 42_006 - 69_938);
    expect(infoCalls('Notification folded into digest')).toEqual([
      ['Notification folded into digest', { reason: 'budget-digest', count: 2 }],
    ]);
    expect(mocks.broadcast.mock.calls).toHaveLength(2);
    expect(mocks.broadcast.mock.calls[1][0]).toBe(IPC_CHANNELS.NOTIFICATION_SHOW);
    expect(mocks.broadcast.mock.calls[1][1]).toMatchObject({
      sessionId: '',
      title: '另有 2 条通知',
      body: '共 2 条通知： 任务完成 - [定时] 回复四个字：定时完成 任务完成 - [定时] 回复四个字：定时完成 …',
    });
    vi.clearAllTimers();

    // Contrast: task_failed bypasses the budget and delivers all three immediately
    mocks.broadcast.mockClear();
    mocks.info.mockClear();
    notificationService.clearRecentNotifications();

    for (const [id, deltaMs] of [['fail-1', 0], ['fail-2', 42_006], ['fail-3', 69_938]] as const) {
      if (deltaMs > 0) vi.advanceTimersByTime(deltaMs);
      notificationService.notifyTaskComplete(
        { sessionId: id, sessionTitle, duration: 1000, toolsUsed: [], succeeded: false },
        { force: true },
      );
    }
    expect(infoCalls('Notification dispatched to renderer')).toHaveLength(3);
    expect(infoCalls('Notification held by budget')).toHaveLength(0);
    expect(mocks.broadcast.mock.calls).toHaveLength(3);

    // Open point (finding, not fixed): dispose() inside the 15-minute window clears held items
    mocks.broadcast.mockClear();
    mocks.info.mockClear();
    notificationService.clearRecentNotifications();
    vi.setSystemTime(new Date('2026-11-07T07:46:25.425Z'));
    notificationService.notifyTaskComplete(
      { sessionId: 'run-1', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    vi.advanceTimersByTime(42_006);
    notificationService.notifyTaskComplete(
      { sessionId: 'run-2', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    vi.advanceTimersByTime(69_938);
    notificationService.notifyTaskComplete(
      { sessionId: 'run-3', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    expect(infoCalls('Notification held by budget')).toHaveLength(2);
    // Simulate app quit/restart before window end (e.g. at 08:02:49 or inside the 15m window)
    await notificationService.dispose();
    vi.advanceTimersByTime(NOTIFICATION_BUDGET.WINDOW_MS);
    expect(infoCalls('Notification folded into digest')).toHaveLength(0);
    expect(mocks.broadcast.mock.calls).toHaveLength(1);
  });
});
