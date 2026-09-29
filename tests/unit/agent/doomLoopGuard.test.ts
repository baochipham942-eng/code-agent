import { describe, it, expect } from 'vitest';
import {
  DoomLoopGuard,
  stableStringify,
  collectGuardStepResults,
  DOOM_LOOP_THRESHOLD,
  REPEATED_STEP_THRESHOLD,
  EMPTY_OUTPUT_CONTINUATION_LIMIT,
} from '../../../src/host/agent/runtime/doomLoopGuard';

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

  it('换方法后连击从 1 重数，下一次相同调用不会立刻再中止', () => {
    const guard = new DoomLoopGuard();
    const again = () => guard.recordStep([call('Read', { path: 'a.ts' })]);
    again();
    again();
    again();
    expect(again().level).toBe('doom-loop-abort');
    guard.resetAfterHandback();
    expect(again().level).toBe('none');
    expect(again().level).toBe('none');
    expect(again().level).toBe('doom-loop');
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

// 等形构造：仓内 "Checkpoint fenced by stale cursor" 是检查点围栏文案，
// 不是后台任务轮询样本。这里把它放进 task_output 的 Status 正文，序号和耗时只改数字。
function staleCursorPoll(seq: number, taskId = 'bg-1', status = 'running', extra = '') {
  return {
    name: 'task_output',
    arguments: { task_id: taskId, timeout: seq },
    success: true,
    summary: [
      `=== Task ${taskId} ===`,
      `Status: ${status}`,
      `Duration: ${seq}s`,
      '--- Output ---',
      'Checkpoint fenced by stale cursor',
      `seq=${seq}`,
      extra,
    ].filter(Boolean).join('\n'),
  };
}

describe('DoomLoopGuard result signals', () => {
  it('polling_repeat hits three identical stale-cursor polls and does not nudge again', () => {
    const guard = new DoomLoopGuard();
    expect(guard.recordResults([staleCursorPoll(1)]).signals).toEqual([]);
    expect(guard.recordResults([staleCursorPoll(2)]).signals).toEqual([]);
    const hit = guard.recordResults([{
      ...staleCursorPoll(3),
      name: 'Process',
      arguments: { action: 'output', session_id: 'bg-1', timeout: 9 },
    }]);
    expect(hit.signals).toEqual(['polling_repeat']);
    expect(hit.nudge).toContain('polling_repeat');
    expect(hit.nudge).toContain('change strategy');
    expect(hit).not.toHaveProperty('level');
    const again = guard.recordResults([staleCursorPoll(4)]);
    expect(again.signals).toEqual([]);
    expect(again.nudge).toBeUndefined();
    guard.resetAfterHandback();
    guard.recordResults([staleCursorPoll(5)]);
    guard.recordResults([staleCursorPoll(6)]);
    expect(guard.recordResults([staleCursorPoll(7)]).nudge).toBeUndefined();
  });

  it('polling_repeat stays quiet when the task id or the status changes, or the body grows', () => {
    const differentTask = new DoomLoopGuard();
    differentTask.recordResults([staleCursorPoll(1)]);
    differentTask.recordResults([staleCursorPoll(2)]);
    expect(differentTask.recordResults([staleCursorPoll(3, 'bg-2')]).signals).toEqual([]);

    const statusChanged = new DoomLoopGuard();
    statusChanged.recordResults([staleCursorPoll(1)]);
    statusChanged.recordResults([staleCursorPoll(2)]);
    expect(statusChanged.recordResults([staleCursorPoll(3, 'bg-1', 'completed')]).signals).toEqual([]);

    const grew = new DoomLoopGuard();
    grew.recordResults([staleCursorPoll(1)]);
    grew.recordResults([staleCursorPoll(2)]);
    expect(grew.recordResults([staleCursorPoll(3, 'bg-1', 'running', 'compiled main module')]).signals).toEqual([]);
  });

  it('same_error_family hits three normalized path errors and ignores a different family', () => {
    const guard = new DoomLoopGuard();
    const failure = (file: string) => ({
      name: 'Read',
      arguments: { path: file },
      success: false,
      summary: `ENOENT: no such file '${file}'`,
    });
    expect(guard.recordResults([failure('/tmp/a.ts')]).signals).toEqual([]);
    expect(guard.recordResults([failure('/var/b.ts')]).signals).toEqual([]);
    const hit = guard.recordResults([failure('/opt/c.ts')]);
    expect(hit.signals).toEqual(['same_error_family']);
    expect(hit.nudge).toContain('same_error_family');
    expect(hit.nudge).toContain('change strategy');
    expect(guard.recordResults([failure('/opt/d.ts')]).nudge).toBeUndefined();

    const other = new DoomLoopGuard();
    other.recordResults([failure('/tmp/a.ts')]);
    other.recordResults([failure('/var/b.ts')]);
    expect(other.recordResults([{
      name: 'Read',
      arguments: { path: '/tmp/a.ts' },
      success: false,
      summary: 'permission denied',
    }]).signals).toEqual([]);

    const reset = new DoomLoopGuard();
    reset.recordResults([failure('/tmp/a.ts')]);
    reset.recordResults([failure('/var/b.ts')]);
    reset.recordResults([{ name: 'Read', arguments: { path: '/tmp/a.ts' }, success: true, summary: 'ok' }]);
    reset.recordResults([failure('/opt/c.ts')]);
    expect(reset.recordResults([failure('/opt/d.ts')]).signals).toEqual([]);
  });

  it('abab_action_cycle hits A,B,A,B and ignores a non-alternating window', () => {
    const guard = new DoomLoopGuard();
    const stepA = [call('Read', { path: 'a.ts' })];
    const stepB = [call('Grep', { pattern: 'x' })];
    guard.recordStep(stepA);
    guard.recordStep(stepB);
    guard.recordStep(stepA);
    expect(guard.recordResults([]).signals).toEqual([]);
    expect(guard.recordStep(stepB).level).toBe('none');
    const hit = guard.recordResults([]);
    expect(hit.signals).toEqual(['abab_action_cycle']);
    expect(hit.nudge).toContain('abab_action_cycle');
    expect(hit.nudge).toContain('change strategy');
    guard.recordStep(stepA);
    expect(guard.recordResults([]).nudge).toBeUndefined();

    const broken = new DoomLoopGuard();
    broken.recordStep(stepA);
    broken.recordStep(stepB);
    broken.recordStep([call('Write', { path: 'c.ts' })]);
    broken.recordStep(stepA);
    expect(broken.recordResults([]).signals).toEqual([]);

    const same = new DoomLoopGuard();
    same.recordStep(stepA);
    same.recordStep(stepA);
    same.recordStep(stepA);
    same.recordStep(stepA);
    expect(same.recordResults([]).signals).toEqual([]);
  });

  it('collectGuardStepResults only pairs tool results added after the snapshot', () => {
    const messages = [
      { role: 'assistant', toolCalls: [{ id: 'old', name: 'Read', arguments: { path: 'old.ts' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 'old', success: true, output: 'old' }] },
      { role: 'assistant', toolCalls: [{ id: 'new', name: 'task_output', arguments: { task_id: 'bg-1' } }] },
      {
        role: 'tool',
        toolResults: [{
          toolCallId: 'new',
          success: false,
          error: 'still running',
          metadata: { status: 'running' },
        }],
      },
    ];
    expect(collectGuardStepResults(messages, 2)).toEqual([{
      name: 'task_output',
      arguments: { task_id: 'bg-1' },
      success: false,
      summary: 'status=running\nstill running',
    }]);
  });
});
