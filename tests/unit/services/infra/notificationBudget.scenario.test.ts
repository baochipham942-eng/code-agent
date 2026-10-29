import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronJobExecution } from '../../../../src/shared/contract/cron';

vi.mock('../../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: vi.fn(),
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
});
