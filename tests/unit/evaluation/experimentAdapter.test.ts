import { describe, expect, it, vi } from 'vitest';
import { ExperimentAdapter, type EvalHarnessExperimentResultLike } from '@internal-evaluation/host/evaluation/experimentAdapter';
import type { TestRunSummary } from '../../../src/host/testing/types';
import {
  EVAL_RUN_EVENT_SCHEMA_VERSION,
  EVAL_RUN_STAMP_KEYS,
  UNKNOWN_EVAL_RUN_STAMP,
} from '../../../src/shared/contract/evaluation';

function createDbWriter() {
  return {
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  };
}

describe('ExperimentAdapter canonical harness persistence', () => {
  it('T6：事件末态原样落计划题集，旧事件缺字段时不伪造', () => {
    const db = { ...createDbWriter(), updateExperimentSummary: vi.fn() };
    const adapter = new ExperimentAdapter(db as any);
    const summary = {
      runId: 'event-run', startTime: 1, endTime: 2, duration: 1, total: 1,
      passed: 1, failed: 0, skipped: 0, partial: 0, averageScore: 1,
      plannedCaseIds: ['case-1'], completed: true, notRun: 0, invalidCases: 0,
      aggregationRule: 'pass_rate_k1' as const, aggregationRuleVersion: 4,
    };
    adapter.finishEventRun('event-run', summary);
    expect(JSON.parse(db.updateExperimentSummary.mock.calls[0][1]).plannedCaseIds)
      .toEqual(['case-1']);
    adapter.finishEventRun('legacy-run', {
      ...summary, plannedCaseIds: undefined,
    } as unknown as typeof summary);
    expect(JSON.parse(db.updateExperimentSummary.mock.calls[1][1]))
      .not.toHaveProperty('plannedCaseIds');
  });

  it('T2：compare 每对只落一行，胜负与排除理由完整留在 data_json', () => {
    const db = { ...createDbWriter(), updateExperimentSummary: vi.fn() };
    const adapter = new ExperimentAdapter(db as any);
    adapter.beginEventRun({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'run_start', ts: 1, runId: 'compare-run', plannedCaseIds: ['case-a'],
      config: {
        ...UNKNOWN_EVAL_RUN_STAMP, mode: 'real', model: 'm', provider: 'p', scope: 'full', maxCases: 1,
        concurrency: 1, gitCommit: 'abc', testCaseDir: 'cases',
        compare: { baseline: { name: 'production' }, candidate: { name: 'candidate', systemPrompt: 'x' }, diff: ['systemPrompt'] },
      },
    });
    adapter.persistEventCase({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 2, runId: 'compare-run', testId: 'case-a', arm: 'baseline',
      status: 'passed', score: 1, durationMs: 1,
    });
    adapter.persistEventCase({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 3, runId: 'compare-run', testId: 'case-a', arm: 'candidate',
      status: 'failed', score: 0, durationMs: 1,
    });
    adapter.persistPairEnd({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'pair_end', ts: 4, runId: 'compare-run', testId: 'case-a',
      statusA: 'passed', statusB: 'failed', assignment: { A: 'baseline', B: 'candidate' },
      assertionWinner: 'baseline', referenceWinner: 'A', excludedReason: 'skill_not_activated',
      assertionPassA: 1, assertionPassB: 0, assertionCount: 2, skillActivations: { baseline: 1, candidate: 0 },
      memoryInjections: { baseline: 0, candidate: 0 },
      subagentSpawns: { baseline: 0, candidate: 0 },
    });
    const row = db.insertExperimentCases.mock.calls[0][1][0];
    expect(db.insertExperimentCases).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ id: 'compare-run:case-a', status: 'failed', score: 0 });
    expect(JSON.parse(row.data_json)).toMatchObject({
      winner: 'baseline', excludedReason: 'skill_not_activated', skillActivations: { baseline: 1, candidate: 0 },
      subagentSpawns: { baseline: 0, candidate: 0 },
    });
    expect(db.insertExperiment.mock.calls[0][0]).toMatchObject({ source: 'compare' });
  });

  it('实验组臂通过但对照组赢时，status 仍记臂状态且 winner 单独落 data_json', () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    adapter.persistPairEnd({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'pair_end', ts: 1, runId: 'compare-run', testId: 'candidate-passed',
      statusA: 'passed', statusB: 'failed', assignment: { A: 'candidate', B: 'baseline' },
      assertionWinner: 'baseline', referenceWinner: 'B', assertionPassA: 1, assertionPassB: 0,
      assertionCount: 1, skillActivations: { baseline: 0, candidate: 0 },
      memoryInjections: { baseline: 0, candidate: 0 },
      subagentSpawns: { baseline: 0, candidate: 0 },
    });

    const row = db.insertExperimentCases.mock.calls[0][1][0];
    expect(row.status).toBe('passed');
    expect(JSON.parse(row.data_json).winner).toBe('baseline');
  });

  it('实验组臂失败或部分通过但实验组赢时，status 不得按 winner 改成通过', () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    for (const [index, candidateStatus] of (['failed', 'partial'] as const).entries()) {
      adapter.persistPairEnd({
        schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'pair_end', ts: index + 1, runId: 'compare-run', testId: `candidate-${candidateStatus}`,
        statusA: 'passed', statusB: candidateStatus, assignment: { A: 'baseline', B: 'candidate' },
        assertionWinner: 'candidate', referenceWinner: 'B', assertionPassA: 0, assertionPassB: 1,
        assertionCount: 1, skillActivations: { baseline: 0, candidate: 0 },
        memoryInjections: { baseline: 0, candidate: 0 },
        subagentSpawns: { baseline: 0, candidate: 0 },
      });
    }

    expect(db.insertExperimentCases.mock.calls.map((call) => call[1][0].status)).toEqual(['failed', 'partial']);
    expect(db.insertExperimentCases.mock.calls.map((call) => JSON.parse(call[1][0].data_json).winner))
      .toEqual(['candidate', 'candidate']);
  });

  // 2026-08-30 监工代笔（Grok 变异席抓出的盲区）：桥落库计数只测过单题；键若退化成 runId 级会串题。
  it('keeps per-testId skill activation slots isolated when two cases interleave', () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const activate = (ts: number, testId: string, name: string) => adapter.recordSkillActivation({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'skill_activated', ts, runId: 'event-run', testId, name,
    });
    const end = (ts: number, testId: string) => adapter.persistEventCase({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts, runId: 'event-run', testId, status: 'passed', score: 1, durationMs: 1, skillActivations: {},
    });
    activate(1, 'case-a', 'x');
    activate(2, 'case-b', 'y');
    activate(3, 'case-a', 'x');
    end(4, 'case-b');
    end(5, 'case-a');
    const rows = db.insertExperimentCases.mock.calls.map((call) => [call[1][0].case_id, JSON.parse(call[1][0].data_json).skillActivations]);
    expect(rows).toEqual([
      ['case-b', { y: 1 }],
      ['case-a', { x: 2 }],
    ]);
  });

  it('counts memory and per-name skill signals into the matching event-backed case data', () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    adapter.recordMemoryInjection({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type: 'memory_injected',
      ts: 1,
      runId: 'event-run',
      testId: 'event-case',
      id: 'memory-a',
    });
    adapter.recordMemoryInjection({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type: 'memory_injected',
      ts: 2,
      runId: 'event-run',
      testId: 'event-case',
      id: 'memory-b',
    });
    for (const ts of [3, 4]) {
      adapter.recordSkillActivation({
        schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
        type: 'skill_activated',
        ts,
        runId: 'event-run',
        testId: 'event-case',
        name: 'x',
      });
    }
    adapter.persistEventCase({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type: 'case_end',
      ts: 5,
      runId: 'event-run',
      testId: 'event-case',
      status: 'passed',
      score: 1,
      durationMs: 5,
      skillActivations: {},
    });

    expect(JSON.parse(db.insertExperimentCases.mock.calls[0]?.[1][0].data_json).memoryInjections)
      .toBe(2);
    expect(JSON.parse(db.insertExperimentCases.mock.calls[0]?.[1][0].data_json).skillActivations)
      .toEqual({ x: 2 });
  });

  // N-EVAL-MEMORY：写入侧计数与 case_end 自带计数的优先级
  it('counts memory writes and lets case_end counters win over per-event accumulation', () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    adapter.recordMemoryWrite({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'memory_written', ts: 1, runId: 'event-run', testId: 'event-case',
      files: ['mem-a.md'], written: 1,
    });
    adapter.recordMemoryWrite({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'memory_written', ts: 2, runId: 'event-run', testId: 'event-case',
      files: ['mem-b.md', 'mem-c.md'], written: 2,
    });
    adapter.persistEventCase({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 3, runId: 'event-run', testId: 'event-case',
      status: 'passed', score: 1, durationMs: 5, skillActivations: {},
    });
    expect(JSON.parse(db.insertExperimentCases.mock.calls[0]?.[1][0].data_json).memoryWrites).toBe(3);

    // case_end 带了自己的计数就以它为准（runner 落账是权威，逐事件累加只是兜底）
    const db2 = createDbWriter();
    const adapter2 = new ExperimentAdapter(db2 as any);
    adapter2.recordMemoryInjection({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'memory_injected', ts: 1, runId: 'event-run', testId: 'event-case', id: 'memory_index',
    });
    adapter2.persistEventCase({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 2, runId: 'event-run', testId: 'event-case',
      status: 'passed', score: 1, durationMs: 5, skillActivations: {}, memoryInjections: 7, memoryWrites: 4,
    });
    const data = JSON.parse(db2.insertExperimentCases.mock.calls[0]?.[1][0].data_json);
    expect(data.memoryInjections).toBe(7);
    expect(data.memoryWrites).toBe(4);
  });

  // N-EVAL-ORCHARM：subagent_spawned 从桥数到 data_json —— 摘掉 recordSubagentSpawn
  // 或 persistEventCase 里的 subagentSpawns 字段，这条立刻红。
  it('counts subagent_spawned per case into data_json, isolated across interleaved cases', () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const spawn = (ts: number, testId: string, id: string) => adapter.recordSubagentSpawn({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'subagent_spawned', ts, runId: 'event-run', testId, id,
    });
    const end = (ts: number, testId: string) => adapter.persistEventCase({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts, runId: 'event-run', testId,
      status: 'passed', score: 1, durationMs: 1,
    });
    spawn(1, 'case-a', 'agent-1');
    spawn(2, 'case-b', 'agent-2');
    spawn(3, 'case-a', 'agent-3');
    end(4, 'case-b');
    end(5, 'case-a');
    end(6, 'case-c');
    const rows = db.insertExperimentCases.mock.calls
      .map((call) => [call[1][0].case_id, JSON.parse(call[1][0].data_json).subagentSpawns]);
    expect(rows).toEqual([
      ['case-b', 1],
      ['case-a', 2],
      // 零触发要落成 0，不是缺字段——结果页据此打「未出场」。
      ['case-c', 0],
    ]);
  });

  it('case_end 自带的 subagentSpawns 与桥计数取一致的那个（同一数字两条路径）', () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    adapter.persistEventCase({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 1, runId: 'event-run',
      testId: 'from-event', status: 'passed', score: 1, durationMs: 1, subagentSpawns: 3,
    });
    expect(JSON.parse(db.insertExperimentCases.mock.calls[0][1][0].data_json).subagentSpawns).toBe(3);
  });

  it('pair_end 的两臂子代理次数原样落 data_json', () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    adapter.beginEventRun({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'run_start', ts: 1, runId: 'compare-run',
      plannedCaseIds: ['case-a'],
      config: {
        ...UNKNOWN_EVAL_RUN_STAMP, mode: 'mock', model: 'm', provider: 'openai', scope: 'smoke',
        maxCases: 1, concurrency: 1, gitCommit: 'abc', testCaseDir: 'cases',
        compare: {
          baseline: { name: 'production' },
          candidate: { name: 'candidate', orchestration: { allowSwarm: true } },
          diff: ['子代理：不扇出 → 允许扇出'],
        },
      } as any,
    });
    adapter.persistPairEnd({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'pair_end', ts: 2, runId: 'compare-run', testId: 'case-a',
      statusA: 'passed', statusB: 'passed', assignment: { A: 'baseline', B: 'candidate' },
      assertionWinner: 'tie', referenceWinner: 'tie', assertionPassA: 1, assertionPassB: 1, assertionCount: 1,
      skillActivations: { baseline: 0, candidate: 0 },
      memoryInjections: { baseline: 0, candidate: 0 },
      subagentSpawns: { baseline: 0, candidate: 4 },
    });
    const row = JSON.parse(db.insertExperimentCases.mock.calls.at(-1)![1][0].data_json);
    expect(row.subagentSpawns).toEqual({ baseline: 0, candidate: 4 });
  });

  it('T2：事件证据原样落库，旧事件不增加 evidence 键', () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const evidence = {
      prompt: '输入', checks: [{ type: 'no_crash', passed: true, expected: 'true', actual: 'true', durationMs: 1 }],
      toolCalls: [], responseExcerpt: '完成', responseTotalChars: 2,
    };
    adapter.persistEventCase({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 1, runId: 'event-run', testId: 'with-evidence',
      status: 'passed', score: 1, durationMs: 2, evidence, invalid: { reason: 'usage_unavailable' },
    });
    adapter.persistEventCase({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, type: 'case_end', ts: 2, runId: 'event-run', testId: 'legacy',
      status: 'failed', score: 0, durationMs: 2,
    });
    const first = JSON.parse(db.insertExperimentCases.mock.calls[0][1][0].data_json);
    const second = JSON.parse(db.insertExperimentCases.mock.calls[1][1][0].data_json);
    expect(first.evidence.checks).toEqual(evidence.checks);
    expect(db.insertExperimentCases.mock.calls[0][1][0].status).toBe('invalid');
    expect(first.invalid).toEqual({ reason: 'usage_unavailable' });
    expect(second).not.toHaveProperty('evidence');
  });

  it('persists failure axes for event-backed and TestRunner-backed cases', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const failure = {
      code: 'timeout',
      dispositions: ['retryable'],
      symptoms: ['timeout', 'loop_suspect'],
    };
    adapter.persistEventCase({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type: 'case_end',
      ts: 1,
      runId: 'event-run',
      testId: 'event-case',
      status: 'failed',
      score: 0,
      durationMs: 5,
      failure,
      aiReview: {
        task_completed: { verdict: 'no', reasoning: '未完成', judgeModel: 'judge/model', promptHash: 'hash' },
      },
    });
    expect(JSON.parse(db.insertExperimentCases.mock.calls[0]?.[1][0].data_json).failure)
      .toEqual(failure);
    expect(JSON.parse(db.insertExperimentCases.mock.calls[0]?.[1][0].data_json).aiReview)
      .toMatchObject({ task_completed: { verdict: 'no' } });

    const summary: TestRunSummary = {
      runId: 'failure-run', startTime: 1, endTime: 2, duration: 1,
      total: 1, plannedCaseIds: ['failed-case'], completed: true,
      passed: 0, failed: 1, skipped: 0, partial: 0, notRun: 0, invalidCases: 0,
      failureDistribution: { unknown: 0, timeout: 1 },
      failureCodebookSource: 'bundled',
      averageScore: 0,
      results: [{
        testId: 'failed-case', description: 'failed', status: 'failed',
        duration: 1, startTime: 1, endTime: 2, toolExecutions: [], responses: [], errors: [],
        turnCount: 1, score: 0, failure,
        aiReview: { task_completed: { verdict: 'yes', reasoning: '完成', judgeModel: 'judge/model', promptHash: 'hash' } },
      }],
      stamp: UNKNOWN_EVAL_RUN_STAMP,
      environment: { model: 'm', provider: 'p', workingDirectory: '/tmp' },
      performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
    };
    await adapter.persistTestRun(summary);
    const persistedExperiment = db.insertExperiment.mock.calls[0]?.[0];
    expect(JSON.parse(persistedExperiment.summary_json).failureDistribution)
      .toEqual({ unknown: 0, timeout: 1 });
    expect(JSON.parse(persistedExperiment.summary_json).failureCodebookSource).toBe('bundled');
    const persistedCase = db.insertExperimentCases.mock.calls[1]?.[1][0];
    expect(JSON.parse(persistedCase.data_json).failure).toEqual(failure);
    expect(JSON.parse(persistedCase.data_json).aiReview).toMatchObject({ task_completed: { verdict: 'yes' } });
  });

  it('persists TestRunner summaries through the canonical eval run contract', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const summary: TestRunSummary = {
      runId: 'test-run-1',
      startTime: Date.parse('2026-04-27T01:00:00.000Z'),
      endTime: Date.parse('2026-04-27T01:00:10.000Z'),
      duration: 10000,
      total: 1,
      plannedCaseIds: ['case-a'],
      completed: true,
      passed: 1,
      failed: 0,
      skipped: 0,
      partial: 0,
      notRun: 0,
      invalidCases: 0,
      averageScore: 0.75,
      results: [
        {
          testId: 'case-a',
          description: 'case A',
          status: 'passed',
          duration: 9000,
          startTime: 1,
          endTime: 2,
          toolExecutions: [],
          responses: ['ok'],
          errors: [],
          turnCount: 1,
          score: 0.75,
          skillActivations: { x: 2 },
          trials: [
            { score: 0.4, status: 'failed', duration_ms: 1000 },
            { score: 0.75, status: 'passed', duration_ms: 2000 },
          ],
          variance: 0.03,
          stdDev: 0.17,
          unstable: false,
          sessionId: 'session-a',
        },
      ],
      stamp: { ...UNKNOWN_EVAL_RUN_STAMP, promptVersion: 'sys-test' },
      environment: {
        model: 'gpt-test',
        provider: 'mock',
        workingDirectory: '/tmp/project',
      },
      performance: {
        avgResponseTime: 1000,
        maxResponseTime: 1000,
        totalToolCalls: 0,
        totalTurns: 1,
      },
      gitCommit: 'abc123',
    };

    await adapter.persistTestRun(summary);

    expect(db.insertExperiment).toHaveBeenCalledTimes(1);
    expect(db.insertExperimentCases).toHaveBeenCalledTimes(1);

    const experiment = db.insertExperiment.mock.calls[0]?.[0];
    expect(experiment).toMatchObject({
      id: 'test-run-1',
      source: 'test-runner',
      git_commit: 'abc123',
      model: 'gpt-test',
      provider: 'mock',
    });
    const persistedConfig = JSON.parse(experiment.config_json) as Record<string, unknown>;
    for (const key of EVAL_RUN_STAMP_KEYS) expect(persistedConfig).toHaveProperty(key);
    expect(persistedConfig.promptVersion).toBe('sys-test');

    expect(JSON.parse(experiment.summary_json)).toMatchObject({
      total: 1,
      passed: 1,
      passRate: 1,
      avgScore: 0.75,
      aggregation: 'legacy',
      source: 'test-runner',
      canonical: {
        schemaVersion: 1,
        averageScore100: 75,
        caseCount: 1,
      },
      trialsPerCase: 2,
    });

    const cases = db.insertExperimentCases.mock.calls[0]?.[1];
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      case_id: 'case-a',
      session_id: 'session-a',
      status: 'passed',
      score: 75,
      duration_ms: 9000,
    });
    expect(JSON.parse(cases[0].data_json).trials).toEqual([
      { trialIndex: 0, status: 'failed', score: 40, durationMs: 1000 },
      { trialIndex: 1, status: 'passed', score: 75, durationMs: 2000 },
    ]);
    expect(JSON.parse(cases[0].data_json)).toMatchObject({
      sessionId: 'session-a',
      replayKey: 'session-a',
      telemetryCompleteness: {
        sessionId: 'session-a',
        replayKey: 'session-a',
        turnCount: 1,
        hasRealAgentTrace: false,
        incompleteReasons: expect.arrayContaining(['missing_telemetry_completeness']),
      },
      realAgentRun: {
        passed: false,
        reasons: expect.arrayContaining(['missing_telemetry_completeness']),
      },
      skillActivations: { x: 2 },
      evidence: {
        prompt: '',
        checks: [],
        responseExcerpt: 'ok',
        responseTotalChars: 2,
      },
      qualityReport: {
        reportId: 'quality:test-run-1:case-a',
        status: 'failed',
        traceIdentity: {
          traceId: 'session:session-a',
          replayKey: 'session-a',
        },
        gates: [
          {
            gateId: 'telemetry_replay',
            status: 'failed',
            failures: expect.arrayContaining(['missing_telemetry_completeness']),
          },
        ],
      },
    });
  });

  it('persists harness variant config into config_json and experiment name (GAP-017)', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const summary: TestRunSummary = {
      runId: 'harness-run-1',
      startTime: Date.parse('2026-06-02T01:00:00.000Z'),
      endTime: Date.parse('2026-06-02T01:00:10.000Z'),
      duration: 10000,
      total: 1,
      plannedCaseIds: ['case-h'],
      completed: true,
      passed: 1,
      failed: 0,
      skipped: 0,
      partial: 0,
      notRun: 0,
      invalidCases: 0,
      averageScore: 0.9,
      results: [
        {
          testId: 'case-h',
          description: 'harness case',
          status: 'passed',
          duration: 9000,
          startTime: 1,
          endTime: 2,
          toolExecutions: [],
          responses: ['ok'],
          errors: [],
          turnCount: 1,
          score: 0.9,
        },
      ],
      stamp: UNKNOWN_EVAL_RUN_STAMP,
      environment: {
        model: 'glm-5',
        provider: 'zhipu',
        workingDirectory: '/tmp/project',
      },
      performance: {
        avgResponseTime: 1000,
        maxResponseTime: 1000,
        totalToolCalls: 0,
        totalTurns: 1,
      },
      gitCommit: 'abc123',
      // GAP-017: 固定模型变 harness 的对照实验维度
      harness: {
        name: 'compression-off',
        contextCompression: false,
        hooksEnabled: false,
        toolMode: 'all',
      },
    };

    await adapter.persistTestRun(summary);

    const experiment = db.insertExperiment.mock.calls[0]?.[0];
    // 实验名带变体名，便于跨实验对比识别
    expect(experiment.name).toContain('harness-compression-off');
    // harness 维度落 config_json
    expect(JSON.parse(experiment.config_json).harness).toEqual({
      name: 'compression-off',
      contextCompression: false,
      hooksEnabled: false,
      toolMode: 'all',
    });
  });

  it('persists eval-harness ExperimentRunner results with median-threshold semantics', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const result: EvalHarnessExperimentResultLike = {
      experimentId: 'eval-harness-run-1',
      timestamp: '2026-04-27T02:00:00.000Z',
      overallPassRate: 1,
      cases: [
        {
          caseId: 'eval-case-a',
          medianScore: 82,
          passed: true,
          trials: [
            { trialIndex: 0, score: 64, passed: false, durationMs: 10, error: 'low score' },
            {
              trialIndex: 1,
              score: 82,
              passed: true,
              durationMs: 20,
              sessionId: 'session-eval-a',
              replayKey: 'session-eval-a',
              replayExplanation: 'model input and tool result present',
              telemetryCompleteness: {
                sessionId: 'session-eval-a',
                replayKey: 'session-eval-a',
                turnCount: 1,
                modelCallCount: 1,
                toolCallCount: 1,
                eventCount: 1,
                hasModelDecisions: true,
                hasToolSchemas: true,
                hasPermissionTrace: false,
                hasContextCompressionEvents: false,
                hasSubagentTelemetry: false,
                hasRealAgentTrace: true,
                dataSource: 'telemetry',
              },
              swissCheeseResult: { passed: true },
            },
            { trialIndex: 2, score: 90, passed: true, durationMs: 30 },
          ],
        },
      ],
    };

    await adapter.persistEvalHarnessResult(result, { model: 'judge-model', provider: 'mock' });

    const experiment = db.insertExperiment.mock.calls[0]?.[0];
    expect(experiment).toMatchObject({
      id: 'eval-harness-run-1',
      source: 'eval-harness',
      model: 'judge-model',
      provider: 'mock',
    });
    expect(JSON.parse(experiment.summary_json)).toMatchObject({
      total: 1,
      passed: 1,
      passRate: 1,
      avgScore: 0.82,
      aggregation: 'median_threshold',
      source: 'eval-harness',
      canonical: {
        schemaVersion: 1,
        averageScore100: 82,
      },
    });

    const cases = db.insertExperimentCases.mock.calls[0]?.[1];
    expect(cases[0]).toMatchObject({
      case_id: 'eval-case-a',
      session_id: 'session-eval-a',
      status: 'passed',
      score: 82,
      duration_ms: 60,
    });
    // ADR-036 F1：harness medianScore 由 LLM grader 产出 → 如实标 llm_judge，
    // 不再丢成 unknown 冒充确定性分。
    expect(JSON.parse(cases[0].data_json).scoreAuthority).toBe('llm_judge');
    const caseData = JSON.parse(cases[0].data_json);
    expect(caseData.trials[0]).toMatchObject({
      trialIndex: 0,
      status: 'failed',
      score: 64,
      durationMs: 10,
      error: 'low score',
    });
    expect(caseData.trials[1].metadata.swissCheeseResult).toEqual({ passed: true });
    expect(caseData).toMatchObject({
      sessionId: 'session-eval-a',
      replayKey: 'session-eval-a',
      telemetryCompleteness: {
        sessionId: 'session-eval-a',
        modelCallCount: 1,
        toolCallCount: 1,
      },
      realAgentRun: {
        sessionId: 'session-eval-a',
        replayKey: 'session-eval-a',
      },
      qualityReport: {
        reportId: 'quality:eval-harness-run-1:eval-case-a',
        status: 'passed',
        gates: [
          {
            gateId: 'telemetry_replay',
            status: 'passed',
          },
        ],
      },
    });
  });

  it('does not let median score override real-agent-run gate failures', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const result: EvalHarnessExperimentResultLike = {
      experimentId: 'eval-harness-gated-run',
      timestamp: '2026-04-27T02:30:00.000Z',
      overallPassRate: 1,
      cases: [
        {
          caseId: 'eval-case-gated',
          medianScore: 88,
          passed: true,
          trials: [
            {
              trialIndex: 0,
              score: 0,
              passed: false,
              durationMs: 10,
              sessionId: 'session-gated',
              replayKey: 'session-gated',
              degraded: true,
              gateFailures: ['missing_model_decisions', 'missing_tool_schemas'],
              telemetryCompleteness: {
                sessionId: 'session-gated',
                replayKey: 'session-gated',
                turnCount: 1,
                modelCallCount: 0,
                toolCallCount: 1,
                eventCount: 0,
                hasModelDecisions: false,
                hasToolSchemas: false,
                hasPermissionTrace: false,
                hasContextCompressionEvents: false,
                hasSubagentTelemetry: false,
                hasRealAgentTrace: false,
                dataSource: 'telemetry',
              },
            },
            { trialIndex: 1, score: 88, passed: true, durationMs: 20 },
            { trialIndex: 2, score: 92, passed: true, durationMs: 30 },
          ],
        },
      ],
    };

    await adapter.persistEvalHarnessResult(result, { model: 'judge-model', provider: 'mock' });

    const experiment = db.insertExperiment.mock.calls[0]?.[0];
    expect(JSON.parse(experiment.summary_json)).toMatchObject({
      failed: 1,
      passed: 0,
      passRate: 0,
      avgScore: 0,
    });

    const cases = db.insertExperimentCases.mock.calls[0]?.[1];
    expect(cases[0]).toMatchObject({
      case_id: 'eval-case-gated',
      session_id: 'session-gated',
      status: 'failed',
      score: 0,
    });
    // ADR-036 F1：degraded 是确定性 replay gate 判失败（score 强制归零），
    // 不是 judge 打分——标 deterministic_assertion 而非 llm_judge。
    expect(JSON.parse(cases[0].data_json).scoreAuthority).toBe('deterministic_assertion');
    expect(JSON.parse(cases[0].data_json)).toMatchObject({
      failureStage: 'telemetry_replay_gate',
      failureReason: 'real-agent-run gate failed: missing_model_decisions, missing_tool_schemas',
      realAgentRun: {
        passed: false,
        degraded: true,
        gateFailures: ['missing_model_decisions', 'missing_tool_schemas'],
      },
      qualityReport: {
        reportId: 'quality:eval-harness-gated-run:eval-case-gated',
        status: 'failed',
        gates: [
          {
            gateId: 'telemetry_replay',
            status: 'failed',
            failures: expect.arrayContaining(['missing_model_decisions', 'missing_tool_schemas']),
          },
        ],
      },
    });
  });

  it('persists regression reports through the canonical eval run contract', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);

    await adapter.persistRegressionReport({
      runId: 'regression-run-1',
      timestamp: '2026-04-27T03:00:00.000Z',
      totalCases: 2,
      passed: 1,
      failed: 1,
      errored: 0,
      passRate: 0.5,
      durationMs: 123,
      results: [
        { id: 'regression-a', status: 'pass', durationMs: 50, stdout: 'ok', stderr: '', exitCode: 0 },
        { id: 'regression-b', status: 'fail', durationMs: 73, stdout: '', stderr: 'failed', exitCode: 1, errorMessage: 'assertion failed' },
      ],
    });

    const experiment = db.insertExperiment.mock.calls[0]?.[0];
    expect(experiment).toMatchObject({
      id: 'regression-run-1',
      source: 'regression',
      scope: 'regression',
    });
    expect(JSON.parse(experiment.summary_json)).toMatchObject({
      total: 2,
      passed: 1,
      failed: 1,
      passRate: 0.5,
      aggregation: 'regression_gate',
      source: 'regression',
      canonical: {
        schemaVersion: 1,
        averageScore100: 50,
        caseCount: 2,
      },
    });

    const cases = db.insertExperimentCases.mock.calls[0]?.[1];
    expect(cases.map((c: { case_id: string; status: string; score: number }) => ({
      case_id: c.case_id,
      status: c.status,
      score: c.score,
    }))).toEqual([
      { case_id: 'regression-a', status: 'passed', score: 100 },
      { case_id: 'regression-b', status: 'failed', score: 0 },
    ]);
    expect(JSON.parse(cases[1].data_json)).toMatchObject({
      failureReason: 'assertion failed',
      aggregation: 'regression_gate',
      source: 'regression',
      stderr: 'failed',
      exitCode: 1,
    });
  });

  it('report 导入路径：passed 题保留 costUsd，缺值不补 0', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const baseResult = {
      description: 'case',
      duration: 1,
      startTime: 1,
      endTime: 2,
      toolExecutions: [] as TestRunSummary['results'][number]['toolExecutions'],
      responses: [] as string[],
      errors: [] as string[],
      turnCount: 1,
      score: 1,
    };
    const summary: TestRunSummary = {
      runId: 'cost-run',
      startTime: 1,
      endTime: 2,
      duration: 1,
      total: 2,
      plannedCaseIds: ['priced', 'legacy'],
      completed: true,
      passed: 2,
      failed: 0,
      skipped: 0,
      partial: 0,
      notRun: 0,
      invalidCases: 0,
      averageScore: 1,
      gitCommit: 'abc',
      results: [
        { testId: 'priced', status: 'passed', costUsd: 0.012, ...baseResult },
        { testId: 'legacy', status: 'passed', ...baseResult },
      ],
      stamp: { ...UNKNOWN_EVAL_RUN_STAMP },
      environment: { model: 'm', provider: 'p', workingDirectory: '/tmp' },
      performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
    };
    await adapter.persistTestRun(summary);

    const cases = db.insertExperimentCases.mock.calls[0]?.[1] as Array<{ case_id: string; data_json: string }>;
    const priced = JSON.parse(cases.find((item) => item.case_id === 'priced')!.data_json) as Record<string, unknown>;
    const legacy = JSON.parse(cases.find((item) => item.case_id === 'legacy')!.data_json) as Record<string, unknown>;
    expect(priced.costUsd).toBe(0.012);
    expect(legacy).not.toHaveProperty('costUsd');
  });

  it('ADR-036 F2: pass-rate 分母排除 skipped，与均分口径一致（1 passed + 1 skipped → 100%）', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const base = {
      duration: 1,
      startTime: 1,
      endTime: 2,
      toolExecutions: [],
      responses: [],
      errors: [],
      turnCount: 1,
    };
    const summary: TestRunSummary = {
      runId: 'f2-run',
      startTime: 1,
      endTime: 2,
      duration: 1,
      total: 2,
      plannedCaseIds: ['pass-a', 'skip-b'],
      completed: true,
      passed: 1,
      failed: 0,
      skipped: 1,
      partial: 0,
      notRun: 0,
      invalidCases: 0,
      averageScore: 1,
      results: [
        { ...base, testId: 'pass-a', description: 'a', status: 'passed', score: 1 },
        { ...base, testId: 'skip-b', description: 'b', status: 'skipped', score: 0 },
      ],
      stamp: UNKNOWN_EVAL_RUN_STAMP,
      environment: { model: 'm', provider: 'mock', workingDirectory: '/tmp' },
      performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
      gitCommit: 'f2',
    };

    await adapter.persistTestRun(summary);

    const experiment = db.insertExperiment.mock.calls[0]?.[0];
    const parsed = JSON.parse(experiment.summary_json);
    // 旧口径 passed/total = 1/2 = 0.5；新口径 passed/scored = 1/1 = 1。
    expect(parsed.passRate).toBe(1);
    expect(parsed.skipped).toBe(1);
  });

  it('includes sanitized dataset name in eval-harness experiment name', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const result: EvalHarnessExperimentResultLike = {
      experimentId: 'eval-harness-ds',
      timestamp: '2026-04-27T02:00:00.000Z',
      dataset: 'My Suite / v2  beta',
      overallPassRate: 1,
      cases: [
        {
          caseId: 'c1',
          medianScore: 90,
          passed: true,
          trials: [{ trialIndex: 0, score: 90, passed: true, durationMs: 10 }],
        },
      ],
    };

    await adapter.persistEvalHarnessResult(result);

    expect(db.insertExperiment.mock.calls[0]?.[0].name).toBe('eval-harness-My-Suite-v2-beta-2026-04-27');
  });

  it('keeps legacy eval-harness-<date> name when dataset is missing or blank', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const result: EvalHarnessExperimentResultLike = {
      experimentId: 'eval-harness-no-ds',
      timestamp: '2026-04-27T02:00:00.000Z',
      dataset: '   ',
      overallPassRate: 1,
      cases: [
        {
          caseId: 'c1',
          medianScore: 90,
          passed: true,
          trials: [{ trialIndex: 0, score: 90, passed: true, durationMs: 10 }],
        },
      ],
    };

    await adapter.persistEvalHarnessResult(result);

    expect(db.insertExperiment.mock.calls[0]?.[0].name).toBe('eval-harness-2026-04-27');
  });

  it('prefixes date-like dataset names so normalization does not strip them', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const result: EvalHarnessExperimentResultLike = {
      experimentId: 'eval-harness-date-ds',
      timestamp: '2026-04-27T02:00:00.000Z',
      dataset: '2026-07-21',
      overallPassRate: 1,
      cases: [
        {
          caseId: 'c1',
          medianScore: 90,
          passed: true,
          trials: [{ trialIndex: 0, score: 90, passed: true, durationMs: 10 }],
        },
      ],
    };

    await adapter.persistEvalHarnessResult(result);

    expect(db.insertExperiment.mock.calls[0]?.[0].name).toBe('eval-harness-ds-2026-07-21-2026-04-27');
  });

  it('includes dataset name in bare test-runner experiment name', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const summary: TestRunSummary = {
      runId: 'ds-run',
      startTime: Date.parse('2026-04-27T01:00:00.000Z'),
      endTime: Date.parse('2026-04-27T01:00:10.000Z'),
      duration: 10000,
      total: 1,
      plannedCaseIds: ['case-a'],
      completed: true,
      passed: 1,
      failed: 0,
      skipped: 0,
      partial: 0,
      notRun: 0,
      invalidCases: 0,
      averageScore: 1,
      results: [
        {
          testId: 'case-a',
          description: 'a',
          status: 'passed',
          duration: 1,
          startTime: 1,
          endTime: 2,
          toolExecutions: [],
          responses: [],
          errors: [],
          turnCount: 1,
          score: 1,
        },
      ],
      stamp: UNKNOWN_EVAL_RUN_STAMP,
      environment: { model: 'm', provider: 'mock', workingDirectory: '/tmp' },
      performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
      gitCommit: 'abc123',
      dataset: 'smoke-suite',
    };

    await adapter.persistTestRun(summary);

    expect(db.insertExperiment.mock.calls[0]?.[0].name).toBe('eval-smoke-suite-2026-04-27');
  });

  it('harness variant naming takes precedence over dataset name', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const summary: TestRunSummary = {
      runId: 'ds-harness-run',
      startTime: Date.parse('2026-06-02T01:00:00.000Z'),
      endTime: Date.parse('2026-06-02T01:00:10.000Z'),
      duration: 10000,
      total: 1,
      plannedCaseIds: ['case-a'],
      completed: true,
      passed: 1,
      failed: 0,
      skipped: 0,
      partial: 0,
      notRun: 0,
      invalidCases: 0,
      averageScore: 1,
      results: [
        {
          testId: 'case-a',
          description: 'a',
          status: 'passed',
          duration: 1,
          startTime: 1,
          endTime: 2,
          toolExecutions: [],
          responses: [],
          errors: [],
          turnCount: 1,
          score: 1,
        },
      ],
      stamp: UNKNOWN_EVAL_RUN_STAMP,
      environment: { model: 'm', provider: 'mock', workingDirectory: '/tmp' },
      performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
      gitCommit: 'abc123',
      dataset: 'smoke-suite',
      harness: {
        name: 'compression-off',
        contextCompression: false,
        hooksEnabled: false,
        toolMode: 'all',
      },
    };

    await adapter.persistTestRun(summary);

    expect(db.insertExperiment.mock.calls[0]?.[0].name).toBe('harness-compression-off-2026-06-02');
  });
});
