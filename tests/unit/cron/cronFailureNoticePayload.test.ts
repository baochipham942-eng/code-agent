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
import { buildCronAgentActionResult } from '../../../src/host/cron/cronNormalizers';
import { buildCronLoginWallStopCode } from '../../../src/shared/utils/browserLoginWall';

const notify = notificationService.notifyTaskComplete as ReturnType<typeof vi.fn>;

function definition(): CronJobDefinition {
  return {
    id: 'job-1',
    name: '整理邮件',
    action: { type: 'agent', agentType: 'default', prompt: '整理' },
  } as CronJobDefinition;
}

function execution(
  error: string,
  status: CronJobExecution['status'] = 'failed',
  result?: unknown,
): CronJobExecution {
  return {
    id: 'execution-1',
    jobId: 'job-1',
    status,
    scheduledAt: 1,
    retryAttempt: 0,
    sessionId: 'session-1',
    duration: 12,
    error,
    ...(result === undefined ? {} : { result }),
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

// N-CRON-RESTATE-HUMAN-WHEN-FU1: notifyWhen 满足轮的完成通知正文 = <cron_alert> 内的
// 一句话原因（去壳），不再是通用「定时任务已完成」——被打断的用户直接看到为何而通知。
describe('notifyCronAgentExecution 成功正文带 cron_alert 原因', () => {
  const reason = '今日值班交接中存在紧急事项：生产服务器宕机，需要立即处理';
  const notifyWhenAction = { agentType: 'default', prompt: '整理', notifyWhen: '紧急才通知' };

  it('结果带 alertReason 时 summary 就是原因本身（无标签壳）', () => {
    const result = buildCronAgentActionResult(
      notifyWhenAction, undefined, 'session-1',
      `例行内容\n<cron_alert>${reason}</cron_alert>`, false, false,
    );
    notifyCronAgentExecution(
      definition(),
      execution('', 'completed', result),
      new CronFailureNoticeGate(),
    );
    const payload = notify.mock.calls[0][0] as { summary?: string };
    expect(payload.summary).toBe(reason);
    expect(payload.summary).not.toContain('<cron_alert>');
  });

  it('结果没有 alertReason 时 summary 逐字保持「定时任务已完成」（无 notifyWhen 任务零扰动）', () => {
    notifyCronAgentExecution(
      definition(),
      execution('', 'completed', buildCronAgentActionResult(
        { agentType: 'default', prompt: '整理' }, undefined, 'session-1', '普通正文', false, false,
      )),
      new CronFailureNoticeGate(),
    );
    const payload = notify.mock.calls[0][0] as { summary?: string };
    expect(payload.summary).toBe('定时任务已完成');
  });

  it('空 <cron_alert></cron_alert> 提取为空不落键，summary 回落通用文案（永不空正文）', () => {
    notifyCronAgentExecution(
      definition(),
      execution('', 'completed', buildCronAgentActionResult(
        notifyWhenAction, undefined, 'session-1', '<cron_alert></cron_alert>', false, false,
      )),
      new CronFailureNoticeGate(),
    );
    const payload = notify.mock.calls[0][0] as { summary?: string };
    expect(payload.summary).toBe('定时任务已完成');
  });
});
