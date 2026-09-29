// ============================================================================
// CronService 失败韧性（N-CRON-RESILIENCE ①~⑤）：
// 指数退避序列 / 同因失败单次告警 / 容量等待不计失败 / permanent 即停 /
// misfire 宽限窗补跑 / 重启对账幂等 / every-hours 稳定错峰
// ============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  cronRows: [] as unknown[],
  runs: [] as Array<{ sql: string; args: unknown[] }>,
  executionRows: [] as Array<Record<string, unknown>>,
}));

const automationState = vi.hoisted(() => ({
  recordCreated: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
  getBySourceRef: vi.fn(() => null),
  upsert: vi.fn(() => undefined),
}));

const notifyState = vi.hoisted(() => ({
  notifyTaskComplete: vi.fn(),
}));

const CRON_EXECUTION_COLUMNS = [
  'id', 'job_id', 'session_id', 'status', 'scheduled_at', 'started_at',
  'completed_at', 'duration', 'result', 'error', 'retry_attempt', 'exit_code',
] as const;

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: (sql: string) => ({
        all: () => (sql.includes('FROM cron_jobs') ? dbState.cronRows : []),
        get: () => undefined,
        run: (...args: unknown[]) => {
          dbState.runs.push({ sql, args });
          if (sql.includes('UPDATE cron_executions') && sql.includes("'interrupted'")) {
            return { changes: 0, lastInsertRowid: 0 };
          }
          if (sql.includes('INSERT OR REPLACE INTO cron_executions')) {
            const row: Record<string, unknown> = {};
            CRON_EXECUTION_COLUMNS.forEach((col, i) => { row[col] = args[i]; });
            const idx = dbState.executionRows.findIndex((r) => r.id === row.id);
            if (idx >= 0) dbState.executionRows[idx] = row; else dbState.executionRows.push(row);
          }
          return { changes: 1, lastInsertRowid: 0 };
        },
      }),
    }),
  }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({ ui: { language: 'zh' } }),
  }),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: notifyState.notifyTaskComplete },
}));

import { CronService } from '../../../src/host/cron/cronService';
import { CRON_GUARDRAILS } from '../../../src/shared/constants';
import { suggestCronStaggerMinute } from '../../../src/shared/cronStagger';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

const NOW = Date.UTC(2026, 8, 29, 9, 3, 0);

afterEach(() => {
  vi.useRealTimers();
  dbState.cronRows = [];
  dbState.runs = [];
  dbState.executionRows = [];
  notifyState.notifyTaskComplete.mockClear();
  automationState.upsert.mockClear();
});

type ExecuteActionPatch = (definition: CronJobDefinition, action: unknown, timeout?: number, executionId?: string) => Promise<unknown>;

/** 注入 executeAction 行为：不真起进程，精确控制失败/成功与失败消息。 */
function patchExecuteAction(service: CronService, impl: ExecuteActionPatch): {
  calls: () => number;
} {
  let calls = 0;
  (service as unknown as { executeAction: ExecuteActionPatch }).executeAction = async (...args: Parameters<ExecuteActionPatch>) => {
    calls += 1;
    return impl(...args);
  };
  return { calls: () => calls };
}

function recurringShellJob(overrides: Partial<{ maxRetries: number; command: string }> = {}) {
  return {
    name: '韧性测试任务',
    scheduleType: 'every' as const,
    schedule: { type: 'every' as const, interval: 12, unit: 'hours' as const },
    action: { type: 'shell' as const, command: overrides.command ?? 'exit 1' },
    enabled: true,
    ...(overrides.maxRetries != null ? { maxRetries: overrides.maxRetries } : {}),
  };
}

