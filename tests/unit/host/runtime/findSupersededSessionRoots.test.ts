import { describe, expect, it } from 'vitest';
import { MAX_AUTO_RESUME_COUNT, type RunEnvelope } from '../../../../src/shared/contract/durableRun';
import { findSupersededSessionRoots } from '../../../../src/host/runtime/recoveredWaitingRun';

// 新消息让位判据（ADR-075 修订 ③⑤）：等「继续」的停靠 run 与排队中的自动续跑让位；
// 等审批的 crash waiting（预算未耗尽）绝不能被新消息终态化，否则待审批操作静默丢失。
const run = (patch: Partial<RunEnvelope>): RunEnvelope => ({
  runId: 'r1', sessionId: 's1', status: 'waiting', ...patch,
} as RunEnvelope);

const pick = (envelope: RunEnvelope, opts: { handle?: boolean; queued?: boolean; sessionId?: string } = {}) =>
  findSupersededSessionRoots([envelope], () => !!opts.handle, () => !!opts.queued, opts.sessionId ?? 's1').length === 1;

describe('findSupersededSessionRoots', () => {
  it.each([
    ['waiting + crash_or_quit + 预算未耗尽（等审批）', run({ interruptCause: 'crash_or_quit', autoResumeCount: MAX_AUTO_RESUME_COUNT - 1 }), false],
    ['waiting + crash_or_quit + 未记次数（等审批）', run({ interruptCause: 'crash_or_quit' }), false],
    ['waiting + 无中断原因（普通审批等待）', run({}), false],
    ['waiting + crash_or_quit + 预算耗尽', run({ interruptCause: 'crash_or_quit', autoResumeCount: MAX_AUTO_RESUME_COUNT }), true],
    ['waiting + user_stop', run({ interruptCause: 'user_stop' }), true],
    ['waiting + guard_halt', run({ interruptCause: 'guard_halt' }), true],
    ['running', run({ status: 'running', interruptCause: 'user_stop' }), false],
  ] as const)('%s → %s', (_label, envelope, expected) => {
    expect(pick(envelope)).toBe(expected);
  });

  it('recovering 只在排队中才让位', () => {
    const recovering = run({ status: 'recovering', interruptCause: 'crash_or_quit' });
    expect(pick(recovering, { queued: true })).toBe(true);
    expect(pick(recovering, { queued: false })).toBe(false);
  });

  it('有活 handle、子 run、别的会话都不选中', () => {
    const parked = run({ interruptCause: 'user_stop' });
    expect(pick(parked, { handle: true })).toBe(false);
    expect(pick(run({ interruptCause: 'user_stop', parentRunId: 'root' }))).toBe(false);
    expect(pick(parked, { sessionId: 's2' })).toBe(false);
  });
});
