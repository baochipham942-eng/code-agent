import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronJobExecution } from '../../../../src/shared/contract/cron';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';

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
const { CronFailureNoticeGate, notifyCronAgentExecution } = await import('../../../../src/host/cron/cronFailurePolicy');

const definition = {
  id: 'cron-urgent',
  name: '紧急任务',
  action: { type: 'agent', agentType: 'default', prompt: '检查' },
} as CronJobDefinition;

function execution(status: 'completed' | 'failed', result?: unknown): CronJobExecution {
  return {
    id: `execution-${status}`,
    jobId: definition.id,
    status,
    scheduledAt: 0,
    retryAttempt: 0,
    sessionId: `session-${status}`,
    duration: 1,
    ...(result === undefined ? { error: 'provider failed' } : { result }),
  } as CronJobExecution;
}

describe('notification budget one-hour replay', () => {
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

  it('folds 20 ordinary completions while urgent and failed results arrive immediately', () => {
    const sources = ['role-a', 'role-b', 'role-c', 'cron-a', 'cron-b', 'cron-c', 'cron-d'];
    for (let index = 0; index < 20; index += 1) {
      if (index > 0) vi.advanceTimersByTime(3 * 60_000);
      if (index === 5) {
        notifyCronAgentExecution(
          definition,
          execution('completed', {
            agentType: 'default', prompt: '检查', result: null,
            sessionId: 'session-must-today', urgency: 'must_today',
          }),
          new CronFailureNoticeGate(),
        );
      }
      if (index === 10) {
        notifyCronAgentExecution(definition, execution('failed'), new CronFailureNoticeGate());
      }
      const source = sources[index % sources.length];
      notificationService.notifyTaskComplete({
        sessionId: `session-${index}`,
        sessionTitle: `${source} task ${index}`,
        duration: 1_000,
        toolsUsed: [],
      }, { force: true });
    }
    vi.advanceTimersByTime(3 * 60_000);

    const entries = notificationService.getRecentNotifications();
    console.log(`NOTIFICATION_SCENARIO_DUMP=${JSON.stringify(entries, null, 2)}`);
    const ordinary = entries.filter((entry) => (
      entry.type === 'digest' || (entry.type === 'task_complete' && entry.sessionId === 'session-0')
    ));
    expect(ordinary).toHaveLength(5);
    expect(entries.filter((entry) => entry.type === 'digest')).toHaveLength(4);
    expect(entries[1]).toMatchObject({ type: 'digest', title: '另有 4 条通知' });
    expect(entries[1]?.body).toContain('共 4 条通知');
    expect(entries[1]?.body).toContain('任务完成 - role-c task 2');
    expect(entries[1]?.body).toContain('…');

    expect(entries[2]).toMatchObject({
      type: 'task_complete',
      sessionId: 'session-completed',
      title: '任务完成 - [定时] 紧急任务',
    });
    expect(entries[4]).toMatchObject({
      type: 'task_failed',
      sessionId: 'session-failed',
      title: '任务失败 - [定时] 紧急任务',
    });
  });

  it('marks held resume and voice sessions unread before folding their notifications', () => {
    delete process.env.CODE_AGENT_NOTIFICATION_DRY_RUN;
    broadcastToRenderer.mockClear();
    notificationService.notifyTaskComplete({
      sessionId: 'session-first',
      sessionTitle: 'first completion',
      duration: 1_000,
      toolsUsed: [],
    }, { force: true });
    notificationService.notifyTaskResuming({
      sessionId: 'session-resume-held',
      sessionTitle: 'held resume',
      autoResumeCount: 1,
    });
    notificationService.notifyVoiceWorkSettled({
      sessionId: 'session-voice-held',
      taskTitle: 'held voice task',
      status: 'done',
    });

    for (const sessionId of ['session-resume-held', 'session-voice-held']) {
      expect(broadcastToRenderer).toHaveBeenCalledWith(
        IPC_CHANNELS.NOTIFICATION_SHOW,
        expect.objectContaining({
          sessionId,
          markSessionUnread: true,
          attentionOnly: true,
        }),
      );
    }
    expect(notificationService.getRecentNotifications()).toHaveLength(1);

    vi.advanceTimersByTime(15 * 60_000);
    expect(notificationService.getRecentNotifications().at(-1)).toMatchObject({ type: 'digest' });
    const unreadSessionIds = broadcastToRenderer.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.attentionOnly === true)
      .map((event) => event.sessionId);
    expect(unreadSessionIds).toEqual(['session-resume-held', 'session-voice-held']);
  });

  it('delivers a single held resume at window end without re-marking the session unread', () => {
    delete process.env.CODE_AGENT_NOTIFICATION_DRY_RUN;
    broadcastToRenderer.mockClear();
    notificationService.notifyTaskComplete({
      sessionId: 'session-first',
      sessionTitle: 'first completion',
      duration: 1_000,
      toolsUsed: [],
    }, { force: true });
    notificationService.notifyTaskResuming({
      sessionId: 'session-single-held',
      sessionTitle: 'single held resume',
      autoResumeCount: 2,
    });

    expect(broadcastToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      expect.objectContaining({ sessionId: 'session-single-held', attentionOnly: true }),
    );

    vi.advanceTimersByTime(15 * 60_000);
    const windowEndEvent = broadcastToRenderer.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.attentionOnly !== true)
      .at(-1);
    expect(windowEndEvent).toMatchObject({ sessionId: 'session-single-held' });
    // 未读标记在暂存当下已送达，窗尾补投只弹通知、不重复标未读。
    expect(windowEndEvent?.markSessionUnread).toBeUndefined();
  });
});
