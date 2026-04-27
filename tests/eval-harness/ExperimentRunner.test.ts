import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperimentRunner, type AgentRunOutput } from '../../packages/eval-harness/src/runner/ExperimentRunner';
import { runSwissCheese } from '../../packages/eval-harness/src/agents/SwissCheeseAgents';

vi.mock('../../packages/eval-harness/src/agents/SwissCheeseAgents', () => ({
  runSwissCheese: vi.fn(),
}));

describe('ExperimentRunner', () => {
  beforeEach(() => {
    vi.mocked(runSwissCheese).mockReset();
  });

  it('marks the trial failed when the LLM grader fails', async () => {
    vi.mocked(runSwissCheese).mockRejectedValueOnce(new Error('grader unavailable'));

    const runner = new ExperimentRunner({
      trialsPerCase: 1,
      runAgent: async () => 'safe response',
    });

    const result = await runner.run([{ id: 'case-1', prompt: 'do work' }], 'exp-test');
    const trial = result.cases[0].trials[0];

    expect(trial.passed).toBe(false);
    expect(trial.score).toBe(0);
    expect(trial.error).toContain('LLM grader failed');
    expect(result.cases[0].passed).toBe(false);
    expect(result.overallPassRate).toBe(0);
  });

  it('fails real-agent-run cases when replay telemetry is incomplete', async () => {
    const runner = new ExperimentRunner({
      trialsPerCase: 1,
      runAgent: async () => ({
        response: 'safe response',
        sessionId: 'session-1',
        replayKey: 'session-1',
        telemetryCompleteness: {
          sessionId: 'session-1',
          replayKey: 'session-1',
          turnCount: 1,
          modelCallCount: 1,
          toolCallCount: 0,
          eventCount: 1,
          hasModelDecisions: true,
          hasToolSchemas: true,
          hasRealAgentTrace: false,
          dataSource: 'telemetry',
        },
      }),
    });

    const result = await runner.run([{ id: 'case-1', prompt: 'do work', tags: ['real-agent-run'] }], 'exp-test');
    const trial = result.cases[0].trials[0];

    expect(trial.passed).toBe(false);
    expect(trial.degraded).toBe(true);
    expect(trial.gateFailures).toContain('missing_tool_calls');
    expect(trial.gateFailures).toContain('missing_real_agent_trace');
    expect(trial.gateFailures).toContain('missing_replay_explanation');
    expect(runSwissCheese).not.toHaveBeenCalled();
  });

  it('does not allow transcript fallback evidence to satisfy real-agent-run cases', async () => {
    const runner = new ExperimentRunner({
      trialsPerCase: 1,
      runAgent: async () => ({
        response: 'safe response',
        sessionId: 'session-fallback',
        replayKey: 'session-fallback',
        replayExplanation: 'transcript has text and tools',
        telemetryCompleteness: {
          sessionId: 'session-fallback',
          replayKey: 'session-fallback',
          turnCount: 1,
          modelCallCount: 0,
          toolCallCount: 1,
          eventCount: 0,
          hasModelDecisions: false,
          hasToolSchemas: false,
          hasRealAgentTrace: false,
          dataSource: 'transcript_fallback',
        },
      }),
    });

    const result = await runner.run([{ id: 'case-1', prompt: 'do work', tags: ['real-agent-run'] }], 'exp-test');
    const trial = result.cases[0].trials[0];

    expect(trial.passed).toBe(false);
    expect(trial.gateFailures).toEqual(expect.arrayContaining([
      'transcript_fallback_replay',
      'missing_model_decisions',
      'missing_event_trace',
      'missing_tool_schemas',
    ]));
    expect(runSwissCheese).not.toHaveBeenCalled();
  });

  it('emits session, replay key, and telemetry completeness for real-agent-run trials', async () => {
    vi.mocked(runSwissCheese).mockResolvedValueOnce({
      aggregateScore: 88,
      passed: true,
      consensusCount: 3,
    });

    const runner = new ExperimentRunner({
      trialsPerCase: 1,
      runAgent: async () => ({
        response: 'safe response',
        sessionId: 'session-1',
        replayKey: 'session-1',
        replayExplanation: 'model input, tool args, and result are present',
        telemetryCompleteness: {
          sessionId: 'session-1',
          replayKey: 'session-1',
          turnCount: 1,
          modelCallCount: 1,
          toolCallCount: 1,
          eventCount: 1,
          hasModelDecisions: true,
          hasToolSchemas: true,
          hasRealAgentTrace: true,
          dataSource: 'telemetry',
        },
      }),
    });

    const result = await runner.run([{ id: 'case-1', prompt: 'do work', tags: ['real-agent-run'] }], 'exp-test');
    const trial = result.cases[0].trials[0];

    expect(trial.passed).toBe(true);
    expect(trial.sessionId).toBe('session-1');
    expect(trial.replayKey).toBe('session-1');
    expect(trial.telemetryCompleteness?.modelCallCount).toBe(1);
    expect(result.cases[0].passed).toBe(true);
  });

  it('keeps raw real-agent-run case results failed when any trial is degraded despite high median score', async () => {
    vi.mocked(runSwissCheese)
      .mockResolvedValueOnce({
        aggregateScore: 95,
        passed: true,
        consensusCount: 3,
      })
      .mockResolvedValueOnce({
        aggregateScore: 99,
        passed: true,
        consensusCount: 3,
      });

    const outputs: AgentRunOutput[] = [
      {
        response: 'safe response',
        sessionId: 'session-gate-fail',
        replayKey: 'session-gate-fail',
        replayExplanation: 'model text is present but tool evidence is incomplete',
        telemetryCompleteness: {
          sessionId: 'session-gate-fail',
          replayKey: 'session-gate-fail',
          turnCount: 1,
          modelCallCount: 1,
          toolCallCount: 0,
          eventCount: 1,
          hasModelDecisions: true,
          hasToolSchemas: true,
          hasRealAgentTrace: false,
          dataSource: 'telemetry',
        },
      },
      {
        response: 'safe response',
        sessionId: 'session-pass-1',
        replayKey: 'session-pass-1',
        replayExplanation: 'model input, tool args, and result are present',
        telemetryCompleteness: {
          sessionId: 'session-pass-1',
          replayKey: 'session-pass-1',
          turnCount: 1,
          modelCallCount: 1,
          toolCallCount: 1,
          eventCount: 1,
          hasModelDecisions: true,
          hasToolSchemas: true,
          hasRealAgentTrace: true,
          dataSource: 'telemetry',
        },
      },
      {
        response: 'safe response',
        sessionId: 'session-pass-2',
        replayKey: 'session-pass-2',
        replayExplanation: 'model input, tool args, and result are present',
        telemetryCompleteness: {
          sessionId: 'session-pass-2',
          replayKey: 'session-pass-2',
          turnCount: 1,
          modelCallCount: 1,
          toolCallCount: 1,
          eventCount: 1,
          hasModelDecisions: true,
          hasToolSchemas: true,
          hasRealAgentTrace: true,
          dataSource: 'telemetry',
        },
      },
    ];
    let outputIndex = 0;

    const runner = new ExperimentRunner({
      trialsPerCase: 3,
      runAgent: async () => outputs[outputIndex++],
    });

    const result = await runner.run([{ id: 'case-1', prompt: 'do work', tags: ['real-agent-run'] }], 'exp-test');
    const caseResult = result.cases[0];

    expect(caseResult.medianScore).toBe(95);
    expect(caseResult.passed).toBe(false);
    expect(caseResult.failureReason).toContain('real-agent-run gate failed');
    expect(caseResult.failureReason).toContain('missing_tool_calls');
    expect(result.overallPassRate).toBe(0);
    expect(caseResult.trials[0]).toMatchObject({
      passed: false,
      degraded: true,
      sessionId: 'session-gate-fail',
      replayKey: 'session-gate-fail',
      gateFailures: expect.arrayContaining(['missing_tool_calls', 'missing_real_agent_trace']),
    });
    expect(caseResult.trials[1]).toMatchObject({ passed: true, score: 95 });
    expect(caseResult.trials[2]).toMatchObject({ passed: true, score: 99 });
  });
});
