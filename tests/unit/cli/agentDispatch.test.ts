import { describe, expect, it } from 'vitest';
import { getAgentDispatchInfo, isAgentDispatchToolName } from '../../../src/cli/agentDispatch';

describe('CLI agent dispatch helpers', () => {
  it('recognizes Task subagent_type and prompt', () => {
    expect(getAgentDispatchInfo('Task', {
      subagent_type: 'explore',
      prompt: 'Find relevant files',
    })).toEqual({
      agent: 'explore',
      task: 'Find relevant files',
    });
  });

  it('recognizes spawn_agent role and task', () => {
    expect(getAgentDispatchInfo('spawn_agent', {
      role: 'reviewer',
      task: 'Review the patch',
    })).toEqual({
      agent: 'reviewer',
      task: 'Review the patch',
    });
  });

  it('recognizes AgentSpawn agent and description fallbacks', () => {
    expect(getAgentDispatchInfo('AgentSpawn', {
      agent: 'planner',
      description: 'Plan the migration',
    })).toEqual({
      agent: 'planner',
      task: 'Plan the migration',
    });
  });

  it('ignores non-dispatch tools and malformed arguments', () => {
    expect(isAgentDispatchToolName('Read')).toBe(false);
    expect(getAgentDispatchInfo('Read', { prompt: 'nope' })).toBeNull();
    expect(getAgentDispatchInfo('Task', null)).toBeNull();
  });
});
