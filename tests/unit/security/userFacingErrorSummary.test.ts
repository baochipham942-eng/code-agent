import { describe, expect, it } from 'vitest';
import {
  formatUserFacingError,
  scrubUserFacingText,
  summarizeUserFacingError,
} from '../../../src/main/security/userFacingError';

describe('user-facing error boundary', () => {
  it('scrubs secrets, stack traces and local paths from user-facing summaries', () => {
    const error = new Error([
      'Request failed with token=sk-proj-' + 'a'.repeat(48),
      'at runSecretThing (/Users/linchen/private/app.ts:12:3)',
      'cookie=session-secret-value',
    ].join('\n'));

    const summary = summarizeUserFacingError(error, { surface: 'channel_reply' }).summary;

    expect(summary).not.toContain('sk-proj-');
    expect(summary).not.toContain('/Users/linchen');
    expect(summary).not.toContain('session-secret-value');
    expect(summary).not.toContain('at runSecretThing');
    expect(summary.length).toBeLessThanOrEqual(240);
  });

  it('formats a short summary plus local diagnostic hint', () => {
    const text = formatUserFacingError('GitHub token ghp_' + 'a'.repeat(36), {
      surface: 'desktop_notification',
    });

    expect(text).not.toContain('ghp_');
    expect(text).toContain('完整错误已保留在本机诊断日志中');
  });

  it('scrubs notification text directly', () => {
    const scrubbed = scrubUserFacingText('failed at /private/tmp/file.log with Authorization: Bearer secret-token-value');
    expect(scrubbed).not.toContain('/private/tmp/file.log');
    expect(scrubbed).not.toContain('secret-token-value');
  });
});
