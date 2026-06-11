import { describe, it, expect } from 'vitest';
import {
  DoomLoopGuard,
  stableStringify,
  DOOM_LOOP_THRESHOLD,
  REPEATED_STEP_THRESHOLD,
  EMPTY_OUTPUT_CONTINUATION_LIMIT,
} from '../../../src/main/agent/runtime/doomLoopGuard';

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });

describe('stableStringify', () => {
  it('sorts object keys so key order does not change the signature', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('handles nested objects and arrays', () => {
    expect(stableStringify({ x: [{ b: 1, a: 2 }] })).toBe(stableStringify({ x: [{ a: 2, b: 1 }] }));
  });

  it('distinguishes different values', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it('handles null and primitives', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify('s')).toBe('"s"');
  });
});

describe('DoomLoopGuard L1 — 同名同参连续重复', () => {
  it('stays silent below the threshold', () => {
    const guard = new DoomLoopGuard();
    expect(guard.recordStep([call('Read', { path: 'a.ts' })]).level).toBe('none');
    expect(guard.recordStep([call('Read', { path: 'a.ts' })]).level).toBe('none');
  });

  it('flags doom-loop at 3 consecutive identical calls', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    const check = guard.recordStep([call('Read', { path: 'a.ts' })]);
    expect(check.level).toBe('doom-loop');
    expect(check.nudge).toContain('<doom-loop-guard>');
  });

  it('ignores key order differences in arguments (stableStringify)', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Grep', { pattern: 'x', path: 'src' })]);
    guard.recordStep([call('Grep', { path: 'src', pattern: 'x' })]);
    const check = guard.recordStep([call('Grep', { pattern: 'x', path: 'src' })]);
    expect(check.level).toBe('doom-loop');
  });

  it('escalates to abort when the loop continues after the doom-loop nudge', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    guard.recordStep([call('Read', { path: 'a.ts' })]); // doom-loop nudge
    const check = guard.recordStep([call('Read', { path: 'a.ts' })]);
    expect(check.level).toBe('doom-loop-abort');
  });

  it('resets the streak when a different call appears', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    guard.recordStep([call('Read', { path: 'a.ts' })]);
    guard.recordStep([call('Read', { path: 'b.ts' })]);
    const check = guard.recordStep([call('Read', { path: 'a.ts' })]);
    expect(check.level).toBe('none');
  });
});

describe('DoomLoopGuard L2 — 行动签名重复', () => {
  it('nudges when the same multi-call step repeats 3 times', () => {
    const guard = new DoomLoopGuard();
    const step = [call('Grep', { pattern: 'a' }), call('Read', { path: 'x.ts' })];
    guard.recordStep(step);
    guard.recordStep(step);
    const check = guard.recordStep(step);
    expect(check.level).not.toBe('none');
    expect(check.nudge).toBeTruthy();
    expect(check.nudge).toContain('repeating');
  });

  it('treats swapped-order parallel calls as the same step (multiset signature, codex audit R1)', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Grep', { pattern: 'a' }), call('Read', { path: 'x.ts' })]);
    guard.recordStep([call('Read', { path: 'x.ts' }), call('Grep', { pattern: 'a' })]);
    const check = guard.recordStep([call('Grep', { pattern: 'a' }), call('Read', { path: 'x.ts' })]);
    expect(check.level).toBe('repeated-step');
  });

  it('does not nudge for different steps', () => {
    const guard = new DoomLoopGuard();
    guard.recordStep([call('Grep', { pattern: 'a' })]);
    guard.recordStep([call('Grep', { pattern: 'b' })]);
    const check = guard.recordStep([call('Grep', { pattern: 'c' })]);
    expect(check.level).toBe('none');
  });
});

describe('DoomLoopGuard L3 — 空输出自动续接', () => {
  it('continues with a nudge below the limit', () => {
    const guard = new DoomLoopGuard();
    for (let i = 0; i < EMPTY_OUTPUT_CONTINUATION_LIMIT; i++) {
      const r = guard.recordEmptyOutput();
      expect(r.action).toBe('continue');
      expect(r.nudge).toContain('no usable answer');
    }
  });

  it('stops at the limit', () => {
    const guard = new DoomLoopGuard();
    for (let i = 0; i < EMPTY_OUTPUT_CONTINUATION_LIMIT; i++) guard.recordEmptyOutput();
    expect(guard.recordEmptyOutput().action).toBe('stop');
  });
});

describe('thresholds', () => {
  it('match MiMoCode reference values', () => {
    expect(DOOM_LOOP_THRESHOLD).toBe(3);
    expect(REPEATED_STEP_THRESHOLD).toBe(3);
    expect(EMPTY_OUTPUT_CONTINUATION_LIMIT).toBeGreaterThanOrEqual(1);
  });
});
