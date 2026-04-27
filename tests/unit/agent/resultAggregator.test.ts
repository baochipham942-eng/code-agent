import { describe, expect, it } from 'vitest';
import { aggregateTeamResults } from '../../../src/main/agent/resultAggregator';
import type { AgentTaskResult } from '../../../src/main/agent/parallelAgentCoordinator';

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
