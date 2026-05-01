import { describe, expect, it } from 'vitest';
import { parseExecutionTrace } from '../e2e/claude-e2e/src/utils/trace-parser';

describe('claude e2e trace parser agent dispatches', () => {
  it('parses code-agent Task dispatch with subagent_type and prompt', () => {
    const output = [
      JSON.stringify({
        type: 'tool_call',
        data: {
          id: 'call-1',
          name: 'Task',
          arguments: {
            subagent_type: 'explore',
            prompt: 'Find the routing files',
          },
        },
      }),
      JSON.stringify({
        type: 'tool_result',
        data: {
          toolCallId: 'call-1',
          output: 'Tools used: grep, read_file\nResult: done',
          duration: 12,
        },
      }),
    ].join('\n');

    const trace = parseExecutionTrace(output);

    expect(trace.totalAgentDispatches).toBe(1);
    expect(trace.agentDispatches[0]).toMatchObject({
      id: 'call-1',
      agentType: 'explore',
      prompt: 'Find the routing files',
      duration: 12,
    });
    expect(trace.agentDispatches[0]?.toolCalls.map((tool) => tool.name)).toEqual([
      'grep',
      'read_file',
    ]);
  });

  it('parses Claude Task dispatch prompt fallbacks', () => {
    const output = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu-1',
          name: 'Task',
          input: {
            agent: 'reviewer',
            task: 'Review the patch',
          },
        }],
      },
    });

    const trace = parseExecutionTrace(output);

    expect(trace.agentDispatches[0]).toMatchObject({
      id: 'toolu-1',
      agentType: 'reviewer',
      prompt: 'Review the patch',
    });
  });
});
