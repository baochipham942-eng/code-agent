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
    const none = aggregateTeamResults([result({ toolsUsed: ['Read'] })], 10);
    expect(none.agentResults[0].stats.toolCalls).toBeNull();
    expect(none.unreportedToolCallAgents).toBe(1);
  });

  // ai-review #1740 Important：一个 agent 没上报，不该让整队的累加值作废。blocked/cancelled/
  // 早失败的 agent 不写 toolCallCount，原实现一遇到就把 totalToolCalls 置 null，汇总里
  // 打印成 unavailable——其余如实上报的 agent 数据被连坐丢掉。现在已报的照常累加，
  // 未报的单独计数，汇总说得出「at least N（M 个没报）」。
  it('keeps the reported agents counted when a teammate did not report', () => {
    const mixed = aggregateTeamResults([
      result({ toolsUsed: ['Read'], toolCallCount: 3 }),
      result({ toolsUsed: ['Bash'] }),
      result({ toolsUsed: ['Grep'], toolCallCount: 4 }),
    ], 100);
    expect(mixed.totalToolCalls).toBe(7);
    expect(mixed.unreportedToolCallAgents).toBe(1);
    expect(mixed.agentResults.map((entry) => entry.stats.toolCalls)).toEqual([3, null, 4]);
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
