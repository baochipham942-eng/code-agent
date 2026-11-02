import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';

const broadcastToRenderer = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ focused: true }));

// App 窗口聚焦：普通（非 force）通知被 host 焦点门丢弃，失败类必须穿透。
vi.mock('../../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => (platformState.focused ? { id: 1 } : null) },
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

const { notificationService } =
  await import('../../../../src/host/services/infra/notificationService');

beforeEach(() => {
  delete process.env.CODE_AGENT_NOTIFICATION_DRY_RUN;
  platformState.focused = true;
  broadcastToRenderer.mockClear();
  notificationService.clearRecentNotifications();
});

describe('聚焦时的 host 焦点门', () => {
  it('未 force 的失败通知穿透并带 urgent:true', () => {
    notificationService.notifyTaskComplete({ sessionId: 's', sessionTitle: 'T', duration: 1, toolsUsed: [], succeeded: false });
    expect(broadcastToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ urgent: true, failure: true }),
    );
  });

  it('未 force 的完成通知仍被丢弃', () => {
    notificationService.notifyTaskComplete({ sessionId: 's', sessionTitle: 'T', duration: 1, toolsUsed: [] });
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });
});

describe('needs_input 在聚焦时也投递', () => {
  const data = { sessionId: 's', title: '需要授权 - T', body: 'bash' };

  it('聚焦时穿透 host 焦点门并带 urgent:true', () => {
    notificationService.notifyNeedsInput(data);
    expect(broadcastToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ sessionId: 's', urgent: true }),
    );
  });

  it('失焦（getFocusedWindow 返回 null）时同样带 urgent:true', () => {
    platformState.focused = false;
    notificationService.notifyNeedsInput(data);
    expect(broadcastToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ urgent: true }),
    );
  });
});
