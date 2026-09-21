import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../../../src/host/agent/toolExecution/circuitBreaker';

// issue #1990：熔断只认基础设施类失败；业务正常失败（TDD 红、参数校验、断言、
// 文件不存在）不计入计数，照常回喂模型。
describe('CircuitBreaker error classification', () => {
  it('does not trip on 5+ consecutive business failures (TDD red / args validation / assertion)', () => {
    const businessErrors = [
      'Command failed with exit code 1',
      'ppt_edit 参数校验失败：slides 不能为空',
      'tool-args-validation-error: slides is required',
      'AssertionError: expected 3 to equal 4',
      'ENOENT: no such file or directory',
      'old_str is not unique in the file',
    ];
    for (const error of businessErrors) {
      const breaker = new CircuitBreaker();
      for (let index = 0; index < 6; index += 1) {
        expect(breaker.recordFailure(error)).toBe(false);
      }
      expect(breaker.isTripped()).toBe(false);
      expect(breaker.getFailureCount()).toBe(0);
    }
  });

  it('trips on 5 consecutive infrastructure failures (network / database / 5xx / transient 408)', () => {
    const infraErrors = [
      'Failed to fetch URL: fetch failed',
      'connect ECONNREFUSED 127.0.0.1:443',
      'request ETIMEDOUT after 30000ms',
      'database is locked (SQLITE_BUSY)',
      'HTTP 503 Service Unavailable',
      'HTTP 408 Request Timeout',
    ];
    for (const error of infraErrors) {
      const breaker = new CircuitBreaker();
      for (let index = 0; index < 4; index += 1) {
        expect(breaker.recordFailure(error)).toBe(false);
      }
      expect(breaker.recordFailure(error)).toBe(true);
      expect(breaker.isTripped()).toBe(true);
      expect(breaker.getFailureCount()).toBe(5);
    }
  });

  it('business failures neither increment nor reset the infra failure streak', () => {
    const breaker = new CircuitBreaker();
    for (let index = 0; index < 4; index += 1) {
      expect(breaker.recordFailure('Failed to fetch URL: fetch failed')).toBe(false);
    }
    // 业务失败穿插其中：不计数、也不打断既有连败
    expect(breaker.recordFailure('Command failed with exit code 1')).toBe(false);
    expect(breaker.getFailureCount()).toBe(4);
    expect(breaker.recordFailure('Failed to fetch URL: fetch failed')).toBe(true);
    expect(breaker.isTripped()).toBe(true);
  });

  it('keeps a conservative trip path for unrecognized exceptions (countUnknown: true)', () => {
    // exception 兜底通道：classifyError 落 unknown 的未识别异常仍计数，防无限重试
    const breaker = new CircuitBreaker();
    for (let index = 0; index < 4; index += 1) {
      expect(breaker.recordFailure('Unknown error', { countUnknown: true })).toBe(false);
    }
    expect(breaker.recordFailure('Unknown error', { countUnknown: true })).toBe(true);
    expect(breaker.isTripped()).toBe(true);
  });

  it('unknown-classified business results stay exempt on the default path', () => {
    // 工具结果通道默认 countUnknown=false：断言失败等 unknown 业务失败永不熔断
    const breaker = new CircuitBreaker();
    for (let index = 0; index < 6; index += 1) {
      expect(breaker.recordFailure('Unknown error')).toBe(false);
    }
    expect(breaker.isTripped()).toBe(false);
    expect(breaker.getFailureCount()).toBe(0);
  });

  it('success still resets the consecutive failure counter', () => {
    const breaker = new CircuitBreaker();
    for (let index = 0; index < 4; index += 1) {
      breaker.recordFailure('Failed to fetch URL: fetch failed');
    }
    breaker.recordSuccess();
    expect(breaker.getFailureCount()).toBe(0);
    for (let index = 0; index < 4; index += 1) {
      expect(breaker.recordFailure('Failed to fetch URL: fetch failed')).toBe(false);
    }
    expect(breaker.recordFailure('Failed to fetch URL: fetch failed')).toBe(true);
  });
});
