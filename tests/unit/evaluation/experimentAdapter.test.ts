import { describe, expect, it, vi } from 'vitest';
import { ExperimentAdapter, type EvalHarnessExperimentResultLike } from '../../../src/host/evaluation/experimentAdapter';
import type { TestRunSummary } from '../../../src/host/testing/types';

function createDbWriter() {
  return {
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  };
}

describe('ExperimentAdapter canonical harness persistence', () => {
  it('persists TestRunner summaries through the canonical eval run contract', async () => {
    const db = createDbWriter();
    const adapter = new ExperimentAdapter(db as any);
    const summary: TestRunSummary = {
      runId: 'test-run-1',
      startTime: Date.parse('2026-04-27T01:00:00.000Z'),
      endTime: Date.parse('2026-04-27T01:00:10.000Z'),
      duration: 10000,
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      partial: 0,
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

    expect(JSON.parse(experiment.summary_json)).toMatchObject({
      total: 1,
      passed: 1,
      passRate: 1,
      avgScore: 0.75,
      aggregation: 'best_score_pass_at_k',
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
      passed: 1,
      failed: 0,
      skipped: 0,
      partial: 0,
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
      passed: 1,
      failed: 0,
      skipped: 1,
      partial: 0,
      averageScore: 1,
      results: [
        { ...base, testId: 'pass-a', description: 'a', status: 'passed', score: 1 },
        { ...base, testId: 'skip-b', description: 'b', status: 'skipped', score: 0 },
      ],
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
});
