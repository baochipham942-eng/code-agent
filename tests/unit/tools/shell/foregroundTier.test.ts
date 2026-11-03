import { afterEach, describe, expect, it } from 'vitest';
import {
  checkNoWaitCommand,
  clampToShortTier,
  grantShortTierWait,
  markShortTierSession,
  resetShortTierWait,
  resolveForegroundTimeoutTier,
  resolveShortTierWait,
  settleShortTierWait,
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
    expect(clampToShortTier(undefined).timeout).toBe(10000);
    expect(BASH.DEFAULT_TIMEOUT).toBe(120000);
    process.env.CODE_AGENT_BASH_SHORT_TIMEOUT_MS = '3000';
    expect(clampToShortTier(undefined).timeout).toBe(3000);
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

  it('r3 累计 no-wait 预算：多次 ≤ 档位的轮询累计超过档位即拒绝，按实际耗时入账', () => {
    // 复刻 r2 e2e 实录：每条等待都 ≤ 档位（10s），单次守卫放行，但累计把回合拖满命令全程。
    expect(grantShortTierWait('chan-1', 10000)).toEqual({ timeout: 10000 });
    settleShortTierWait('chan-1', 10000);
    const refused = grantShortTierWait('chan-1', 10000);
    expect(refused.refusal).toContain('arrive automatically');
    expect(refused.refusal).toContain('no-wait limit');
    // 预算按会话隔离；实际阻塞小于申请额时只入账实际值，余量仍在。
    expect(grantShortTierWait('chan-2', 10000).timeout).toBe(10000);
    settleShortTierWait('chan-3', 4000);
    expect(grantShortTierWait('chan-3', 10000)).toEqual({ timeout: 6000 });
  });

  it('每轮重置：turn 1 用尽预算 → turn 2 ≤ 档位的阻塞读取再次放行；同一轮内累计上限仍拒绝', () => {
    settleShortTierWait('chan-turn', 10000);
    expect(grantShortTierWait('chan-turn', 5000).refusal).toContain('no-wait limit');
    resetShortTierWait('chan-turn');
    expect(grantShortTierWait('chan-turn', 10000)).toEqual({ timeout: 10000 });
    settleShortTierWait('chan-turn', 10000);
    expect(grantShortTierWait('chan-turn', 1000).refusal).toContain('no-wait limit');
  });
});
