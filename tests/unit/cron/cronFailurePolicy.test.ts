// ============================================================================
// CronFailurePolicy 单测（N-CRON-RESILIENCE ①②③）：
// 退避序列 / 错误分类判据 / 失败通知去重+冷却 / 连败计数
// + notifyWhen 通知门（N-CRON-RESTATE-HUMAN-WHEN）
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
const notifyState = vi.hoisted(() => ({ notifyTaskComplete: vi.fn() }));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: configState.language } }) }),
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: notifyState.notifyTaskComplete },
}));
// buildMaxRunsDisabledSummary / buildBudgetDisabledSummary 都读 ui.language 决定停用文案语言；
// 单测默认固定中文（configState.language 重置点在下方全局 afterEach），预算用例按 it.each 切 en。

import {
  classifyCronFailure,
  countTrailingCronFailures,
  cronNotifyQuietRound,
  cronRetryBackoffMs,
  CronFailureNoticeGate,
  cronDisableReasonForFailure,
  notifyCronAgentExecution,
  notifyCronJobDisabled,
} from '../../../src/host/cron/cronFailurePolicy';
import { buildCronAgentActionResult, cronAgentRunHasAlert } from '../../../src/host/cron/cronNormalizers';
import { CRON_GUARDRAILS } from '../../../src/shared/constants';
import type { CronJobDefinition, CronJobExecution } from '../../../src/shared/contract/cron';
import { buildCronLoginWallStopCode } from '../../../src/shared/utils/browserLoginWall';
import { CRON_CLOUD_UNAVAILABLE_MESSAGE_EN } from '../../../src/shared/utils/cronCloudUnavailable';

afterEach(() => {
  configState.language = 'zh';
  notifyState.notifyTaskComplete.mockClear();
});

describe('cronRetryBackoffMs：指数退避序列', () => {
  it('30s → 60s → 120s → 240s（BASE×FACTOR^(n-1)）', () => {
    expect(cronRetryBackoffMs(1)).toBe(30_000);
    expect(cronRetryBackoffMs(2)).toBe(60_000);
    expect(cronRetryBackoffMs(3)).toBe(120_000);
    expect(cronRetryBackoffMs(4)).toBe(240_000);
  });

  it('封顶 MAX_INTERVAL=15min', () => {
    expect(cronRetryBackoffMs(5)).toBe(480_000);
    // 第 6 档原始值 960s 已越上限，收到 900s
    expect(cronRetryBackoffMs(6)).toBe(CRON_GUARDRAILS.RETRY_BACKOFF_MAX_INTERVAL_MS);
    expect(cronRetryBackoffMs(50)).toBe(CRON_GUARDRAILS.RETRY_BACKOFF_MAX_INTERVAL_MS);
  });

  it('非法输入按首次处理（不炸）', () => {
    expect(cronRetryBackoffMs(0)).toBe(CRON_GUARDRAILS.RETRY_BACKOFF_BASE_MS);
    expect(cronRetryBackoffMs(-3)).toBe(CRON_GUARDRAILS.RETRY_BACKOFF_BASE_MS);
  });
});

