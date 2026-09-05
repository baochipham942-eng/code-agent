import { describe, expect, it } from 'vitest';
import { parseEvalRunEvent } from '@internal-evaluation/host/evaluation/evalRunEventValidation';
import { EVAL_RUN_EVENT_SCHEMA_VERSION, UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';

describe('evaluation run event validation', () => {
  it('接受 pair_end 与 SHIPGATE compare 汇总，拒绝缺失四态对象', () => {
    expect(parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'pair_end', ts: 1, runId: 'run-1', testId: 'case-1',
      statusA: 'passed', statusB: 'failed', assignment: { A: 'baseline', B: 'candidate' },
      assertionWinner: 'baseline', referenceWinner: 'A', assertionPassA: 1, assertionPassB: 0,
      assertionCount: 2, skillActivations: { baseline: 1, candidate: 0 },
      memoryInjections: { baseline: 2, candidate: 0 },
      subagentSpawns: { baseline: 0, candidate: 2 },
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
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'run_end', ts: 2, runId: 'run-1', summary, reportFiles: [], exitCode: 0, aborted: false,
    })).toMatchObject({ summary: { compare: { shipGate: { state: 'insufficient' } } } });
    expect(() => parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'run_end', ts: 2, runId: 'run-1',
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
    // v3 是上一版协议：加了 orchestration / subagentSpawns 之后必须显式拒收。
    expect(() => parseEvalRunEvent({ schemaVersion: 3, type: 'error', ts: 1, runId: 'run-1', error: 'x' }))
      .toThrow(/版本/);
    expect(() => parseEvalRunEvent({ schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'mystery', ts: 1, runId: 'run-1' }))
      .toThrow(/类型/);
    expect(() => parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type: 'run_end',
      ts: 1,
      runId: 'run-1',
      summary: {},
      reportFiles: [],
      exitCode: 0,
      aborted: false,
    })).toThrow(/runId/);
    expect(() => parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
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

  it('v4：pair_end 必须带 subagentSpawns，case_end 的计数必须是非负整数', () => {
    const pairEnd = {
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'pair_end', ts: 1, runId: 'run-1', testId: 'case-1',
      statusA: 'passed', statusB: 'failed', assignment: { A: 'baseline', B: 'candidate' },
      assertionWinner: 'baseline', referenceWinner: 'A', assertionPassA: 1, assertionPassB: 0,
      assertionCount: 2, skillActivations: { baseline: 1, candidate: 0 },
      memoryInjections: { baseline: 2, candidate: 0 },
      subagentSpawns: { baseline: 0, candidate: 2 },
    };
    expect(parseEvalRunEvent(pairEnd)).toMatchObject({ subagentSpawns: { candidate: 2 } });
    // 摘掉 pair_end 的 subagentSpawns 校验这条立刻绿——所以它是本字段的咬合点。
    expect(() => parseEvalRunEvent({ ...pairEnd, subagentSpawns: undefined })).toThrow(/subagentSpawns/);
    // 负数 / 小数落库会显示不可能的次数并绕过「未出场」提示：pair_end 的计数同样只认非负整数。
    expect(() => parseEvalRunEvent({ ...pairEnd, subagentSpawns: { baseline: 0, candidate: -1 } })).toThrow(/subagentSpawns/);
    expect(() => parseEvalRunEvent({ ...pairEnd, subagentSpawns: { baseline: 0.5, candidate: 0 } })).toThrow(/subagentSpawns/);
    expect(() => parseEvalRunEvent({ ...pairEnd, skillActivations: { baseline: -2, candidate: 0 } })).toThrow(/skillActivations/);

    const caseEnd = {
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 1, runId: 'run-1', testId: 'case-1',
      status: 'passed', score: 1, durationMs: 1,
    };
    expect(parseEvalRunEvent({ ...caseEnd, subagentSpawns: 3 })).toMatchObject({ subagentSpawns: 3 });
    expect(parseEvalRunEvent(caseEnd)).toMatchObject({ type: 'case_end' });
    expect(() => parseEvalRunEvent({ ...caseEnd, subagentSpawns: -1 })).toThrow(/subagentSpawns/);
    expect(() => parseEvalRunEvent({ ...caseEnd, subagentSpawns: 1.5 })).toThrow(/subagentSpawns/);
  });

  it('v4：run_start 的实验臂带 orchestration 时逐项校验', () => {
    const runStart = (orchestration: unknown) => ({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'run_start', ts: 1, runId: 'run-1',
      plannedCaseIds: ['case-1'],
      config: {
        ...UNKNOWN_EVAL_RUN_STAMP, mode: 'mock', model: 'm', provider: 'openai', scope: 'smoke',
        maxCases: 1, concurrency: 1, gitCommit: 'abc', testCaseDir: 'cases',
        compare: {
          baseline: { name: 'production', model: 'm', provider: 'openai' },
          candidate: { name: 'candidate', orchestration },
          diff: ['子代理：不扇出，最深 3 层（默认） → 不扇出，一层都不扇出'],
        },
      },
    });
    expect(parseEvalRunEvent(runStart({ allowSwarm: true, spawnMaxDepth: 0 })))
      .toMatchObject({ type: 'run_start' });
    expect(() => parseEvalRunEvent(runStart({ allowSwarm: 'yes' }))).toThrow(/allowSwarm/);
    expect(() => parseEvalRunEvent(runStart({ spawnMaxDepth: -1 }))).toThrow(/spawnMaxDepth/);
    expect(() => parseEvalRunEvent(runStart({ spawnMaxDepth: 1.5 }))).toThrow(/spawnMaxDepth/);
    expect(() => parseEvalRunEvent(runStart('deep'))).toThrow(/orchestration/);
  });

  it('T4：接受合法 aiReview，拒绝未知维度和无效 verdict', () => {
    const base = {
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 1, runId: 'run-1', testId: 'case-1',
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
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 1, runId: 'run-1', testId: 'case-1',
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
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 1, runId: 'run-1', testId: 'case-1',
      status: 'passed', score: 1, durationMs: 1,
    } as const;
    expect(parseEvalRunEvent({ ...base, invalid: { reason: 'usage_unavailable' } }))
      .toMatchObject({ invalid: { reason: 'usage_unavailable' } });
    expect(() => parseEvalRunEvent({ ...base, invalid: { reason: 'unknown' } }))
      .toThrow(/invalid.reason/);
  });

  // N-EVAL-MEMORY：v4 新增字段的正反两向
  it('accepts memory_injected with entries and memory_written', () => {
    expect(parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'memory_injected', ts: 1, runId: 'run-1',
      testId: 'case-1', id: 'memory_index', entries: ['mem-orchid.md'],
    })).toMatchObject({ type: 'memory_injected', entries: ['mem-orchid.md'] });
    expect(parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'memory_written', ts: 1, runId: 'run-1',
      testId: 'case-1', files: ['mem-fact.md'], written: 1,
    })).toMatchObject({ type: 'memory_written', written: 1 });
  });

  it('rejects malformed memory events and pair_end without memoryInjections', () => {
    expect(() => parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'memory_injected', ts: 1, runId: 'run-1',
      testId: 'case-1', id: 'memory_index', entries: 'mem-orchid.md',
    })).toThrow(/entries/);
    expect(() => parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'memory_written', ts: 1, runId: 'run-1',
      testId: 'case-1', written: 1,
    })).toThrow(/files/);
    expect(() => parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'pair_end', ts: 1, runId: 'run-1', testId: 'case-1',
      statusA: 'passed', statusB: 'failed', assignment: { A: 'baseline', B: 'candidate' },
      assertionWinner: 'baseline', referenceWinner: 'A', assertionPassA: 1, assertionPassB: 0,
      assertionCount: 2, skillActivations: { baseline: 1, candidate: 0 },
    })).toThrow(/memoryInjections/);
  });

  it('rejects case_end with a negative memory counter', () => {
    expect(() => parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 1, runId: 'run-1',
      testId: 'case-1', status: 'passed', score: 1, durationMs: 1, memoryInjections: -1,
    })).toThrow(/memoryInjections/);
  });

  // v3 事件在 v4 上一律硬拒（版本策略是严格相等，没有向后兼容窗口）
  it('rejects the previous schema version outright', () => {
    expect(() => parseEvalRunEvent({
      schemaVersion: 3, type: 'memory_injected', ts: 1, runId: 'run-1', testId: 'case-1', id: 'user-memory',
    })).toThrow(/版本/);
  });
});
