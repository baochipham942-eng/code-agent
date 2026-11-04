import { describe, expect, it } from 'vitest';
import { buildCronLoginWallStopCode } from '../../../src/shared/utils/browserLoginWall';
import {
  CRON_CLOUD_UNAVAILABLE_MESSAGE_EN,
  CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH,
} from '../../../src/shared/utils/cronCloudUnavailable';
import {
  classifyCronFailure,
  cronFailureSourceText,
} from '../../../src/shared/utils/cronFailureClassification';

const GLM_WITH_FLUSH = [
  '429 Too Many Requests',
  '{"error":{"code":"1308","message":"usage limit reached for the 5-hour window","next_flush_time":"2026-10-15T05:00:00Z"}}',
].join('\n');

const GLM_WITHOUT_FLUSH = '{"error":{"code":"1308","message":"usage limit reached"}}';

describe('classifyCronFailure', () => {
  it('登录墙先于其它信号', () => {
    expect(classifyCronFailure(buildCronLoginWallStopCode('https://example.test'))).toEqual({
      kind: 'login_wall',
    });
  });

  it('云端调度器不可用的固定句归 cloud_unavailable，cause 追加不冲掉', () => {
    expect(classifyCronFailure(CRON_CLOUD_UNAVAILABLE_MESSAGE_EN)).toEqual({ kind: 'cloud_unavailable' });
    expect(classifyCronFailure(CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH)).toEqual({ kind: 'cloud_unavailable' });
    // executeJob 落库时会把 cause 报文追加在句子后面，底因不得改写分类。
    expect(classifyCronFailure(`${CRON_CLOUD_UNAVAILABLE_MESSAGE_EN}\nfetch failed`))
      .toEqual({ kind: 'cloud_unavailable' });
    expect(classifyCronFailure(`${CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH}\nfetch failed`))
      .toEqual({ kind: 'cloud_unavailable' });
    expect(classifyCronFailure(`${CRON_CLOUD_UNAVAILABLE_MESSAGE_EN}\n401`))
      .toEqual({ kind: 'cloud_unavailable' });
    expect(classifyCronFailure(`${CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH}\n401`))
      .toEqual({ kind: 'cloud_unavailable' });
    // 普通网络错误不受影响，仍是 network。
    expect(classifyCronFailure('fetch failed')).toEqual({ kind: 'network' });
  });

  it('GLM 1308 带 next_flush_time：额度、窗口词、ISO 重置时间', () => {
    expect(classifyCronFailure(GLM_WITH_FLUSH)).toEqual({
      kind: 'quota',
      limitText: '5-hour window',
      resetAt: '2026-10-15T05:00:00.000Z',
    });
  });

  it('GLM 1308 没有重置字段：额度，但不编时间', () => {
    expect(classifyCronFailure(GLM_WITHOUT_FLUSH)).toEqual({ kind: 'quota' });
  });

  it('1310、usage limit、reset(s) at、将在…重置 都只认写明的时间', () => {
    expect(classifyCronFailure('1310 weekly usage limit').limitText).toBe('weekly');
    expect(classifyCronFailure('usage limit resets at 2026-10-15T05:00:00Z').resetAt)
      .toBe('2026-10-15T05:00:00.000Z');
    expect(classifyCronFailure('usage limit。将在 2026-10-15T05:00:00Z 重置').resetAt)
      .toBe('2026-10-15T05:00:00.000Z');
    expect(classifyCronFailure('usage limit next_flush_time: 1760490000').resetAt)
      .toBe(new Date(1760490000 * 1000).toISOString());
  });

  it('GLM 401 中文文案（真机实测原文）归鉴权，不漏成 other', () => {
    // 2026-10-15 真跑记录的 execution.error 原样：message + responseBody 两段。
    expect(classifyCronFailure('令牌已过期或验证不正确\n{"error":{"code":"401","message":"令牌已过期或验证不正确"}}'))
      .toEqual({ kind: 'auth' });
    expect(classifyCronFailure('{"error":{"code":"401","message":"Invalid API key"}}'))
      .toEqual({ kind: 'auth' });
  });

  it('独立 401 数字不是鉴权信号（自由文本可能带无关的 401）', () => {
    // 服务商限流文案「请 401 秒后重试」：裸扫 \b401\b 会把限流吞成鉴权，
    // 引导用户去改没坏的 key。鉴权要靠成句措辞或结构化状态码（R2 教训）。
    expect(classifyCronFailure('429 Too Many Requests，请 401 秒后重试')).toEqual({ kind: 'rate_limit' });
    // 回显的 URL / shell 输出里带 401 同理，不得误判成鉴权。
    expect(classifyCronFailure('curl https://api.test/v1/chat?page=401 failed: fetch failed'))
      .toEqual({ kind: 'network' });
  });

  it('402 余额不足归额度，不编时间和窗口', () => {
    const result = classifyCronFailure('402 Payment Required: insufficient balance');
    expect(result).toEqual({ kind: 'quota' });
    expect(result.resetAt).toBeUndefined();
    expect(result.limitText).toBeUndefined();
  });

  it('没有明确字段的日期不会被当成重置时间', () => {
    expect(classifyCronFailure('failed at 2026-10-15T05:00:00Z because the worker crashed'))
      .toEqual({ kind: 'other' });
  });

  it('限流、并发、超时、鉴权、网络、其它各归一类', () => {
    expect(classifyCronFailure('429 Too Many Requests')).toEqual({ kind: 'rate_limit' });
    expect(classifyCronFailure('concurrency limit exceeded')).toEqual({ kind: 'rate_limit' });
    expect(classifyCronFailure('request timed out')).toEqual({ kind: 'timeout' });
    expect(classifyCronFailure('upstream timeout')).toEqual({ kind: 'timeout' });
    // ETIMEDOUT 不含子串 "timeout"（中间多一个 d），按字面不升成 timeout。
    expect(classifyCronFailure('ETIMEDOUT after 30000ms')).toEqual({ kind: 'other' });
    expect(classifyCronFailure('401 Unauthorized: incorrect api key')).toEqual({ kind: 'auth' });
    expect(classifyCronFailure('fetch failed')).toEqual({ kind: 'network' });
    expect(classifyCronFailure('ECONNRESET: socket hang up')).toEqual({ kind: 'network' });
    expect(classifyCronFailure('something exploded in the runner')).toEqual({ kind: 'other' });
    expect(classifyCronFailure(undefined)).toEqual({ kind: 'other' });
    expect(classifyCronFailure('   ')).toEqual({ kind: 'other' });
  });

  it('重试包装下的 responseBody 仍能分类出额度重置时间', () => {
    const cause = Object.assign(new Error('Too Many Requests'), {
      responseBody: GLM_WITH_FLUSH,
    });
    const wrapped = new Error('Retry stopped: the same retryable error repeated 3 times.', { cause });
    expect(cronFailureSourceText(new Error('plain failure'))).toBe('plain failure');
    expect(cronFailureSourceText(buildCronLoginWallStopCode('https://example.test')))
      .toBe(buildCronLoginWallStopCode('https://example.test'));
    const text = cronFailureSourceText(wrapped);
    expect(classifyCronFailure(text)).toMatchObject({
      kind: 'quota',
      limitText: '5-hour window',
      resetAt: '2026-10-15T05:00:00.000Z',
    });
  });
});