describe('classifyCronFailure：错误分类判据（集中一处）', () => {
  it('排队等容量/并发槽被中断 → capacity-wait（不计失败不计重试）', () => {
    expect(classifyCronFailure('Request was cancelled while waiting')).toBe('capacity-wait');
    expect(classifyCronFailure('agent call aborted while queued')).toBe('capacity-wait');
    expect(classifyCronFailure('agent call aborted before admission')).toBe('capacity-wait');
  });

  it('budget permanent failures select the budget notification branch, including legacy messages', () => {
    expect(cronDisableReasonForFailure(new Error('Cron job run exceeded its $0.01 budget limit (spent $0.0234).'))).toBe('budget');
    expect(cronDisableReasonForFailure('Cron job run exceeded its $0.01 budget limit.')).toBe('budget');
    expect(cronDisableReasonForFailure(new Error('unsupported_action'))).toBe('permanent');
  });

  it('自有错误码/配置校验/预算/无人值守停车 → permanent（重试无用）', () => {
    expect(classifyCronFailure('unsupported_action')).toBe('permanent');
    expect(classifyCronFailure('Unknown action type')).toBe('permanent');
    expect(classifyCronFailure('Unsupported interval unit "weeks"; cron cannot express it.')).toBe('permanent');
    expect(classifyCronFailure('定时任务时间已过去（2026/9/29 上午8:00:00），请改成将来的时间')).toBe('permanent');
    expect(classifyCronFailure('UNATTENDED_APPROVAL_TIMEOUT')).toBe('permanent');
    expect(classifyCronFailure('DOOM_LOOP_HANDBACK_STOP')).toBe('permanent');
    expect(classifyCronFailure('Cron job run exceeded its $1.50 budget limit.')).toBe('permanent');
    expect(classifyCronFailure('成本超限：单 case 实际成本 $2 超过上限 $1')).toBe('permanent');
    expect(classifyCronFailure('runsOn is immutable after creation')).toBe('permanent');
  });

  it('无人值守登录墙 → login-wall（停本趟但不走永久停用）', () => {
    expect(classifyCronFailure(buildCronLoginWallStopCode('https://example.test'))).toBe('login-wall');
  });

  it('R2 审查三个误判样例（execAsync message 含命令原文与 stderr）→ transient', () => {
    // 样例 1：shell 任务遇到临时 403 限流（curl GitHub API，message 含命令原文 + 响应体）
    expect(classifyCronFailure(
      'Command failed: curl -sS https://api.github.com/repos/foo/bar\n'
      + '{"message":"API rate limit exceeded for 203.0.113.7. (403)",'
      + '"documentation_url":"https://developer.github.com/v3/#rate-limiting"}',
    )).toBe('transient');
    // 样例 2：command not found（stderr 文本，命令装好前重试有意义）
    expect(classifyCronFailure(
      'Command failed: ./scripts/deploy.sh\n/bin/sh: ./scripts/deploy.sh: command not found',
    )).toBe('transient');
    // 样例 3：命令原文本身含 "not found"，grep 无匹配退出码 1
    expect(classifyCronFailure(
      "Command failed: grep 'not found' /var/log/app.log",
    )).toBe('transient');
    // shell 输出里哪怕撞上我们自己的 permanent 文案（预算护栏），^Command failed: 前缀也一票否决
    expect(classifyCronFailure(
      'Command failed: ./check-budget.sh\n成本超限：本月预算已用尽',
    )).toBe('transient');
  });

  it('鉴权/不存在类文本不再判 permanent：无法与外部文本区分 → 退避 + 连败停用（基线行为）', () => {
    // HTTP 401/403、"not found" 会出现在 shell 命令原文与外部 stderr 里（上面的样例），
    // 按文本判 permanent 会误停用正常任务；宁可多退避，连败到阈值再停。
    expect(classifyCronFailure(new Error('401 Unauthorized: invalid api key'))).toBe('transient');
    expect(classifyCronFailure(new Error('403 Forbidden'))).toBe('transient');
    expect(classifyCronFailure(new Error('Cron job xyz not found'))).toBe('transient');
    expect(classifyCronFailure('Cloud cron API request failed (HTTP 404)')).toBe('transient');
  });

  it('网络/超时/限流/云端暂不可用 → transient（默认走退避）', () => {
    expect(classifyCronFailure(new Error('ECONNRESET: socket hang up'))).toBe('transient');
    expect(classifyCronFailure(new Error('ETIMEDOUT after 30000ms'))).toBe('transient');
    expect(classifyCronFailure(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe('transient');
    expect(classifyCronFailure(new Error('429 Too Many Requests'))).toBe('transient');
    expect(classifyCronFailure('云端计划任务服务暂时不可用，任务未执行。请检查云端执行地址和令牌后重试。')).toBe('transient');
    // 展示层新增 cloud_unavailable 后，host 策略分类口径不变：英文固定句同样走 transient 退避。
    expect(classifyCronFailure(CRON_CLOUD_UNAVAILABLE_MESSAGE_EN)).toBe('transient');
    expect(classifyCronFailure(new Error('Command failed: exit 1'))).toBe('transient');
  });
});

describe('notifyCronJobDisabled：预算 / permanent / max_runs 文案', () => {
  const definition = {
    id: 'job-budget',
    name: '预算任务',
    scheduleType: 'every' as const,
    schedule: { type: 'every' as const, interval: 1, unit: 'hours' as const },
    action: { type: 'shell' as const, command: 'echo ok' },
    runsOn: 'local' as const,
    maxRunBudget: 0.01,
    maxRuns: 2,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const execution = (error?: string): CronJobExecution => ({
    id: 'execution-budget',
    jobId: definition.id,
    status: 'failed',
    scheduledAt: 1,
    retryAttempt: 0,
    ...(error ? { error } : {}),
  });

  it.each([
    ['zh', '本次运行花费 $0.0234，超过了你设的单次预算上限 $0.01，任务已自动停用。可在「自动化中心 → 定时任务」编辑该任务，调高「单次预算上限 (USD)」后重新启用。'],
    ['en', 'This run spent $0.0234, over your per-run budget cap of $0.01, so the task was disabled. Raise "Per-run budget cap (USD)" under Automation Center → Scheduled tasks and re-enable it.'],
  ] as const)('%s budget copy includes spend, cap, and re-enable path', (language, expected) => {
    configState.language = language;
    notifyCronJobDisabled(
      definition,
      execution('Cron job run exceeded its $0.01 budget limit (spent $0.0234).'),
      'budget',
    );
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expected }),
      { force: true },
    );
    expect(expected).not.toContain('config/auth');
    expect(expected).not.toContain('exceeded its $');
  });

  it('legacy budget copy drops the unparseable spend and the other branches keep their copy', () => {
    notifyCronJobDisabled(definition, execution('Cron job run exceeded its $0.01 budget limit.'), 'budget');
    notifyCronJobDisabled(definition, execution('unsupported_action'), 'permanent');
    notifyCronJobDisabled(definition, execution(), 'max_runs');
    const summaries = notifyState.notifyTaskComplete.mock.calls.map((call) => String(call[0]?.summary));
    expect(summaries[0]).toBe('本次运行超过了你设的单次预算上限 $0.01，任务已自动停用。可在「自动化中心 → 定时任务」编辑该任务，调高「单次预算上限 (USD)」后重新启用。');
    expect(summaries[1]).toContain('因配置/鉴权类错误停用');
    expect(summaries[2]).toContain('已达运行次数上限（2 次）已自动停用');
  });

  it('real-run shape: cause-chain suffix after the budget message still maps to budget', () => {
    // 真跑实录（④）：execution.error 是 cronFailureSourceText 拼的 cause 链，
    // 预算消息后面跟着「成本超限：…」行——解析只认行首前缀，不许被尾巴顶回 permanent。
    const joined = 'Cron job run exceeded its $0.01 budget limit (spent $0.0141).\n成本超限：单 case 实际成本 $0.014143 超过上限 $0.010000';
    const reason = cronDisableReasonForFailure(joined);
    expect(reason).toBe('budget');
    notifyCronJobDisabled(definition, execution(joined), reason);
    const summary = String(notifyState.notifyTaskComplete.mock.calls[0][0]?.summary);
    expect(summary).toBe('本次运行花费 $0.0141，超过了你设的单次预算上限 $0.01，任务已自动停用。可在「自动化中心 → 定时任务」编辑该任务，调高「单次预算上限 (USD)」后重新启用。');
  });
});

