import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';

const broadcastToRenderer = vi.hoisted(() => vi.fn());
const registerService = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer,
}));
vi.mock('../../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: registerService }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { notificationService } =
  await import('../../../../src/host/services/infra/notificationService');

beforeEach(() => {
  delete process.env.CODE_AGENT_NOTIFICATION_DRY_RUN;
  broadcastToRenderer.mockClear();
  notificationService.clearRecentNotifications();
});

describe('挂断后语音任务通知', () => {
  it('成功通知标题带任务名，并要求侧栏把目标会话标成未读', () => {
    notificationService.notifyVoiceWorkSettled({
      sessionId: 'session-voice',
      taskTitle: '生成销售日报',
      status: 'done',
    });

    expect(notificationService.getRecentNotifications()).toEqual([
      expect.objectContaining({
        type: 'task_complete',
        sessionId: 'session-voice',
        title: '语音任务完成 - 生成销售日报',
      }),
    ]);
    expect(broadcastToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({
        sessionId: 'session-voice',
        title: '语音任务完成 - 生成销售日报',
        markSessionUnread: true,
      }),
    );
  });

  it('失败通知同样带任务名和真实原因', () => {
    notificationService.notifyVoiceWorkSettled({
      sessionId: 'session-voice',
      taskTitle: '更新预算表',
      status: 'failed',
      detail: '文件被占用',
    });

    expect(broadcastToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({
        title: '语音任务失败 - 更新预算表',
        body: expect.stringContaining('文件被占用'),
        markSessionUnread: true,
      }),
    );
  });

  it('普通任务完成通知不携带语音会话未读信号', () => {
    notificationService.notifyTaskComplete({
      sessionId: 'session-text',
      sessionTitle: '普通文本会话',
      duration: 1_000,
      toolsUsed: [],
    });

    expect(broadcastToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.not.objectContaining({ markSessionUnread: true }),
    );
  });
});
