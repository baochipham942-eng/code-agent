import { describe, expect, it } from 'vitest';
import { cronLoginWallMetadata } from '../../../src/host/cron/cronLoginWall';

describe('cron login-gated site warning detection', () => {
  it('requires a URL and explicit login-gated hint', () => {
    expect(cronLoginWallMetadata({
      action: { type: 'agent', agentType: 'default', prompt: 'Check https://example.test after login' },
    })).toEqual({ loginGatedSiteOrigin: 'https://example.test' });
    expect(cronLoginWallMetadata({
      action: { type: 'agent', agentType: 'default', prompt: 'Read https://example.test public docs' },
    })).toBeUndefined();
  });

  it('preserves unrelated metadata while storing the warning origin', () => {
    expect(cronLoginWallMetadata(
      { action: { type: 'agent', agentType: 'default', prompt: 'Sign in to https://example.test first' } },
      { sourceMessageId: 'msg-1' },
    )).toEqual({ sourceMessageId: 'msg-1', loginGatedSiteOrigin: 'https://example.test' });
  });
});
