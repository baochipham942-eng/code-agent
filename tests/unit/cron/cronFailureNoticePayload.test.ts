import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: vi.fn() },
}));

import type { CronJobDefinition, CronJobExecution } from '../../../src/shared/contract/cron';
import { notificationService } from '../../../src/host/services/infra/notificationService';
import {
  CronFailureNoticeGate,
  notifyCronAgentExecution,
} from '../../../src/host/cron/cronFailurePolicy';
import { buildCronLoginWallStopCode } from '../../../src/shared/utils/browserLoginWall';

const notify = notificationService.notifyTaskComplete as ReturnType<typeof vi.fn>;

function definition(): CronJobDefinition {
  return {
    id: 'job-1',
    name: '整理邮件',
    action: { type: 'agent', agentType: 'default', prompt: '整理' },
  } as CronJobDefinition;
}

function execution(error: string, status: CronJobExecution['status'] = 'failed'): CronJobExecution {
  return {
    id: 'execution-1',
    jobId: 'job-1',
    status,
    scheduledAt: 1,
    retryAttempt: 0,
    sessionId: 'session-1',
    duration: 12,
    error,
  };
}

beforeEach(() => {
  notify.mockClear();
});

describe('notifyCronAgentExecution 失败载荷', () => {
  it('非登录墙失败带 CRON_FAILURE、类别和写明的重置时间，正文仍保留旧摘要', () => {
    notifyCronAgentExecution(
      definition(),
      execution('usage limit reached. next_flush_time: 2026-10-15T05:00:00Z'),
      new CronFailureNoticeGate(),
    );
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CRON_FAILURE',
      failureKind: 'quota',
      resetAt: '2026-10-15T05:00:00.000Z',
      succeeded: false,
      summary: expect.stringContaining('定时任务失败：'),
    }), { force: true });
  });

  it('登录墙仍只带站点和登录墙码', () => {
    notifyCronAgentExecution(
      definition(),
      execution(buildCronLoginWallStopCode('https://example.test')),
      new CronFailureNoticeGate(),
    );
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CRON_LOGIN_WALL_STOP',
      siteOrigin: 'https://example.test',
      succeeded: false,
    }), { force: true });
    const payload = notify.mock.calls[0][0] as { code?: string; failureKind?: string };
    expect(payload.failureKind).toBeUndefined();
    expect(payload.code).not.toBe('CRON_FAILURE');
  });

  it('成功通知不带失败码', () => {
    notifyCronAgentExecution(
      definition(),
      execution('', 'completed'),
      new CronFailureNoticeGate(),
    );
    const payload = notify.mock.calls[0][0] as { code?: string; summary?: string };
    expect(payload.code).toBeUndefined();
    expect(payload.summary).toBe('定时任务已完成');
  });
});