describe('CronFailureNoticeGate：失败通知去重 + 冷却', () => {
  it('同 (jobId+错误) 冷却窗内只放行一次', () => {
    const gate = new CronFailureNoticeGate();
    const t0 = 1_000_000;
    expect(gate.shouldNotify('job-1', 'provider 502: bad gateway', t0)).toBe(true);
    expect(gate.shouldNotify('job-1', 'provider 502: bad gateway', t0 + 1)).toBe(false);
    expect(gate.shouldNotify('job-1', 'provider 502: bad gateway', t0 + 59 * 60_000)).toBe(false);
  });

  it('冷却窗过后再次放行', () => {
    const gate = new CronFailureNoticeGate();
    const t0 = 1_000_000;
    gate.shouldNotify('job-1', 'boom', t0);
    expect(gate.shouldNotify('job-1', 'boom', t0 + CRON_GUARDRAILS.FAILURE_NOTICE_COOLDOWN_MS)).toBe(true);
  });

  it('不同 jobId 或不同错误各自独立计数', () => {
    const gate = new CronFailureNoticeGate();
    const t0 = 1_000_000;
    expect(gate.shouldNotify('job-1', 'boom', t0)).toBe(true);
    expect(gate.shouldNotify('job-2', 'boom', t0)).toBe(true);
    expect(gate.shouldNotify('job-1', 'another failure', t0)).toBe(true);
  });

  it('归一化后同因的错误（数字/引号内容不同）算同一条', () => {
    const gate = new CronFailureNoticeGate();
    const t0 = 1_000_000;
    expect(gate.shouldNotify('job-1', 'timeout after 30000ms on "session-a"', t0)).toBe(true);
    expect(gate.shouldNotify('job-1', 'timeout after 61000ms on "session-z"', t0 + 5_000)).toBe(false);
  });
});

