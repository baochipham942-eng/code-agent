import { afterEach, describe, expect, it } from 'vitest';
import {
  checkNoWaitCommand,
  clampToShortTier,
  markShortTierSession,
  resolveForegroundTimeoutTier,
  resolveShortTierTimeoutMs,
  resolveShortTierWait,
} from '../../../../src/host/tools/shell/foregroundTier';
import { BASH } from '../../../../src/shared/constants';

describe('foregroundTier', () => {
  afterEach(() => {
    delete process.env.CODE_AGENT_BASH_SHORT_TIMEOUT_MS;
  });

  it('resolves marked sessions to short and everything else to interactive', () => {
    markShortTierSession('feishu-1');
    expect(resolveForegroundTimeoutTier('feishu-1')).toBe('short');
    expect(resolveForegroundTimeoutTier('desktop-1')).toBe('interactive');
    expect(resolveForegroundTimeoutTier(undefined)).toBe('interactive');
  });

  it('defaults to 10s and is configurable by env; interactive default stays 120s', () => {
    expect(resolveShortTierTimeoutMs()).toBe(10000);
    expect(BASH.DEFAULT_TIMEOUT).toBe(120000);
    process.env.CODE_AGENT_BASH_SHORT_TIMEOUT_MS = '3000';
    expect(resolveShortTierTimeoutMs()).toBe(3000);
  });

  it('flags sleep only at command positions', () => {
    expect(checkNoWaitCommand('sleep 30')).toContain('arrive automatically');
    expect(checkNoWaitCommand('a; sleep 1')).not.toBeNull();
    expect(checkNoWaitCommand('a || sleep 1')).not.toBeNull();
    expect(checkNoWaitCommand('echo sleep')).toBeNull();
    expect(checkNoWaitCommand('ls sleeper')).toBeNull();
  });

  it('clamps timeouts above the tier and waits above the tier are refused', () => {
    expect(clampToShortTier(300000)).toMatchObject({ timeout: 10000, note: expect.stringContaining('clamped') });
    expect(clampToShortTier(5000)).toEqual({ timeout: 5000 });
    expect(clampToShortTier(undefined)).toEqual({ timeout: 10000 });
    expect(resolveShortTierWait(30000).refusal).toBeTruthy();
    expect(resolveShortTierWait(undefined)).toEqual({ timeout: 10000 });
  });
});
