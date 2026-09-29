import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';

const broadcastToRenderer = vi.hoisted(() => vi.fn());
const registerService = vi.hoisted(() => vi.fn());
const uiSettings = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
const getSettings = vi.hoisted(() => vi.fn(() => ({ ui: uiSettings })));

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
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings }),
}));

const { notificationService } =
  await import('../../../../src/host/services/infra/notificationService');

const CJK = /[一-鿿]/;

beforeEach(() => {
  delete process.env.CODE_AGENT_NOTIFICATION_DRY_RUN;
  broadcastToRenderer.mockClear();
  notificationService.clearRecentNotifications();
});

describe('durable resume 通知按用户语言本地化', () => {
  it('en：标题/正文为英文（不含中文字符），自动续跑次数进正文', () => {
    uiSettings.language = 'en';
    notificationService.notifyTaskResuming({
      sessionId: 'session-resume',
      sessionTitle: 'Resume after restart',
      autoResumeCount: 2,
    });

    const entry = notificationService.getRecentNotifications()[0];
    expect(entry?.title).toBe('Task resuming - Resume after restart');
    expect(entry?.body).toBe(
      'Resuming from the interruption; this turn cost is unknown/estimated, and continuing will use quota. Automatic resume attempt 2.',
    );
    expect(entry?.title).not.toMatch(CJK);
    expect(entry?.body).not.toMatch(CJK);
  });

  it('en：会话名为空时兜底 Untitled session', () => {
    uiSettings.language = 'en';
    notificationService.notifyTaskResuming({
      sessionId: 'session-resume',
      sessionTitle: '',
      autoResumeCount: 1,
    });

    expect(broadcastToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ title: 'Task resuming - Untitled session' }),
    );
  });

  it('zh：标题/正文与原文一致', () => {
    uiSettings.language = 'zh';
    notificationService.notifyTaskResuming({
      sessionId: 'session-resume',
      sessionTitle: '重启后续跑',
      autoResumeCount: 3,
    });

    const entry = notificationService.getRecentNotifications()[0];
    expect(entry?.title).toBe('任务正在继续 - 重启后续跑');
    expect(entry?.body).toBe('从中断处继续；本轮成本未知/估算，继续运行会消耗额度。自动续跑第 3 次。');
  });

  it('zh：会话名为空时兜底「未命名会话」（沿用 webServer 原兜底行为）', () => {
    uiSettings.language = 'zh';
    notificationService.notifyTaskResuming({
      sessionId: 'session-resume',
      sessionTitle: '',
      autoResumeCount: 1,
    });

    expect(broadcastToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ title: '任务正在继续 - 未命名会话' }),
    );
  });

  it('配置读取失败按中文兜底，通知路径不抛错', () => {
    getSettings.mockImplementationOnce(() => {
      throw new Error('config unavailable');
    });
    expect(() => notificationService.notifyTaskResuming({
      sessionId: 'session-resume',
      sessionTitle: 'any',
      autoResumeCount: 1,
    })).not.toThrow();
    expect(notificationService.getRecentNotifications()[0]?.title).toBe('任务正在继续 - any');
  });
});
