// ============================================================================
// B6b-①：goal 三闸行为断言（goal_status / goal_evidence_gate）
// ============================================================================
// 断言只 pin 行为信号（status/degraded 枚举布尔、gate verdict 枚举、bounce 计数），
// 不 pin 任何文案。fail-loud 口径（对齐批 6 sim 断言）：缺参 / case 没配
// goal_contract / 终态事件没发 / 证据闸从未求值，一律显式 fail，绝不假绿。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { runExpectations } from '../../../src/host/testing/assertionEngine';
import type { Expectation, GoalRunRecord } from '../../../src/host/testing/types';

function baseContext(goalRun?: GoalRunRecord) {
  return {
    toolExecutions: [],
    responses: ['done'],
    errors: [],
    turnCount: 1,
    workingDirectory: '/tmp',
    goalRun,
  };
}

function expectation(type: 'goal_status' | 'goal_evidence_gate', params: Record<string, unknown>): Expectation {
  return { type, description: 'goal assertion', critical: true, params };
}

async function evaluate(exp: Expectation, goalRun?: GoalRunRecord) {
  const { results } = await runExpectations([exp], baseContext(goalRun));
  return results[0];
}

describe('goal_status expectation', () => {
  it('passes when terminal status matches (met, non-degraded)', async () => {
    const result = await evaluate(
      expectation('goal_status', { expected: 'met', degraded: false }),
      { status: 'met', degraded: false, gateEvents: [] },
    );
    expect(result.passed).toBe(true);
  });

  it('pins degraded release: met + degraded=true', async () => {
    const result = await evaluate(
      expectation('goal_status', { expected: 'met', degraded: true }),
      { status: 'met', degraded: true, degradedReason: 'x', gateEvents: [] },
    );
    expect(result.passed).toBe(true);
  });

  it('fails when degraded flag mismatches (degraded release must not pass a clean-met pin)', async () => {
    const result = await evaluate(
      expectation('goal_status', { expected: 'met', degraded: false }),
      { status: 'met', degraded: true, gateEvents: [] },
    );
    expect(result.passed).toBe(false);
  });

  it('fails when status mismatches', async () => {
    const result = await evaluate(
      expectation('goal_status', { expected: 'met' }),
      { status: 'aborted', degraded: false, abortReason: 'budget', gateEvents: [] },
    );
    expect(result.passed).toBe(false);
  });

  it('ignores degraded when the pin is omitted', async () => {
    const result = await evaluate(
      expectation('goal_status', { expected: 'met' }),
      { status: 'met', degraded: true, gateEvents: [] },
    );
    expect(result.passed).toBe(true);
  });

  it('fails loud when the case ran without goal_contract (no goal run recorded)', async () => {
    const result = await evaluate(expectation('goal_status', { expected: 'met' }), undefined);
    expect(result.passed).toBe(false);
    expect(String(result.evidence.actual)).toMatch(/goal/i);
  });

  it('fails loud when the run ended without a terminal goal_complete event', async () => {
    const result = await evaluate(
      expectation('goal_status', { expected: 'met' }),
      { gateEvents: [{ gate: 0, pass: true, verdict: 'allow_finalize' }] },
    );
    expect(result.passed).toBe(false);
  });

  it('fails loud on invalid expected param', async () => {
    const result = await evaluate(
      expectation('goal_status', { expected: 'done' }),
      { status: 'met', degraded: false, gateEvents: [] },
    );
    expect(result.passed).toBe(false);
    expect(String(result.evidence.actual)).toMatch(/invalid/i);
  });
});

describe('goal_evidence_gate expectation', () => {
  const exhaustedRun: GoalRunRecord = {
    status: 'met',
    degraded: true,
    gateEvents: [
      { gate: 0, pass: false, verdict: 'repair_prompt' },
      { gate: 0, pass: false, verdict: 'repair_prompt' },
      { gate: 0, pass: true, verdict: 'exhausted_release' },
      { gate: 2, pass: false, verdict: 'repair_prompt' },
    ],
  };

  it('pins the final gate-0 verdict (exhausted_release after bounces)', async () => {
    const result = await evaluate(
      expectation('goal_evidence_gate', { expected_verdict: 'exhausted_release', min_bounces: 2 }),
      exhaustedRun,
    );
    expect(result.passed).toBe(true);
  });

  it('fails when the final gate-0 verdict mismatches', async () => {
    const result = await evaluate(
      expectation('goal_evidence_gate', { expected_verdict: 'allow_finalize' }),
      exhaustedRun,
    );
    expect(result.passed).toBe(false);
  });

  it('fails when fewer bounces than min_bounces occurred', async () => {
    const result = await evaluate(
      expectation('goal_evidence_gate', { expected_verdict: 'exhausted_release', min_bounces: 3 }),
      exhaustedRun,
    );
    expect(result.passed).toBe(false);
  });

  it('only counts gate-0 events (gate 1/2 verdicts must not leak into the evidence gate assertion)', async () => {
    const result = await evaluate(
      expectation('goal_evidence_gate', { expected_verdict: 'allow_finalize' }),
      {
        status: 'met',
        degraded: false,
        gateEvents: [
          { gate: 0, pass: true, verdict: 'allow_finalize' },
          { gate: 1, pass: false, verdict: 'exhausted_release' },
        ],
      },
    );
    expect(result.passed).toBe(true);
  });

  it('fails loud when the evidence gate was never evaluated (no gate-0 events)', async () => {
    const result = await evaluate(
      expectation('goal_evidence_gate', { expected_verdict: 'allow_finalize' }),
      { status: 'met', degraded: false, gateEvents: [{ gate: 1, pass: true, verdict: 'allow_finalize' }] },
    );
    expect(result.passed).toBe(false);
  });

  it('fails loud without goal run / on invalid params', async () => {
    const noRun = await evaluate(
      expectation('goal_evidence_gate', { expected_verdict: 'allow_finalize' }),
      undefined,
    );
    expect(noRun.passed).toBe(false);

    const badVerdict = await evaluate(
      expectation('goal_evidence_gate', { expected_verdict: 'pass' }),
      exhaustedRun,
    );
    expect(badVerdict.passed).toBe(false);
    expect(String(badVerdict.evidence.actual)).toMatch(/invalid/i);

    const badBounces = await evaluate(
      expectation('goal_evidence_gate', { expected_verdict: 'exhausted_release', min_bounces: -1 }),
      exhaustedRun,
    );
    expect(badBounces.passed).toBe(false);
  });
});
