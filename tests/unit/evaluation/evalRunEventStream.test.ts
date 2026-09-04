import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EvalRunEventStream, type EvalRunStartConfig } from '@internal-evaluation-scripts/lib/eval-run-event-stream';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';
import type { TestResult } from '../../../src/host/testing/types';

const ZERO_RUBRIC = {
  content: { correctness: 0, completeness: 0, accuracy: 0, total: 0 },
  structure: { organization: 0, formatting: 0, usability: 0, total: 0 },
  combined: 0,
};

describe('EvalRunEventStream AI 评审透传', () => {
  it('T4：TestResult.aiReview 原样进入 case_end.aiReview', () => {
    let ndjson = '';
    const writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: string) => {
      if (fd === process.stdout.fd) ndjson += data;
      return Buffer.byteLength(data);
    }) as typeof fs.writeSync);
    const stream = new EvalRunEventStream('ai-review-run');
    const config: EvalRunStartConfig = {
      ...UNKNOWN_EVAL_RUN_STAMP,
      mode: 'real',
      model: 'tested-model',
      provider: 'provider',
      scope: 'smoke',
      maxCases: 1,
      concurrency: 1,
      gitCommit: 'test-sha',
      testCaseDir: '/cases',
    };
    const result: TestResult = {
      testId: 'case-1',
      description: '任务',
      prompt: '输入',
      status: 'passed',
      score: 1,
      duration: 1,
      startTime: 0,
      endTime: 1,
      toolExecutions: [],
      responses: [],
      errors: [],
      turnCount: 1,
      invalid: { reason: 'usage_unavailable' },
      aiReview: {
        task_completed: {
          verdict: 'no',
          reasoning: '缺少产物',
          judgeModel: 'provider/judge',
          promptHash: 'sha256',
        },
      },
      expectationResults: [{
        expectation: { type: 'no_crash', description: '没有崩溃', params: {} },
        passed: true,
        evidence: { expected: true, actual: true },
        duration: 1,
      }],
    };

    try {
      stream.forward({ type: 'case_end', result }, config);
      stream.finish(0);
    } finally {
      writeSpy.mockRestore();
    }

    const events = ndjson.trim().split('\n').map((line) => JSON.parse(line));
    expect(events.find((event) => event.type === 'case_end')).toMatchObject({
      testId: 'case-1',
      invalid: { reason: 'usage_unavailable' },
      aiReview: {
        task_completed: {
          verdict: 'no',
          reasoning: '缺少产物',
        },
      },
      evidence: { prompt: '输入', checks: [{ type: 'no_crash', passed: true }] },
    });
  });
});

