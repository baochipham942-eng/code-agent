import { describe, it, expect, beforeEach, vi } from 'vitest';

// 隔离 sentryNode：只断言 captureMessage 的调用，不真初始化 SDK。
const captureMessage = vi.fn();
vi.mock('../../../src/host/observability/sentryNode', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

import {
  reportToolError,
  shouldReportToolError,
  SENTRY_REPORTABLE_ERROR_CATEGORIES,
  __resetToolErrorReporterForTest,
} from '../../../src/host/observability/toolErrorReporter';

describe('toolErrorReporter', () => {
  beforeEach(() => {
    captureMessage.mockClear();
    __resetToolErrorReporterForTest();
  });

  it('allowlist：可执行的基础设施错误上报', () => {
    const reported = reportToolError({
      toolName: 'Bash',
      error: 'connect ETIMEDOUT 1.2.3.4:443',
      sessionId: 'sess-1',
      now: 1000,
    });
    expect(reported).toBe(true);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [msg, level, ctx] = captureMessage.mock.calls[0] as [string, string, { tags: Record<string, string>; extra: Record<string, unknown> }];
    expect(level).toBe('error');
    expect(msg).toContain('Bash');
    expect(ctx.tags.tool).toBe('Bash');
    expect(ctx.tags.errorCategory).toBe('timeout');
    expect(ctx.tags.sessionId).toBe('sess-1');
  });

  it('allowlist：agent 试错型良性错误不上报', () => {
    expect(reportToolError({ toolName: 'Read', error: 'ENOENT: no such file', now: 1000 })).toBe(false);
    expect(reportToolError({ toolName: 'Edit', error: 'old_string was not unique', now: 1000 })).toBe(false);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('去重：同一 (tool, category) 窗口内只报一次', () => {
    const e = 'fetch failed';
    expect(reportToolError({ toolName: 'WebFetch', error: e, now: 0 })).toBe(true);
    expect(reportToolError({ toolName: 'WebFetch', error: e, now: 60_000 })).toBe(false);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('去重：超窗口后可再次上报', () => {
    const e = 'fetch failed';
    expect(reportToolError({ toolName: 'WebFetch', error: e, now: 0 })).toBe(true);
    expect(reportToolError({ toolName: 'WebFetch', error: e, now: 5 * 60 * 1000 })).toBe(true);
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('去重：不同 tool 各自独立', () => {
    const e = 'connect ETIMEDOUT';
    expect(reportToolError({ toolName: 'Bash', error: e, now: 0 })).toBe(true);
    expect(reportToolError({ toolName: 'WebFetch', error: e, now: 0 })).toBe(true);
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('脱敏：extra.error 经 scrubString，家目录被抹', () => {
    const home = process.env.HOME || '';
    reportToolError({
      toolName: 'Bash',
      error: `rate limit hit while reading ${home}/secret/path`,
      now: 1000,
    });
    const ctx = captureMessage.mock.calls[0]?.[2] as { extra: { error: string } };
    if (home) expect(ctx.extra.error).not.toContain(`${home}/secret`);
  });

  it('shouldReportToolError 与 allowlist 一致', () => {
    expect(shouldReportToolError('timeout')).toBe(true);
    expect(shouldReportToolError('file_not_found')).toBe(false);
    expect(SENTRY_REPORTABLE_ERROR_CATEGORIES.has('http_5xx')).toBe(true);
    expect(SENTRY_REPORTABLE_ERROR_CATEGORIES.has('unknown')).toBe(false);
  });
});