describe('③ 失败按指数退避重试（注入连续失败断言退避序列）', () => {
  it('transient 失败的重试间隔序列 30s → 60s → 120s（替换旧的固定 5s）', async () => {
    vi.useFakeTimers();
    const service = new CronService();
    const job = await service.createJob(recurringShellJob({ maxRetries: 3 }));
    const { calls } = patchExecuteAction(service, async () => {
      throw new Error('ECONNRESET: socket hang up');
    });

    const settled = service.triggerJob(job.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1); // 首次失败，进入第一次退避等待

    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls()).toBe(1); // 30s 未到不重试
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(2); // 30s：第 1 次重试

    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls()).toBe(2); // 60s 未到不重试
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(3); // 60s：第 2 次重试

    await vi.advanceTimersByTimeAsync(119_999);
    expect(calls()).toBe(3); // 120s 未到不重试
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(4); // 120s：第 3 次重试（预算耗尽）

    const execution = (await settled)!;
    expect(execution.status).toBe('failed');
    expect(execution.retryAttempt).toBe(3);
    await service.shutdown();
  });

  it('显式配置的 retryDelay 仍优先于退避序列（契约字段不动）', async () => {
    vi.useFakeTimers();
    const service = new CronService();
    const job = await service.createJob({ ...recurringShellJob({ maxRetries: 1 }), retryDelay: 7_000 });
    const { calls } = patchExecuteAction(service, async () => {
      throw new Error('boom');
    });

    const settled = service.triggerJob(job.id);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(calls()).toBe(1); // 自定义间隔未到不重试
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(2); // 7s 自定义间隔到点（而非 30s 退避）

    const execution = (await settled)!;
    expect(execution.status).toBe('failed');
    expect(execution.retryAttempt).toBe(1);
    await service.shutdown();
  });

  it('退避途中一次成功即完成，不再继续重试（成功重置）', async () => {
    vi.useFakeTimers();
    const service = new CronService();
    const job = await service.createJob(recurringShellJob({ maxRetries: 3 }));
    let calls = 0;
    patchExecuteAction(service, async () => {
      calls += 1;
      if (calls <= 2) throw new Error('transient blip');
      return { ok: true };
    });

    const execution = (await (async () => {
      const settled = service.triggerJob(job.id);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(60_000);
      return settled;
    })())!;

    expect(calls).toBe(3);
    expect(execution.status).toBe('completed');
    expect(execution.retryAttempt).toBe(2);
    await service.shutdown();
  });
});

describe('①③ 同因失败去重后告警：单次告警 + 冷却窗', () => {
  function agentJob() {
    return {
      name: '会失败的 agent 任务',
      scheduleType: 'every' as const,
      schedule: { type: 'every' as const, interval: 12, unit: 'hours' as const },
      action: { type: 'agent' as const, agentType: 'default', prompt: '巡检一下' },
      enabled: true,
    };
  }

  it('同因失败连告警只发一次；第 5 次连败停用通知必发且带出路', async () => {
    const service = new CronService();
    const job = await service.createJob(agentJob());
    const agentFailure = Object.assign(
      new Error('provider 502: upstream broken'),
      { cronSessionId: 'cron-agent-session-1' },
    );
    patchExecuteAction(service, async () => { throw agentFailure; });

    for (let i = 0; i < CRON_GUARDRAILS.MAX_CONSECUTIVE_FAILURES; i++) {
      await service.triggerJob(job.id);
    }

    expect(service.getJob(job.id)!.enabled).toBe(false);

    const summaries = notifyState.notifyTaskComplete.mock.calls.map((call) => String(call[0]?.summary));
    const failureAlerts = summaries.filter((s) => s.startsWith('定时任务失败'));
    const disableAlerts = summaries.filter((s) => s.includes('已自动停用'));
    // 同因失败告警 5 次执行只发 1 次（冷却窗内去重）
    expect(failureAlerts).toHaveLength(1);
    // 最终停用通知不受冷却约束，且带出路
    expect(disableAlerts).toHaveLength(1);
    expect(disableAlerts[0]).toContain('自动化中心');
    expect(disableAlerts[0]).toContain('provider 502: upstream broken');
    await service.shutdown();
  });

  it('停用前成功一次会重置连败计数（不误停）', async () => {
    const service = new CronService();
    const job = await service.createJob(agentJob());
    let calls = 0;
    patchExecuteAction(service, async () => {
      calls += 1;
      if (calls === CRON_GUARDRAILS.MAX_CONSECUTIVE_FAILURES) {
        return { agentType: 'default', prompt: 'p', result: undefined, sessionId: 'cron-agent-session-1' };
      }
      throw Object.assign(new Error('flaky provider error'), { cronSessionId: 'cron-agent-session-1' });
    });

    for (let i = 0; i < CRON_GUARDRAILS.MAX_CONSECUTIVE_FAILURES; i++) {
      await service.triggerJob(job.id);
    }
    expect(service.getJob(job.id)!.enabled).toBe(true);
    await service.shutdown();
  });
});

describe('⑤ 容量/并发等待不计失败不计重试（Cline 实付回归）', () => {
  it('排队等容量被中断 → cancelled，不进重试、不停用、不计连败', async () => {
    const service = new CronService();
    const job = await service.createJob(recurringShellJob({ maxRetries: 3 }));
    const { calls } = patchExecuteAction(service, async () => {
      throw new Error('Request was cancelled while waiting');
    });

    const execution = (await service.triggerJob(job.id))!;

    expect(execution.status).toBe('cancelled');
    expect(calls()).toBe(1); // 没有烧掉任何一次重试
    expect(execution.retryAttempt).toBe(0);
    expect(service.getJob(job.id)!.enabled).toBe(true);
    // cancelled 不进失败告警通道
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();
    await service.shutdown();
  });
});

