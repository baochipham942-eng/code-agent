import { describe, expect, it } from 'vitest';
import { shouldShowSessionExpiredToast } from '../../../src/renderer/components/SessionExpiredNotice';
import type { AuthEvent } from '../../../src/shared/ipc';

describe('SessionExpiredNotice (2c/ADR-030)', () => {
  it('曾登录但 session 过期 → 提示', () => {
    const event: AuthEvent = { type: 'signed_out', sessionExpired: true };
    expect(shouldShowSessionExpiredToast(event)).toBe(true);
  });

  it('主动登出（无 sessionExpired）→ 不打扰', () => {
    expect(shouldShowSessionExpiredToast({ type: 'signed_out' })).toBe(false);
    expect(shouldShowSessionExpiredToast({ type: 'signed_out', sessionExpired: false })).toBe(false);
  });

  it('登录/刷新事件 → 不提示', () => {
    expect(shouldShowSessionExpiredToast({ type: 'signed_in', sessionExpired: true })).toBe(false);
    expect(shouldShowSessionExpiredToast({ type: 'token_refreshed' })).toBe(false);
  });
});
