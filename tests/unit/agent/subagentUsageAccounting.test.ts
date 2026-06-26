import { describe, expect, it } from 'vitest';
import {
  addSubagentUsage,
  extractSubagentUsage,
} from '../../../src/host/agent/subagentUsageAccounting';

describe('subagent usage accounting', () => {
  it('extracts Task child usage from multiagent result metadata', () => {
    expect(extractSubagentUsage({
      tool: 'Task',
      result: {
        cost: 0.125,
        tokensUsed: 321,
      },
    })).toEqual({
      cost: 0.125,
      tokensUsed: 321,
    });
  });

  it('extracts spawn_agent child usage from legacy metadata wrapped under result', () => {
    expect(extractSubagentUsage({
      tool: 'spawn_agent',
      result: {
        agentId: 'agent_coder_1',
        cost: 0.25,
        tokensUsed: 456,
      },
    })).toEqual({
      cost: 0.25,
      tokensUsed: 456,
    });
  });

  it('ignores non-numeric fields and accumulates into existing totals', () => {
    const totals = addSubagentUsage(
      { cost: 0.5, tokensUsed: 100 },
      { cost: '0.9', tokensUsed: 20 },
    );

    expect(totals).toEqual({
      cost: 0.5,
      tokensUsed: 120,
    });
  });
});
