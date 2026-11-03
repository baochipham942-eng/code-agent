// ============================================================================
// clearRecentNotifications 必须连预算窗口一起复位（slash-commands E2E 返修的回归钉子）
//
// E2E 现场：serial 用例共享一台服务器，前一条用例的完成通知打开了 15 分钟预算窗口，
// 后一条用例的 cron 完成通知（非豁免、非 urgent）被折进暂存——不 record()、不进
// getRecent，轮询 90s 超时。修法是每条用例前调 DELETE /api/dev/notifications →
// clearRecentNotifications()。本测试钉住该清档口在 service 侧的真实语义：
// 清 recent 列表的同时把预算窗口/暂存/digest 定时器一并复位，下一条普通通知
// 重新当「首条」立即投递。任何一步不推进假时钟（timer advance = 0）。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const broadcastToRenderer = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer,
}));
vi.mock('../../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

const { notificationService } = await import('../../../../src/host/services/infra/notificationService');

function complete(sessionId: string, sessionTitle: string): void {
  notificationService.notifyTaskComplete(
    { sessionId, sessionTitle, duration: 1_000, toolsUsed: [] },
    { force: true },
  );
}

describe('clearRecentNotifications 复位通知预算窗口', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    process.env.CODE_AGENT_NOTIFICATION_DRY_RUN = '1';
    notificationService.clearRecentNotifications();
  });

  afterEach(() => {
    notificationService.clearRecentNotifications();
    delete process.env.CODE_AGENT_NOTIFICATION_DRY_RUN;
    vi.useRealTimers();
  });

  it('清档后下一条普通完成通知立即投递（不被残留窗口暂存，零 timer advance）', () => {
    // (a) 首条普通完成：立即投递（record 进 getRecent）并打开 15 分钟预算窗口。
    complete('session-a', 'first completion');
    expect(notificationService.getRecentNotifications()).toHaveLength(1);

    // 前置对照：窗口开着，同窗的后续普通完成被暂存，不进 getRecent。
    complete('session-held', 'held completion');
    expect(notificationService.getRecentNotifications()).toHaveLength(1);

    // (b) 清档：recent 列表清空，且必须连预算窗口/暂存/定时器一起复位。
    notificationService.clearRecentNotifications();
    expect(notificationService.getRecentNotifications()).toHaveLength(0);

    // (c) 另一会话的普通完成通知（仍非豁免、非 urgent）。
    complete('session-b', 'second completion');

    // (d) 不推进任何时钟，它应当作为新窗口的「首条」立即可见。
    const entries = notificationService.getRecentNotifications();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'task_complete', sessionId: 'session-b' });
    expect(entries[0]?.title).toBe('任务完成 - second completion');
  });
});
