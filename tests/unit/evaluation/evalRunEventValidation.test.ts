import { describe, expect, it } from 'vitest';
import { parseEvalRunEvent } from '@internal-evaluation/host/evaluation/evalRunEventValidation';
import { EVAL_RUN_EVENT_SCHEMA_VERSION } from '../../../src/shared/contract/evaluation';

describe('evaluation run event validation', () => {
  it('接受 pair_end 与 SHIPGATE compare 汇总，拒绝缺失四态对象', () => {
    expect(parseEvalRunEvent({
      schemaVersion: 3, type: 'pair_end', ts: 1, runId: 'run-1', testId: 'case-1',
      statusA: 'passed', statusB: 'failed', assignment: { A: 'baseline', B: 'candidate' },
      assertionWinner: 'baseline', referenceWinner: 'A', assertionPassA: 1, assertionPassB: 0,
      assertionCount: 2, skillActivations: { baseline: 1, candidate: 0 },
    })).toMatchObject({ type: 'pair_end', assertionWinner: 'baseline' });
    const summary = {
      runId: 'run-1', startTime: 1, endTime: 2, duration: 1, total: 1, passed: 0, failed: 1,
      skipped: 0, partial: 0, averageScore: 0, plannedCaseIds: ['case-1'], completed: true, notRun: 0,
      invalidCases: 0, compare: {
        totalCases: 1, baselineWins: 1, candidateWins: 0, ties: 0, excludedPairs: 0,
        skillNotActivatedPairs: 0, pValue: 1, shipGate: {
          state: 'insufficient', delta: 3, nMin: 30, decisivePairs: 1, pValue: 1,
          passRateDiff: -1, ciLowerBound: -1, hardGate: { passed: true, items: [] },
          calibre: { k: 1, aggregationRuleVersion: 4, promptVersion: 'sys-v45' }, reasons: ['n<30'],
        },
      },
    };
    expect(parseEvalRunEvent({
      schemaVersion: 3, type: 'run_end', ts: 2, runId: 'run-1', summary, reportFiles: [], exitCode: 0, aborted: false,
    })).toMatchObject({ summary: { compare: { shipGate: { state: 'insufficient' } } } });
    expect(() => parseEvalRunEvent({
      schemaVersion: 3, type: 'run_end', ts: 2, runId: 'run-1',
      summary: { ...summary, compare: { ...summary.compare, shipGate: undefined } }, reportFiles: [], exitCode: 0, aborted: false,
    })).toThrow(/shipGate/);
  });

  it.each([
    ['skill_activated', 'name', 'docx'],
    ['memory_injected', 'id', 'user-memory'],
    ['subagent_spawned', 'id', 'agent-2'],
  ] as const)('accepts the %s protocol event', (type, field, value) => {
    expect(parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type,
      ts: 1,
      runId: 'run-1',
      testId: 'case-1',
      [field]: value,
    })).toMatchObject({ type, testId: 'case-1', [field]: value });
  });

  it('rejects old versions, unknown event types, and incomplete terminal summaries', () => {
    expect(() => parseEvalRunEvent({ schemaVersion: 1, type: 'error', ts: 1, runId: 'run-1', error: 'x' }))
      .toThrow(/版本/);
    expect(() => parseEvalRunEvent({ schemaVersion: 3, type: 'mystery', ts: 1, runId: 'run-1' }))
      .toThrow(/类型/);
    expect(() => parseEvalRunEvent({
      schemaVersion: 3,
      type: 'run_end',
      ts: 1,
      runId: 'run-1',
      summary: {},
      reportFiles: [],
      exitCode: 0,
      aborted: false,
    })).toThrow(/runId/);
    expect(() => parseEvalRunEvent({
      schemaVersion: 3,
      type: 'case_end',
      ts: 1,
      runId: 'run-1',
      testId: 'case-1',
      status: 'passed',
      score: 1,
      durationMs: 1,
      skillActivations: { docx: -1 },
    })).toThrow(/skillActivations/);
  });

  it('T4：接受合法 aiReview，拒绝未知维度和无效 verdict', () => {
    const base = {
      schemaVersion: 3, type: 'case_end', ts: 1, runId: 'run-1', testId: 'case-1',
      status: 'passed', score: 1, durationMs: 1,
    } as const;
    expect(parseEvalRunEvent({
      ...base,
      aiReview: { task_completed: { verdict: 'yes', reasoning: '完成', judgeModel: 'judge/model', promptHash: 'hash' } },
    })).toMatchObject({ aiReview: { task_completed: { verdict: 'yes' } } });
    expect(() => parseEvalRunEvent({
      ...base,
      aiReview: { unknown: { verdict: 'yes', reasoning: 'x', judgeModel: 'm', promptHash: 'h' } },
    })).toThrow(/aiReview/);
    expect(() => parseEvalRunEvent({
      ...base,
      aiReview: { task_completed: { verdict: 'maybe', reasoning: 'x', judgeModel: 'm', promptHash: 'h' } },
    })).toThrow(/verdict/);
  });

  it('证据字段存在时校验 checks 与 responseExcerpt 的最小形状', () => {
    const base = {
      schemaVersion: 2, type: 'case_end', ts: 1, runId: 'run-1', testId: 'case-1',
      status: 'failed', score: 0, durationMs: 1,
    } as const;
    expect(parseEvalRunEvent({
      ...base,
      evidence: { prompt: 'x', checks: [], toolCalls: [], responseExcerpt: 'tail', responseTotalChars: 4 },
    })).toMatchObject({ evidence: { checks: [], responseExcerpt: 'tail' } });
    expect(() => parseEvalRunEvent({ ...base, evidence: { checks: {}, responseExcerpt: 'tail' } }))
      .toThrow(/evidence\.checks/);
    expect(() => parseEvalRunEvent({ ...base, evidence: { checks: [], responseExcerpt: 42 } }))
      .toThrow(/responseExcerpt/);
  });

  it('接受受支持的判废原因并拒绝未知值', () => {
    const base = {
      schemaVersion: 2, type: 'case_end', ts: 1, runId: 'run-1', testId: 'case-1',
      status: 'passed', score: 1, durationMs: 1,
    } as const;
    expect(parseEvalRunEvent({ ...base, invalid: { reason: 'usage_unavailable' } }))
      .toMatchObject({ invalid: { reason: 'usage_unavailable' } });
    expect(() => parseEvalRunEvent({ ...base, invalid: { reason: 'unknown' } }))
      .toThrow(/invalid.reason/);
  });
});