describe('② permanent 错误：重试无用，首次即停用并告知', () => {
  it.each([
    ['自有错误码 unsupported_action', new Error('unsupported_action')],
    ['配置校验错', new Error('Unsupported interval unit "weeks"; cron cannot express it.')],
    ['预算硬顶', new Error('Cron job run exceeded its $1.50 budget limit.')],
    ['无人值守停车码', new Error('UNATTENDED_APPROVAL_TIMEOUT')],
  ])('%s → 直接 failed + enabled=0 + 带出路通知，不重试', async (_label, error) => {
    const service = new CronService();
    const job = await service.createJob(recurringShellJob({ maxRetries: 3 }));
    const { calls } = patchExecuteAction(service, async () => { throw error; });

    const execution = (await service.triggerJob(job.id))!;

    expect(execution.status).toBe('failed');
    expect(calls()).toBe(1); // permanent 不烧重试
    expect(execution.retryAttempt).toBe(0);
    expect(service.getJob(job.id)!.enabled).toBe(false);

    const summaries = notifyState.notifyTaskComplete.mock.calls.map((call) => String(call[0]?.summary));
    const disableAlerts = summaries.filter((s) => s.includes('停用'));
    expect(disableAlerts).toHaveLength(1);
    expect(disableAlerts[0]).toContain('重试无效');
    expect(disableAlerts[0]).toContain('自动化中心');
    await service.shutdown();
  });
});

describe('④ misfire 宽限窗（循环任务错过：窗内照跑，超窗 skipped 不补跑）', () => {
  it('上一 tick 在 5 分钟宽限窗内：启动即补跑这一趟', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW); // 09:03，'*/5' 的上一 tick 是 09:00（3 分钟前，窗内）
    dbState.cronRows = [{
      id: 'job-grace-recurring',
      name: '刚错过的循环任务',
      description: null,
      schedule_type: 'cron',
      schedule: JSON.stringify({ type: 'cron', expression: '*/5 * * * *' }),
      action: JSON.stringify({ type: 'shell', command: 'echo ok' }),
      enabled: 1,
      max_retries: 0,
      retry_delay: 5000,
      timeout: 60000,
      tags: null,
      metadata: '{}',
      created_at: NOW - 60 * 60_000,
      updated_at: NOW - 60 * 60_000,
    }];

    const service = new CronService();
    patchExecuteAction(service, async () => ({ ok: true }));
    await service.initialize();
    await vi.advanceTimersByTimeAsync(1); // catch-up 是 fire-and-forget

    const rows = dbState.executionRows.filter((row) => row.job_id === 'job-grace-recurring');
    expect(rows).toHaveLength(1); // 补跑了一趟
    expect(rows[0].status).toBe('completed');
    // 之后的正常 tick 仍按计划（09:05）
    expect(service.getJob('job-grace-recurring')!.nextRunAt).toBe(NOW + 2 * 60_000);
    await service.shutdown();
  });

  it('上一 tick 超出宽限窗：不补跑，走既有 missed 留痕（skipped）', async () => {
    vi.useFakeTimers();
    // 09:07，小时整点任务（'0 * * * *'）的上一 tick 是 09:00（7 分钟前，超窗）。
    // 高频表达式的上一 tick 总在几分钟内，只有小时级以上才天然演示「离线错过」。
    const staleNow = Date.UTC(2026, 8, 29, 9, 7, 0);
    vi.setSystemTime(staleNow);
    dbState.cronRows = [{
      id: 'job-stale-recurring',
      name: '离线很久的循环任务',
      description: null,
      schedule_type: 'cron',
      schedule: JSON.stringify({ type: 'cron', expression: '0 * * * *' }),
      action: JSON.stringify({ type: 'shell', command: 'echo ok' }),
      enabled: 1,
      max_retries: 0,
      retry_delay: 5000,
      timeout: 60000,
      tags: null,
      metadata: '{}',
      created_at: staleNow - 24 * 60 * 60_000,
      updated_at: staleNow - 24 * 60 * 60_000,
    }];

    const service = new CronService();
    patchExecuteAction(service, async () => ({ ok: true }));
    await service.initialize();
    await vi.advanceTimersByTimeAsync(1);

    // 没有补跑
    expect(dbState.executionRows.filter((row) => row.job_id === 'job-stale-recurring')).toHaveLength(0);
    // 走了 missed 留痕（automation upsert 带 missedNotice）
    expect(automationState.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cron:job-stale-recurring',
    }));
    await service.shutdown();
  });
});

