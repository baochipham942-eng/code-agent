import { describe, expect, it } from 'vitest';
import { LOCKED_HINT, ZERO_TURN_HINT, resolveZeroTurnHint } from '../../../scripts/lib/postLaunchCliHints';

describe('resolveZeroTurnHint', () => {
  it('被锁挡住时只说锁，不叠「窗口里没有可评的轮」——那两句互相打架', () => {
    expect(resolveZeroTurnHint({ examinedTurns: 0, locked: true })).toBe(LOCKED_HINT);
  });

  it('没被锁挡且扫到 0 轮，给出 stale -shm 这条线索', () => {
    expect(resolveZeroTurnHint({ examinedTurns: 0, locked: false })).toBe(ZERO_TURN_HINT);
  });

  it('评到了轮就什么都不说', () => {
    expect(resolveZeroTurnHint({ examinedTurns: 424, locked: false })).toBeNull();
  });
});