describe('EvalRunEventStream 子代理触发次数', () => {
  function captureStream(runId: string): { ndjson: () => string; restore: () => void } {
    let ndjson = '';
    const writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: string) => {
      if (fd === process.stdout.fd) ndjson += data;
      return Buffer.byteLength(data);
    }) as typeof fs.writeSync);
    void runId;
    return { ndjson: () => ndjson, restore: () => writeSpy.mockRestore() };
  }

  const config: EvalRunStartConfig = {
    ...UNKNOWN_EVAL_RUN_STAMP,
    mode: 'mock', model: 'm', provider: 'p', scope: 'smoke',
    maxCases: 1, concurrency: 1, gitCommit: 'sha', testCaseDir: '/cases',
  };

  function baseResult(testId: string): TestResult {
    return {
      testId, description: '任务', prompt: '输入', status: 'passed', score: 1,
      duration: 1, startTime: 0, endTime: 1, toolExecutions: [], responses: [], errors: [],
      turnCount: 1, expectationResults: [],
    };
  }

  it('subagent_spawned 事件按题累计并落进 case_end.subagentSpawns', () => {
    const capture = captureStream('spawn-run');
    const stream = new EvalRunEventStream('spawn-run');
    try {
      stream.forward({ type: 'subagent_spawned', testId: 'case-1', id: 'a1' }, config);
      stream.forward({ type: 'subagent_spawned', testId: 'case-1', id: 'a2' }, config);
      stream.forward({ type: 'subagent_spawned', testId: 'case-2', id: 'b1' }, config);
      stream.forward({ type: 'case_end', result: baseResult('case-1') }, config);
      stream.forward({ type: 'case_end', result: baseResult('case-2') }, config);
      stream.finish(0);
    } finally {
      capture.restore();
    }
    const events = capture.ndjson().trim().split('\n').map((line) => JSON.parse(line));
    const caseEnds = events.filter((event) => event.type === 'case_end');
    // 摘掉 eval-run-event-stream 里的 subagentSpawns 计数/透传，这条立刻红。
    expect(caseEnds.map((event) => [event.testId, event.subagentSpawns]))
      .toEqual([['case-1', 2], ['case-2', 1]]);
  });

  it('recordComparison 把两臂计数按盲分配还原进 pair_end.subagentSpawns', () => {
    const comparison = {
      testId: 'case-1', description: '', assignment: { A: 'candidate' as const, B: 'baseline' as const },
      scoreA: ZERO_RUBRIC, scoreB: ZERO_RUBRIC,
      referenceWinner: 'tie' as const, referenceKind: 'heuristic' as const,
      assertionWinner: 'tie' as const, passRateA: 1, passRateB: 1, assertionCount: 1,
      realWinner: 'tie' as const, reasoning: '', statusA: 'passed' as const, statusB: 'passed' as const,
      durationA: 1, durationB: 1,
      skillActivationsA: {}, skillActivationsB: {},
      subagentSpawnsA: 5, subagentSpawnsB: 0,
    };
    const capture = captureStream('pair-run');
    const stream = new EvalRunEventStream('pair-run');
    try {
      stream.recordComparison({
        runId: 'pair-run', timestamp: 0, duration: 1,
        baseline: { name: 'baseline' }, candidate: { name: 'candidate' },
        cases: [comparison],
        summary: {
          totalCases: 1, baselineWins: 0, candidateWins: 0, ties: 1, excludedPairs: 0,
          skillNotActivatedPairs: 0, winner: 'tie', verdict: '', pValue: 1,
          baselineSkillActivations: {}, candidateSkillActivations: {},
          shipGate: {
            state: 'insufficient', delta: 0, nMin: 30, decisivePairs: 0, pValue: 1,
            passRateDiff: 0, ciLowerBound: 0, hardGate: { passed: true, items: [] },
            calibre: { k: 1, aggregationRuleVersion: 4, promptVersion: 'sys-v45' }, reasons: [],
          },
        },
      } as never);
      stream.finish(0);
    } finally {
      capture.restore();
    }
    const events = capture.ndjson().trim().split('\n').map((line) => JSON.parse(line));
    // A 是 candidate ⇒ candidate 拿 5，baseline 拿 0（摘掉映射会左右对调，立刻红）。
    expect(events.find((event) => event.type === 'pair_end')?.subagentSpawns)
      .toEqual({ baseline: 0, candidate: 5 });
    const armCases = events.filter((event) => event.type === 'case_end');
    expect(armCases.map((event) => [event.arm, event.subagentSpawns]))
      .toEqual([['baseline', 0], ['candidate', 5]]);
  });

  it('零触发的题落 0 而不是缺字段（结果页据此打「未出场」）', () => {
    const capture = captureStream('quiet-run');
    const stream = new EvalRunEventStream('quiet-run');
    try {
      stream.forward({ type: 'case_end', result: baseResult('quiet-case') }, config);
      stream.finish(0);
    } finally {
      capture.restore();
    }
    const events = capture.ndjson().trim().split('\n').map((line) => JSON.parse(line));
    expect(events.find((event) => event.type === 'case_end')?.subagentSpawns).toBe(0);
  });
});
