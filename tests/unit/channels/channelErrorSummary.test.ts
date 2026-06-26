import { describe, expect, it } from 'vitest';
import {
  isUnsafeChannelErrorText,
  summarizeChannelError,
} from '../../../src/host/channels/channelErrorSummary';

describe('channel error summary', () => {
  it('maps operational errors to short user-facing messages', () => {
    expect(summarizeChannelError(new Error('Request timeout after 30000ms'))).toEqual({
      kind: 'timeout',
      message: '处理超时，请稍后重试。',
    });
    expect(summarizeChannelError(new Error('permission denied: missing scope'))).toEqual({
      kind: 'permission',
      message: '缺少必要权限，请在桌面端检查配置。',
    });
    expect(summarizeChannelError(new Error('Agent not available'))).toEqual({
      kind: 'not_available',
      message: '通道暂时不可用，请稍后重试。',
    });
  });

  it('does not reuse unsafe internal error text for external channels', () => {
    const internal = 'Error: failed with token sk-test at /Users/linchen/app.ts\n    at run (/tmp/app.ts:1:1)';
    const summary = summarizeChannelError(internal);

    expect(summary.message).toBe('处理失败，已记录本地日志。');
    expect(summary.message).not.toContain('sk-test');
    expect(summary.message).not.toContain('/Users/linchen');
    expect(isUnsafeChannelErrorText(internal)).toBe(true);
    expect(isUnsafeChannelErrorText(summary.message)).toBe(false);
  });
});
