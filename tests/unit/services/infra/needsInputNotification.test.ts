import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';

const platformMocks = vi.hoisted(() => ({
  focusedWindow: null as object | null,
  broadcast: vi.fn(),
}));

vi.mock('../../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => platformMocks.focusedWindow },
  broadcastToRenderer: platformMocks.broadcast,
}));
vi.mock('../../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// notifyTaskResuming 的文案语言读 configService（ui.language）；本文件不测该路径，钉死 zh。
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

const { notificationService } =
  await import('../../../../src/host/services/infra/notificationService');

beforeEach(() => {
  platformMocks.focusedWindow = null;
  platformMocks.broadcast.mockClear();
  notificationService.clearRecentNotifications();
});

describe('needs-input notification focus policy', () => {
  it('窗口聚焦时仍投递（urgent 穿透焦点门）', () => {
    platformMocks.focusedWindow = {};
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '等待回答', body: '请选择' });
    expect(platformMocks.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ sessionId: 's1', urgent: true }),
    );
  });

  it('窗口未聚焦时每次请求只投递一次', () => {
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '等待回答', body: '请选择' });
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(platformMocks.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ sessionId: 's1', title: '等待回答', body: '请选择' }),
    );
  });

  it('插件通知走同一套系统通知策略，但不绑定会话', () => {
    notificationService.notifyPlugin({ title: '插件提醒', body: '插件已完成同步' });

    expect(notificationService.getRecentNotifications()).toEqual([
      expect.objectContaining({
        type: 'plugin',
        sessionId: '',
        title: '插件提醒',
        body: '插件已完成同步',
      }),
    ]);
    expect(platformMocks.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ sessionId: '', title: '插件提醒', body: '插件已完成同步' }),
    );
  });
});

describe('needs-input dedupeKey 去重', () => {
  it('同一 dedupeKey 第二次调用不再投递', () => {
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '有操作等你确认', body: '第一条', dedupeKey: 'req-1' });
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '需要授权', body: '第二条', dedupeKey: 'req-1' });

    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(platformMocks.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ title: '有操作等你确认', urgent: true }),
    );
  });

  it('不同 dedupeKey 各投递一次', () => {
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '等待回答', body: 'a', dedupeKey: 'req-a' });
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '等待回答', body: 'b', dedupeKey: 'req-b' });

    expect(platformMocks.broadcast).toHaveBeenCalledTimes(2);
  });

  it('不传 dedupeKey 的重复调用不被压制', () => {
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '等待回答', body: 'a' });
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '等待回答', body: 'b' });

    expect(platformMocks.broadcast).toHaveBeenCalledTimes(2);
  });
});
