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
import { CronCloudRuntime } from '../../../src/host/cron/cronCloudRuntime';
import { buildCronAgentActionResult } from '../../../src/host/cron/cronNormalizers';
import { buildCronLoginWallStopCode } from '../../../src/shared/utils/browserLoginWall';
import { CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH } from '../../../src/shared/utils/cronCloudUnavailable';

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

/**
 * 真实落库路径（FU1）：CronCloudRuntime.recordFailure 在 fetch 打不通时写下的 execution，
 * 报文是 unavailableMessage 固定句、天然没有 sessionId——不手拼对象，notify 策略门读到
 * 什么就断言什么。
 */
async function cloudDownExecution(): Promise<CronJobExecution> {
  const executions: CronJobExecution[] = [];
  const runtime = new CronCloudRuntime(
    () => ({ baseUrl: 'https://cron.example.test', token: 'secret-token' }),
    {
      getJobs: () => [],
      persistJob: async () => {},
      persistExecution: async (record) => { executions.push(record); },
      loadExecutionStatus: () => undefined,
      onCompleted: async () => {},
      unavailableMessage: () => CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH,
    },
    vi.fn(async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch,
  );
  await runtime.addJob(definition());
  const [record] = executions;
  if (!record) throw new Error('recordFailure did not persist an execution');
  return record;
}

/** 无会话执行的负例形状：其余失败类别在没有 sessionId 时仍要静默（没有点击落点）。 */
function sessionlessExecution(error: string): CronJobExecution {
  const record = execution(error);
  delete record.sessionId;
  return record;
}

// N-CRON-FAIL-PLAIN-CLOUD-DOWN-FU1：云端执行不带 sessionId（cron_executions.session_id
// 是本地 sessions 外键），策略门此前对它一律早退——云端调度器不可用的失败被静默吞掉。
describe('notifyCronAgentExecution 无会话云端失败', () => {
  it('无 sessionId 的 cloud_unavailable 失败照发：带 failureKind/jobId，sessionId 空串', async () => {
    notifyCronAgentExecution(definition(), await cloudDownExecution(), new CronFailureNoticeGate());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: '',
      jobId: 'job-1',
      code: 'CRON_FAILURE',
      failureKind: 'cloud_unavailable',
      succeeded: false,
    }), { force: true });
  });

  it('同因云端失败冷却窗内只告警一次（复用既有 CronFailureNoticeGate 去重）', async () => {
    const gate = new CronFailureNoticeGate();
    notifyCronAgentExecution(definition(), await cloudDownExecution(), gate);
    notifyCronAgentExecution(definition(), await cloudDownExecution(), gate);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('无 sessionId 的其他失败仍静默（没有落点的告警不放行）', () => {
    notifyCronAgentExecution(definition(), sessionlessExecution('fetch failed'), new CronFailureNoticeGate());
    notifyCronAgentExecution(definition(), sessionlessExecution('429 Too Many Requests'), new CronFailureNoticeGate());
    expect(notify).not.toHaveBeenCalled();
  });

  it('带 sessionId 的 cloud_unavailable 失败载荷不变（既有路径零扰动）', () => {
    notifyCronAgentExecution(
      definition(),
      execution(CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH),
      new CronFailureNoticeGate(),
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      code: 'CRON_FAILURE',
      failureKind: 'cloud_unavailable',
    }), { force: true });
  });
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
