import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