describe('⑤ 重启对账幂等：合并已有任务，禁止删旧建新（Cline 实付回归）', () => {
  it('重启加载回来的任务仍走退避（未显式配置 retryDelay 不落 5000 默认）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dbState.cronRows = [{
      id: 'job-restart-backoff',
      name: '重启后的退避任务',
      description: null,
      schedule_type: 'every',
      schedule: JSON.stringify({ type: 'every', interval: 2, unit: 'hours' }),
      action: JSON.stringify({ type: 'shell', command: 'echo ok' }),
      enabled: 1,
      max_retries: 1,
      retry_delay: null, // 未显式配置：持久层不再写死 5000 默认
      timeout: 60000,
      tags: null,
      metadata: '{}',
      cloud_job_id: null,
      created_at: NOW - 60 * 60_000,
      updated_at: NOW - 60 * 60_000,
    }];

    const service = new CronService();
    await service.initialize();
    const { calls } = patchExecuteAction(service, async () => {
      throw new Error('ECONNRESET: socket hang up');
    });

    const settled = service.triggerJob('job-restart-backoff');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls()).toBe(1); // 旧固定 5s 已废
    await vi.advanceTimersByTimeAsync(25_001);
    expect(calls()).toBe(2); // 30s 退避到点

    const execution = (await settled)!;
    expect(execution.retryAttempt).toBe(1);
    await service.shutdown();
  });

  it('R2：存量任务 retry_delay=5000（旧版默认）视为未设置，失败后走退避 30s→60s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // every 60 minutes → '0 */60 * * * *'（整点触发，NOW=09:03，下一次 10:00，
    // 远离本测试 ~90s 的推进窗口，不会混进计划 tick）
    dbState.cronRows = [{
      id: 'job-legacy-5000',
      name: '旧默认 5s 的存量任务',
      description: null,
      schedule_type: 'every',
      schedule: JSON.stringify({ type: 'every', interval: 60, unit: 'minutes' }),
      action: JSON.stringify({ type: 'shell', command: 'echo ok' }),
      enabled: 1,
      max_retries: 2,
      retry_delay: 5000, // 旧版 `|| 5000` + schema DEFAULT 5000 写下的存量值
      timeout: 60000,
      tags: null,
      metadata: '{}',
      cloud_job_id: null,
      created_at: NOW - 60 * 60_000,
      updated_at: NOW - 60 * 60_000,
    }];

    const service = new CronService();
    await service.initialize();
    // 读侧把旧默认视为未设置（显式 retryDelay 语义只剩新代码显式写下的值）
    expect(service.getJob('job-legacy-5000')!.retryDelay).toBeUndefined();
    const { calls } = patchExecuteAction(service, async () => {
      throw new Error('ECONNRESET: socket hang up');
    });

    const settled = service.triggerJob('job-legacy-5000');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(calls()).toBe(1); // 旧默认 5s 不再钉死重试间隔
    await vi.advanceTimersByTimeAsync(24_001);
    expect(calls()).toBe(2); // 30s：第 1 次退避重试
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls()).toBe(2); // 60s 未到不重试
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(3); // 60s：第 2 次退避重试（预算耗尽）

    const execution = (await settled)!;
    expect(execution.status).toBe('failed');
    expect(execution.retryAttempt).toBe(2);
    await service.shutdown();
  });

  it('两次 initialize 后任务原样保留：同 id、同调度、同 enabled、nextRun 不漂移', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dbState.cronRows = [{
      id: 'job-restart-stable',
      name: '重启幸存者',
      description: null,
      schedule_type: 'every',
      schedule: JSON.stringify({ type: 'every', interval: 2, unit: 'hours' }),
      action: JSON.stringify({ type: 'shell', command: 'echo ok' }),
      enabled: 1,
      max_retries: 0,
      retry_delay: 5000,
      timeout: 60000,
      tags: null,
      metadata: '{}',
      cloud_job_id: null,
      created_at: NOW - 60 * 60_000,
      updated_at: NOW - 60 * 60_000,
    }];

    const first = new CronService();
    await first.initialize();
    const before = first.getJob('job-restart-stable')!;
    expect(before.enabled).toBe(true);
    await first.shutdown();

    dbState.runs = []; // 第二次启动从零记账：重启期间不允许写 cron_jobs
    const second = new CronService();
    await second.initialize();

    const after = second.getJob('job-restart-stable')!;
    expect(second.listJobs()).toHaveLength(1); // 没有多出来的重建副本
    expect(after.id).toBe(before.id); // 不是删旧建新（新 uuid）
    expect(after.schedule).toEqual(before.schedule);
    expect(after.enabled).toBe(true);
    expect(after.nextRunAt).toBe(before.nextRunAt); // 错峰分钟稳定，触发计划不漂移

    // 对账只读：没有 DELETE，也没有重写 cron_jobs 行
    const jobWrites = dbState.runs.filter((run) => run.sql.includes('cron_jobs'));
    expect(jobWrites).toHaveLength(0);
    await second.shutdown();
  });
});

