import { describe, expect, it } from 'vitest';
import { aggregateTeamResults } from '../../../src/host/agent/resultAggregator';
import type { AgentTaskResult } from '../../../src/host/agent/parallelAgentCoordinator';

function result(overrides: Partial<AgentTaskResult>): AgentTaskResult {
  return {
    success: true,
    output: 'ok',
    toolsUsed: [],
    iterations: 1,
    taskId: 'agent-1',
    role: 'coder',
    startTime: 0,
    endTime: 10,
    duration: 10,
    ...overrides,
  };
}

describe('aggregateTeamResults', () => {
  it('counts terminal attempts rather than unique tool names', () => {
    const aggregation = aggregateTeamResults([
      result({ toolsUsed: ['Read'], toolCallCount: 2 }),
      result({ toolsUsed: ['Read', 'Bash', 'Grep'], toolCallCount: 5 }),
      result({ toolsUsed: ['Read', 'Grep'], toolCallCount: 4 }),
    ], 100);
    expect(aggregation.totalToolCalls).toBe(11);
    expect(aggregation.agentResults.map((entry) => entry.stats.toolCalls)).toEqual([2, 5, 4]);
  });

  it('does not invent a call count when an executor did not report it', () => {
    expect(aggregateTeamResults([result({ toolsUsed: ['Read'] })], 10).totalToolCalls).toBeNull();
  });

  it('keeps failed, blocked, and cancelled agent details in the result structure', () => {
    const aggregation = aggregateTeamResults([
      result({ taskId: 'ok', role: 'coder', success: true, output: 'done' }),
      result({
        taskId: 'blocked',
        role: 'tester',
        success: false,
        output: '',
        error: 'Blocked by failed dependencies: ok',
        blocked: true,
        iterations: 0,
        duration: 0,
      }),
      result({
        taskId: 'cancelled',
        role: 'reviewer',
        success: false,
        output: '',
        error: 'Cancelled before start',
        cancelled: true,
        iterations: 0,
        duration: 0,
      }),
    ], 10);

    expect(aggregation.successRate).toBeCloseTo(1 / 3);

    const blocked = aggregation.agentResults.find((entry) => entry.agentId === 'blocked');
    expect(blocked).toMatchObject({
      status: 'failed',
      blocked: true,
      error: 'Blocked by failed dependencies: ok',
      resultPreview: 'Blocked by failed dependencies: ok',
    });

    const cancelled = aggregation.agentResults.find((entry) => entry.agentId === 'cancelled');
    expect(cancelled).toMatchObject({
      status: 'failed',
      cancelled: true,
      error: 'Cancelled before start',
      resultPreview: 'Cancelled before start',
    });
  });
});