describe('countTrailingCronFailures：末尾连续失败', () => {
  const exec = (status: CronJobExecution['status'], error?: string): CronJobExecution => ({
    id: `exec-${status}-${Math.random()}`,
    jobId: 'job-x',
    status,
    scheduledAt: 0,
    retryAttempt: 0,
    ...(error ? { error } : {}),
  });

  it('末尾连续 failed 计数，遇非 failed 断链（成功即重置）', () => {
    expect(countTrailingCronFailures([])).toBe(0);
    expect(countTrailingCronFailures([exec('failed'), exec('failed')])).toBe(2);
    expect(countTrailingCronFailures([exec('failed'), exec('completed'), exec('failed')])).toBe(1);
    expect(countTrailingCronFailures([exec('cancelled'), exec('failed'), exec('failed')])).toBe(2);
  });

  it('R2 Nit-2：cancelled（等容量被中断）跳过不断链，失败与排队交替仍累计连败', () => {
    // 否则「失败一次→排队被中断→失败一次…」的任务连败永远到不了停用线
    expect(countTrailingCronFailures([exec('failed'), exec('cancelled'), exec('failed')])).toBe(2);
    expect(countTrailingCronFailures(
      [exec('cancelled'), exec('failed'), exec('cancelled'), exec('failed')],
    )).toBe(2);
  });

  it('N-CRON-LOGINWALL-STOP：登录墙失败不计入末尾连败', () => {
    const loginWall = buildCronLoginWallStopCode('https://example.test');
    expect(countTrailingCronFailures([exec('failed', loginWall), exec('failed', loginWall)])).toBe(0);
    expect(countTrailingCronFailures([exec('failed'), exec('failed', loginWall)])).toBe(1);
  });
});

