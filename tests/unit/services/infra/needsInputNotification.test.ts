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

const { notificationService } =
  await import('../../../../src/host/services/infra/notificationService');

beforeEach(() => {
  platformMocks.focusedWindow = null;
  platformMocks.broadcast.mockClear();
  notificationService.clearRecentNotifications();
});

describe('needs-input notification focus policy', () => {
  it('窗口聚焦时不发系统通知', () => {
    platformMocks.focusedWindow = {};
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '等待回答', body: '请选择' });
    expect(platformMocks.broadcast).not.toHaveBeenCalled();
  });

  it('窗口未聚焦时每次请求只投递一次', () => {
    notificationService.notifyNeedsInput({ sessionId: 's1', title: '等待回答', body: '请选择' });
    expect(platformMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(platformMocks.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ sessionId: 's1', title: '等待回答', body: '请选择' }),
    );
  });
});
