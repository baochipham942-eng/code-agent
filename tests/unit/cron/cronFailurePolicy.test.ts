// ============================================================================
// CronFailurePolicy 单测（N-CRON-RESILIENCE ①②③）：
// 退避序列 / 错误分类判据 / 失败通知去重+冷却 / 连败计数
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  classifyCronFailure,
  countTrailingCronFailures,
  cronRetryBackoffMs,
  CronFailureNoticeGate,
} from '../../../src/host/cron/cronFailurePolicy';
import { CRON_GUARDRAILS } from '../../../src/shared/constants';
import type { CronJobExecution } from '../../../src/shared/contract/cron';

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
    expect(classifyCronFailure(new Error('Command failed: exit 1'))).toBe('transient');
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
  const exec = (status: CronJobExecution['status']): CronJobExecution => ({
    id: `exec-${status}-${Math.random()}`,
    jobId: 'job-x',
    status,
    scheduledAt: 0,
    retryAttempt: 0,
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
});