describe('R2：jitter 窗口（最长 15min）内任务被停用/编辑 → 不拿闭包里的过期 definition 执行', () => {
  // every 1 minute → '0 */1 * * * *'，每分钟 :00 触发；jitter 窗口 = 60s×10% = 6s，
  // Math.random 固定 0.5 → jitter 恒 3s。NOW=09:03:00，首个 tick 09:04:00。
  function agentMinuteJob() {
    return {
      name: 'jitter 窗口任务',
      scheduleType: 'every' as const,
      schedule: { type: 'every' as const, interval: 1, unit: 'minutes' as const },
      action: { type: 'agent' as const, agentType: 'default', prompt: '旧 prompt' },
      enabled: true,
    };
  }

  it('jitter 等待期间任务被停用 → 等待结束不执行（无执行记录，不计失败）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter 恒 3s
    const service = new CronService();
    const job = await service.createJob(agentMinuteJob());
    const { calls } = patchExecuteAction(service, async () => ({ ok: true }));

    await vi.advanceTimersByTimeAsync(60_000); // 09:04:00 tick，进入 3s jitter 等待
    expect(calls()).toBe(0); // jitter 未耗尽，还没执行
    await service.updateJob(job.id, { enabled: false }); // 等待期间停用
    await vi.advanceTimersByTimeAsync(3_000); // jitter 耗尽

    expect(calls()).toBe(0); // 停用了就不再执行（HEAD 红：拿旧闭包照样跑）
    expect(dbState.executionRows.filter((row) => row.job_id === job.id)).toHaveLength(0);
    randSpy.mockRestore();
    await service.shutdown();
  });

  it('jitter 等待期间改了 prompt → 等待结束用最新 definition 执行（新 prompt 生效）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const service = new CronService();
    const job = await service.createJob(agentMinuteJob());
    let executedPrompt: string | undefined;
    patchExecuteAction(service, async (_definition, action) => {
      executedPrompt = (action as { prompt: string }).prompt;
      return { ok: true };
    });

    await vi.advanceTimersByTimeAsync(60_000); // tick → 3s jitter 等待
    await service.updateJob(job.id, {
      action: { ...job.action, prompt: '新 prompt' },
    });
    await vi.advanceTimersByTimeAsync(3_000); // jitter 耗尽

    expect(executedPrompt).toBe('新 prompt'); // HEAD 红：闭包里还是旧 prompt
    randSpy.mockRestore();
    await service.shutdown();
  });
});

describe('② every 小时/天级任务默认分钟按 jobId 哈希稳定错峰', () => {
  it('every 1 hour 的触发分钟 = suggestCronStaggerMinute(jobId)，非整点且重注册不漂移', async () => {
    const service = new CronService();
    const job = await service.createJob(recurringShellJob());

    const expectedMinute = suggestCronStaggerMinute(job.id);
    expect(expectedMinute).toBeGreaterThan(0); // 1..59，不落 :00
    const nextRun = service.getJob(job.id)!.nextRunAt!;
    expect(new Date(nextRun).getMinutes()).toBe(expectedMinute);

    // updateJob 会重注册 croner 实例：分钟必须稳定（jobId 哈希）
    await service.updateJob(job.id, { name: '改名后的任务' });
    expect(new Date(service.getJob(job.id)!.nextRunAt!).getMinutes()).toBe(expectedMinute);
    await service.shutdown();
  });

  it('every 分钟级任务的步进语义不受错峰影响（仍是每 N 分钟）', async () => {
    const service = new CronService();
    const job = await service.createJob({
      name: '分钟级任务',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 5, unit: 'minutes' },
      action: { type: 'shell', command: 'echo ok' },
      enabled: true,
    });
    const instance = (service as unknown as {
      jobs: Map<string, { cronInstance?: { nextRuns: (n: number) => Date[] } }>;
    }).jobs.get(job.id)?.cronInstance;
    const runs = instance!.nextRuns(3);
    const gaps = runs.slice(1).map((d, i) => d.getTime() - runs[i].getTime());
    expect(gaps.every((gap) => gap === 5 * 60_000)).toBe(true);
    await service.shutdown();
  });
});
