import { describe, expect, it } from 'vitest';
import { buildCronLoginWallStopCode } from '../../../src/shared/utils/browserLoginWall';
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