// ============================================================================
// notifyWhen 通知门（N-CRON-RESTATE-HUMAN-WHEN）：
// 判据未满足的成功轮不发声（完成通知与通道推送都跳过，推送门在 cronService 源码
// 契约里钉死）；失败/登录墙通知永不被该门静音。
// ============================================================================
describe('cronNotifyQuietRound：notifyWhen 安静轮判定', () => {
  it('判据设置且无 <cron_alert> → true，并留一行可归因日志（含 job id）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(cronNotifyQuietRound({ notifyWhen: '只有紧急事项' }, false, 'job-9')).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[CronService] notify suppressed: notifyWhen not met job=job-9');
    } finally {
      warn.mockRestore();
    }
  });

  it('有 alert / 未设判据 / 空白判据 → false（既有任务行为零变化）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(cronNotifyQuietRound({ notifyWhen: '只有紧急事项' }, true, 'job-9')).toBe(false);
      expect(cronNotifyQuietRound({}, false, 'job-9')).toBe(false);
      expect(cronNotifyQuietRound({ notifyWhen: '   ' }, false, 'job-9')).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('notifyCronAgentExecution：notifySuppressed 完成通知门', () => {
  const agentDefinition = {
    id: 'job-nw',
    name: '晨报',
    action: { type: 'agent', agentType: 'default', prompt: '汇总', notifyWhen: '只有紧急事项' },
  } as unknown as CronJobDefinition;
  const action = { agentType: 'default', prompt: '汇总', notifyWhen: '只有紧急事项' };

  function execution(status: 'completed' | 'failed', result?: unknown, error?: string): CronJobExecution {
    return {
      id: `exec-${status}`,
      jobId: 'job-nw',
      status,
      scheduledAt: 0,
      startedAt: 0,
      completedAt: 1,
      duration: 1,
      retryAttempt: 0,
      sessionId: 'sess-1',
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
    } as CronJobExecution;
  }

  beforeEach(() => {
    notifyState.notifyTaskComplete.mockClear();
  });

  it('成功 + notifySuppressed 标记（判据未满足的安静轮）→ 不发完成通知', () => {
    notifyCronAgentExecution(
      agentDefinition,
      execution('completed', buildCronAgentActionResult(action, undefined, 'sess-1', '一切照旧', false, true)),
      new CronFailureNoticeGate(),
    );
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();
  });

  it('成功 + 无标记（判据满足/未设判据）→ 完成通知照发（force + urgent 直达）', () => {
    notifyCronAgentExecution(
      agentDefinition,
      execution('completed', buildCronAgentActionResult(action, undefined, 'sess-1', '<cron_alert>紧急</cron_alert>', false, false)),
      new CronFailureNoticeGate(),
    );
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    expect(notifyState.notifyTaskComplete.mock.calls[0]?.[1]).toEqual({ force: true, urgent: true });
  });

  it('must_today 与 alertReason 紧急，普通完成与 can_wait 不紧急', () => {
    const base = { agentType: 'default', prompt: '汇总', result: null, sessionId: 'sess-1' };
    for (const result of [
      base,
      { ...base, urgency: 'must_today' },
      { ...base, alertReason: '生产故障' },
      { ...base, urgency: 'can_wait' },
    ]) {
      notifyCronAgentExecution(agentDefinition, execution('completed', result), new CronFailureNoticeGate());
    }

    expect(notifyState.notifyTaskComplete.mock.calls.map((call) => call[1])).toEqual([
      { force: true, urgent: false },
      { force: true, urgent: true },
      { force: true, urgent: true },
      { force: true, urgent: false },
    ]);
  });

  it('失败告警永不被该门静音：失败执行照发（标记只可能出现在成功路径）', () => {
    notifyCronAgentExecution(agentDefinition, execution('failed', undefined, 'provider 500'), new CronFailureNoticeGate());
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    const payload = notifyState.notifyTaskComplete.mock.calls[0]?.[0] as { succeeded: boolean; summary: string };
    expect(payload.succeeded).toBe(false);
    expect(payload.summary).toContain('provider 500');
  });

  it('同因失败冷却照旧生效（与安静门正交）', () => {
    const gate = new CronFailureNoticeGate();
    notifyCronAgentExecution(agentDefinition, execution('failed', undefined, 'boom'), gate);
    notifyCronAgentExecution(agentDefinition, execution('failed', undefined, 'boom'), gate);
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// urgencyCriteria 通知门矩阵（N-CRON-URGENCY-NOTIFY）：沿真实接线
// cronAgentRunHasAlert → cronNotifyQuietRound → buildCronAgentActionResult →
// notifyCronAgentExecution 数 notifyTaskComplete 调用次数（推送门与结果标记同走
// notifyQuietRound，接线由 topology 源码契约钉死）。仅设紧急判据的任务：显式
// can_wait/fyi 成功轮无系统通知；must_today/缺头/乱头照常通知；失败与登录墙
// 永不被该门静音（标记只在成功路径打上）。
// ============================================================================
describe('notifyCronAgentExecution：urgencyCriteria 通知门矩阵（N-CRON-URGENCY-NOTIFY）', () => {
  const CRITERIA = '只有老板发来的邮件算今天必须处理';

  function runCompleted(
    action: { urgencyCriteria?: string; notifyWhen?: string },
    finalAssistantText: string,
    isExternalWatch = false,
  ): void {
    const hasAlert = cronAgentRunHasAlert(action, { isExternalWatch, finalAssistantText });
    const quietWatchRound = isExternalWatch && !hasAlert;
    const notifyQuietRound = cronNotifyQuietRound(action, hasAlert, 'job-urg');
    const result = buildCronAgentActionResult(
      { agentType: 'default', prompt: '汇总', ...action },
      undefined,
      'sess-1',
      finalAssistantText,
      quietWatchRound,
      notifyQuietRound,
    );
    notifyCronAgentExecution(
      {
        id: 'job-urg',
        name: '晨报',
        action: { type: 'agent', agentType: 'default', prompt: '汇总', ...action },
      } as unknown as CronJobDefinition,
      {
        id: 'exec-1',
        jobId: 'job-urg',
        status: 'completed',
        scheduledAt: 0,
        startedAt: 0,
        completedAt: 1,
        duration: 1,
        retryAttempt: 0,
        sessionId: 'sess-1',
        result,
      } as CronJobExecution,
      new CronFailureNoticeGate(),
    );
  }

  beforeEach(() => {
    notifyState.notifyTaskComplete.mockClear();
  });

  it('无判据：每轮都通知（can_wait 头也不例外，判据空白任务行为零变化）', () => {
    runCompleted({}, 'urgency: can_wait\n一切照旧');
    runCompleted({}, '普通正文');
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(2);
  });

  it('紧急判据 + must_today → 通知', () => {
    runCompleted({ urgencyCriteria: CRITERIA }, 'urgency: must_today\n老板来信');
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
  });

  it('紧急判据 + can_wait / fyi → 不通知（can_wait 两轮共 0 次调用）', () => {
    runCompleted({ urgencyCriteria: CRITERIA }, 'urgency: can_wait\n周报照旧');
    runCompleted({ urgencyCriteria: CRITERIA }, 'urgency: fyi\n天气速览');
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();
  });

  it('紧急判据 + 缺头 / 乱值头 → 照常通知（漏必办比多弹一次代价大）', () => {
    runCompleted({ urgencyCriteria: CRITERIA }, '普通正文没有头部行');
    runCompleted({ urgencyCriteria: CRITERIA }, 'urgency: maybe\n正文');
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(2);
  });

  it('notifyWhen + 紧急判据同设：notifyWhen 独自决定', () => {
    // 无 alert 标记：即使 must_today 也不通知
    runCompleted({ urgencyCriteria: CRITERIA, notifyWhen: '只有紧急事项' }, 'urgency: must_today\n正文');
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();
    // 有 alert 标记：即使 can_wait 也通知
    runCompleted({ urgencyCriteria: CRITERIA, notifyWhen: '只有紧急事项' }, 'urgency: can_wait\n<cron_alert>紧急</cron_alert>');
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
  });

  it('external-watch：只认 <cron_alert>，urgency 头不改变监听语义', () => {
    runCompleted({ urgencyCriteria: CRITERIA }, '<cron_alert>日历新冲突</cron_alert>', true);
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    notifyState.notifyTaskComplete.mockClear();
    // 无新料的监听轮：skipped 形状不带 notifySuppressed，完成通知行为与主线一致
    runCompleted({}, '无标记正文', true);
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
  });

  it('紧急判据的安静轮留可归因日志（区分 notifyWhen 未满足）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      cronNotifyQuietRound({ urgencyCriteria: CRITERIA }, false, 'job-urg');
      expect(warn).toHaveBeenCalledWith('[CronService] notify suppressed: urgency can_wait/fyi job=job-urg');
      cronNotifyQuietRound({ urgencyCriteria: CRITERIA }, true, 'job-urg');
      cronNotifyQuietRound({}, false, 'job-urg');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('失败与登录墙通知永不被紧急判据静音（成功轮的 can_wait 头也拦不住失败告警）', () => {
    const failedDefinition = {
      id: 'job-urg',
      name: '晨报',
      action: { type: 'agent', agentType: 'default', prompt: '汇总', urgencyCriteria: CRITERIA },
    } as unknown as CronJobDefinition;
    const loginWallError = buildCronLoginWallStopCode('https://example.test');
    notifyCronAgentExecution(
      failedDefinition,
      {
        id: 'exec-f1', jobId: 'job-urg', status: 'failed', scheduledAt: 0,
        startedAt: 0, completedAt: 1, duration: 1, retryAttempt: 0,
        sessionId: 'sess-1', error: 'provider 500',
      } as CronJobExecution,
      new CronFailureNoticeGate(),
    );
    notifyCronAgentExecution(
      failedDefinition,
      {
        id: 'exec-f2', jobId: 'job-urg', status: 'failed', scheduledAt: 0,
        startedAt: 0, completedAt: 1, duration: 1, retryAttempt: 0,
        sessionId: 'sess-1', error: loginWallError,
      } as CronJobExecution,
      new CronFailureNoticeGate(),
    );
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(2);
    const failedPayload = notifyState.notifyTaskComplete.mock.calls[0]?.[0] as { succeeded: boolean };
    const loginWallPayload = notifyState.notifyTaskComplete.mock.calls[1]?.[0] as { code?: string };
    expect(failedPayload.succeeded).toBe(false);
    expect(loginWallPayload.code).toBe('CRON_LOGIN_WALL_STOP');
  });
});

// ============================================================================
// notifyCronJobDisabled（N-FIX-NOTIFY-FAILURE-FOREGROUND-BANNER-FU2-FU1）：
// 三种停用原因（连败/永久配置错/到数）的通知载荷都必须带 jobId——无会话执行
// （如云端 run）的「查看」点击只有靠它落 Cron Center 选中该任务（重新启用入口
// 在那里），不带 jobId 时点击只是空操作 dismiss（FB-551/FB-543）。
// 同时钉死不带 code/failureKind：带上的话 renderer 会把它当云端不可用文案翻译。
// ============================================================================
describe('notifyCronJobDisabled：停用通知载荷带 jobId（三种原因）', () => {
  const disabledDefinition = {
    id: 'job-x',
    name: '备份',
    action: { type: 'shell', command: 'echo ok' },
  } as unknown as CronJobDefinition;

  function disabledExecution(): CronJobExecution {
    return {
      id: 'exec-disabled', jobId: 'job-x', status: 'failed', scheduledAt: 0,
      startedAt: 0, completedAt: 1, duration: 1, retryAttempt: 0,
      error: 'provider 500',
    } as CronJobExecution;
  }

  it('consecutive / permanent / max_runs 的载荷都带 definition.id，不带 code/failureKind', () => {
    notifyState.notifyTaskComplete.mockClear();
    for (const reason of ['consecutive', 'permanent', 'max_runs'] as const) {
      notifyCronJobDisabled(disabledDefinition, disabledExecution(), reason);
    }
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(3);
    const payloads = notifyState.notifyTaskComplete.mock.calls
      .map((call) => call[0] as { jobId?: string; code?: string; failureKind?: string; succeeded?: boolean });
    for (const payload of payloads) {
      expect(payload.jobId).toBe('job-x');
      expect(payload.code).toBeUndefined();
      expect(payload.failureKind).toBeUndefined();
      expect(payload.succeeded).toBe(false);
    }
  });
});
