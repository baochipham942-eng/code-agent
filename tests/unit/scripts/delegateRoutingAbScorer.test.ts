/**
 * Hermetic scorer coverage for the delegate-routing A/B runner
 * (scripts/acceptance/delegate-routing-ab.ts, N-DELEGATE-SESSION-K1-AB).
 * Mock-replays OpenAI-style chat/completions payloads through
 * parseFirstToolCall + scoreDecision: true positives and true negatives for
 * every outcome class, wrong-candidate = harmful error (reported separately
 * from other misses), no-tool-call handling, percentile math, fixture
 * validation and arm aggregation. No network, no keys — the runner's live
 * path is covered by its --self-check and the committed results.json.
 */

import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import {
  DELEGATE_ROUTING_ACTIONS,
  parseFirstToolCall,
  percentileNearestRank,
  recommendTier,
  scoreDecision,
  summarizeArm,
  validateFixture,
  type DelegateRoutingArmRow,
  type DelegateRoutingPrediction,
  type DelegateRoutingSample,
} from '../../../scripts/acceptance/delegate-routing-ab';

const REF_A = 'AAAAAAAAAAAAAAAA';
const REF_B = 'BBBBBBBBBBBBBBBB';
const DELEGATE_TOOL = 'delegate_session';
const LIST_TOOL = 'list_session_candidates';

/** OpenAI 兼容响应壳：一个带 JSON 字符串 arguments 的 tool call。 */
function replayToolCall(args: Record<string, unknown>, tool: string = DELEGATE_TOOL): unknown {
  return {
    choices: [{
      message: {
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }],
      },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

function replayChatReply(): unknown {
  return { choices: [{ message: { content: '我直接回答，不需要委托。' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
}

function predictionOf(payload: unknown): DelegateRoutingPrediction {
  return parseFirstToolCall(payload);
}

const pred = (action: string, candidateRef?: string): DelegateRoutingPrediction =>
  predictionOf(replayToolCall({ action, ...(candidateRef ? { candidateRef } : {}) }));

describe('parseFirstToolCall (mock replay of OpenAI-style payloads)', () => {
  it('extracts the first tool call and its stringified arguments', () => {
    const payload = {
      choices: [{
        message: {
          tool_calls: [
            { function: { name: DELEGATE_TOOL, arguments: JSON.stringify({ action: 'delegate_existing', candidateRef: REF_A, candidateSetId: 'deadbeefdeadbeef' }) } },
            { function: { name: DELEGATE_TOOL, arguments: JSON.stringify({ action: 'stop' }) } },
          ],
        },
      }],
    };
    expect(parseFirstToolCall(payload)).toEqual({
      kind: 'tool_call',
      tool: DELEGATE_TOOL,
      action: 'delegate_existing',
      candidateRef: REF_A,
      delegationId: undefined,
      argsOk: true,
    });
  });

  it('a plain chat reply (no tool_calls) parses as no_tool_call', () => {
    expect(parseFirstToolCall(replayChatReply())).toEqual({ kind: 'no_tool_call' });
  });

  it('malformed / missing shapes parse as no_tool_call or argsOk=false', () => {
    expect(parseFirstToolCall({}).kind).toBe('no_tool_call');
    expect(parseFirstToolCall(null).kind).toBe('no_tool_call');
    expect(parseFirstToolCall({ choices: [] }).kind).toBe('no_tool_call');
    const malformed = parseFirstToolCall({
      choices: [{ message: { tool_calls: [{ function: { name: DELEGATE_TOOL, arguments: '{not json' } }] } }],
    });
    expect(malformed).toMatchObject({ kind: 'tool_call', argsOk: false, action: undefined });
  });

  it('object-form arguments (some gateways) are accepted', () => {
    const payload = { choices: [{ message: { tool_calls: [{ function: { name: DELEGATE_TOOL, arguments: { action: 'resume', delegationId: 'delegation_x' } } }] } }] };
    expect(parseFirstToolCall(payload)).toMatchObject({ kind: 'tool_call', action: 'resume', delegationId: 'delegation_x', argsOk: true });
  });

  it('list_session_candidates first call is a tool_call on that tool', () => {
    expect(parseFirstToolCall(replayToolCall({}, LIST_TOOL))).toMatchObject({ kind: 'tool_call', tool: LIST_TOOL, argsOk: true });
  });
});

describe('scoreDecision: true positives for every outcome class', () => {
  it('delegate_existing with the exact expected candidateRef is correct', () => {
    expect(scoreDecision({ action: 'delegate_existing', candidateRef: REF_A }, pred('delegate_existing', REF_A))).toBe('correct');
  });

  it('create_new / stop / resume / correct with the matching action are correct', () => {
    expect(scoreDecision({ action: 'create_new' }, pred('create_new'))).toBe('correct');
    expect(scoreDecision({ action: 'stop' }, pred('stop'))).toBe('correct');
    expect(scoreDecision({ action: 'resume' }, pred('resume'))).toBe('correct');
    expect(scoreDecision({ action: 'correct' }, pred('correct'))).toBe('correct');
  });

  it('no_delegation is correct only when no tool call is made', () => {
    expect(scoreDecision({ action: 'no_delegation' }, parseFirstToolCall(replayChatReply()))).toBe('correct');
  });
});

describe('scoreDecision: true negatives — wrong candidate is a harmful error, everything else a miss', () => {
  it('a delegate_existing call to the wrong candidate is harmful, for every expectation shape', () => {
    expect(scoreDecision({ action: 'delegate_existing', candidateRef: REF_A }, pred('delegate_existing', REF_B))).toBe('harmful_wrong_candidate');
    expect(scoreDecision({ action: 'create_new' }, pred('delegate_existing', REF_A))).toBe('harmful_wrong_candidate');
    expect(scoreDecision({ action: 'no_delegation' }, pred('delegate_existing', REF_A))).toBe('harmful_wrong_candidate');
    expect(scoreDecision({ action: 'stop' }, pred('delegate_existing', REF_B))).toBe('harmful_wrong_candidate');
    expect(scoreDecision({ action: 'resume' }, pred('delegate_existing', REF_A))).toBe('harmful_wrong_candidate');
    expect(scoreDecision({ action: 'correct' }, pred('delegate_existing', REF_B))).toBe('harmful_wrong_candidate');
  });

  it('action mismatches and missing calls are plain misses, never harmful', () => {
    expect(scoreDecision({ action: 'create_new' }, pred('stop'))).toBe('miss');
    expect(scoreDecision({ action: 'stop' }, pred('create_new'))).toBe('miss');
    expect(scoreDecision({ action: 'delegate_existing', candidateRef: REF_A }, pred('stop'))).toBe('miss');
    expect(scoreDecision({ action: 'no_delegation' }, pred('create_new'))).toBe('miss');
  });

  it('delegate_existing without a candidateRef is a miss (admission fails closed on ambiguous), not harmful', () => {
    expect(scoreDecision({ action: 'delegate_existing', candidateRef: REF_A }, pred('delegate_existing'))).toBe('miss');
  });

  it('a first call to list_session_candidates is a miss for every expectation (the decision was not made)', () => {
    const listPred = parseFirstToolCall(replayToolCall({}, LIST_TOOL));
    for (const action of DELEGATE_ROUTING_ACTIONS) {
      const expected = action === 'delegate_existing' ? { action, candidateRef: REF_A } : { action };
      expect(scoreDecision(expected, listPred)).toBe('miss');
    }
  });

  it('no tool call when one was expected is a miss', () => {
    expect(scoreDecision({ action: 'delegate_existing', candidateRef: REF_A }, { kind: 'no_tool_call' })).toBe('miss');
    expect(scoreDecision({ action: 'stop' }, { kind: 'no_tool_call' })).toBe('miss');
  });
});

describe('percentileNearestRank (nearest-rank)', () => {
  it('empty input is NaN; a single value is every percentile', () => {
    expect(Number.isNaN(percentileNearestRank([], 50))).toBe(true);
    expect(percentileNearestRank([7], 50)).toBe(7);
    expect(percentileNearestRank([7], 95)).toBe(7);
  });

  it('n=4: p50 picks the 2nd, p95 picks the 4th (ceil rank)', () => {
    expect(percentileNearestRank([10, 20, 30, 40], 50)).toBe(20);
    expect(percentileNearestRank([10, 20, 30, 40], 95)).toBe(40);
  });

  it('unsorted input is sorted internally', () => {
    expect(percentileNearestRank([40, 10, 30, 20], 95)).toBe(40);
    expect(percentileNearestRank([40, 10, 30, 20], 50)).toBe(20);
  });

  it('1..100: p50=50, p95=95; n=10: p95 is the maximum', () => {
    expect(percentileNearestRank(Array.from({ length: 100 }, (_, i) => i + 1), 50)).toBe(50);
    expect(percentileNearestRank(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
    expect(percentileNearestRank(Array.from({ length: 10 }, (_, i) => i + 1), 95)).toBe(10);
  });
});

describe('validateFixture', () => {
  const fixturePath = new URL('../../../tests/fixtures/delegate-routing-ab-samples.json', import.meta.url);

  function sample(overrides: Partial<DelegateRoutingSample> = {}): DelegateRoutingSample {
    return {
      id: 't-001',
      message: '继续那个任务',
      candidates: [
        { candidateRef: REF_A, shortName: '任务甲', workspaceName: 'w', status: 'running', freshness: '1h' },
        { candidateRef: REF_B, shortName: '任务乙', workspaceName: 'w', status: 'idle', freshness: '1d' },
        { candidateRef: 'CCCCCCCCCCCCCCCC', shortName: '任务丙', workspaceName: 'w', status: 'idle', freshness: '7d' },
      ],
      expected: { action: 'delegate_existing', candidateRef: REF_A },
      ...overrides,
    };
  }

  it('the committed fixture passes validation', () => {
    const rows: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
    expect(validateFixture(rows)).toEqual([]);
  });

  it('rejects a non-array root and duplicate ids', () => {
    expect(validateFixture('nope')).toEqual(['fixture 根节点不是数组']);
    expect(validateFixture([sample(), sample()]).some((p) => p.includes('id 重复'))).toBe(true);
  });

  it('flags an expected candidateRef that is not in the sample candidate list', () => {
    expect(validateFixture([sample({ expected: { action: 'delegate_existing', candidateRef: 'ZZZZZZZZZZZZZZZZ' } })])
      .some((p) => p.includes('expected.candidateRef 不在该样本候选列表里'))).toBe(true);
  });

  it('flags candidate lists outside 3..12 rows and invalid enum values', () => {
    expect(validateFixture([sample({ candidates: sample().candidates.slice(0, 2) })]).some((p) => p.includes('候选行数 2'))).toBe(true);
    const badEnum = sample();
    badEnum.candidates = [{ ...badEnum.candidates[0]!, status: 'busy' as 'running', freshness: 'soon' as 'older' }];
    badEnum.candidates.push({ ...badEnum.candidates[0]!, candidateRef: REF_B }, { ...badEnum.candidates[0]!, candidateRef: 'CCCCCCCCCCCCCCCC' });
    const problems = validateFixture([badEnum]);
    expect(problems.some((p) => p.includes('status 非法'))).toBe(true);
    expect(problems.some((p) => p.includes('freshness 非法'))).toBe(true);
  });

  it('chain-action samples (stop/resume/correct) need a delegationId in activeDelegations', () => {
    expect(validateFixture([sample({ expected: { action: 'stop' } })]).some((p) => p.includes('stop 样本缺 activeDelegations'))).toBe(true);
    const withDelegation = sample({
      expected: { action: 'resume' },
      activeDelegations: [{ delegationId: 'delegation_x', targetShortName: '任务甲', status: 'stopped' }],
    });
    expect(validateFixture([withDelegation]).some((p) => p.includes('缺 activeDelegations'))).toBe(false);
  });

  it('structural minimums: total count, per-class floors and ambiguous floor', () => {
    const problems = validateFixture([sample()]);
    expect(problems).toContain('样本数 1 < 30');
    expect(problems).toContain('缺少结果类 create_new');
    expect(problems).toContain('delegate_existing 只有 1 条 < 4');
    expect(problems).toContain('歧义/近重名样本 0 条 < 4');
  });
});

describe('summarizeArm', () => {
  it('aggregates accuracy / harmful / misses and counts transport errors as misses', () => {
    const rows: DelegateRoutingArmRow[] = [
      { id: 'a', outcome: 'correct', latencyMs: 100, tokensIn: 1000, tokensOut: 100, transportError: false },
      { id: 'b', outcome: 'correct', latencyMs: 200, tokensIn: 1000, tokensOut: 100, transportError: false },
      { id: 'c', outcome: 'correct', latencyMs: 300, tokensIn: 1000, tokensOut: 100, transportError: false },
      { id: 'd', outcome: 'harmful_wrong_candidate', latencyMs: 400, tokensIn: 1000, tokensOut: 100, transportError: false },
      { id: 'e', outcome: 'miss', latencyMs: null, tokensIn: 0, tokensOut: 0, transportError: true },
    ];
    const summary = summarizeArm(rows);
    expect(summary).toMatchObject({
      samples: 5,
      correct: 3,
      harmfulWrongCandidate: 1,
      misses: 2,
      accuracy: 0.6,
      harmfulErrorRate: 0.2,
      p50Ms: 200,
      p95Ms: 400,
      transportErrors: 1,
      transportErrorRate: 0.2,
    });
    expect(summary.avgTokensIn).toBeCloseTo(4000 / 5, 10);
    expect(summary.avgTokensOut).toBeCloseTo(400 / 5, 10);
  });

  it('an empty arm does not divide by zero', () => {
    expect(summarizeArm([]).accuracy).toBe(0);
    expect(summarizeArm([]).transportErrorRate).toBe(0);
  });
});

describe('recommendTier (recommendation only, never a product default)', () => {
  const mainArm = { accuracy: 0.9, harmfulWrongCandidate: 1, p50Ms: 2000 };

  it('fast wins the default when accuracy gap <= 5pp and harmful is not worse', () => {
    const verdict = recommendTier({ main: mainArm, fast: { accuracy: 0.87, harmfulWrongCandidate: 1, p50Ms: 1500 } });
    expect(verdict.defaultTier).toBe('fast');
    expect(verdict.exposeRoutingSetting).toBe(false);
  });

  it('more harmful errors in the fast arm keep the main model as default', () => {
    const verdict = recommendTier({ main: mainArm, fast: { accuracy: 0.9, harmfulWrongCandidate: 2, p50Ms: 1500 } });
    expect(verdict.defaultTier).toBe('main');
    expect(verdict.exposeRoutingSetting).toBe(true);
  });

  it('a material accuracy gap (> 5pp) keeps the main model and marks the setting worth exposing', () => {
    const verdict = recommendTier({ main: { ...mainArm, accuracy: 0.95 }, fast: { accuracy: 0.85, harmfulWrongCandidate: 1, p50Ms: 1500 } });
    expect(verdict.defaultTier).toBe('main');
    expect(verdict.exposeRoutingSetting).toBe(true);
  });

  it('notes when the fast arm is actually slower than the main model', () => {
    const verdict = recommendTier({ main: mainArm, fast: { accuracy: 0.9, harmfulWrongCandidate: 1, p50Ms: 3000 } });
    expect(verdict.rationale).toContain('反而高于');
  });
});
