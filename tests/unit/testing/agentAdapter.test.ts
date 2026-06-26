import { describe, expect, it, vi } from 'vitest';
import type { AgentLoop } from '../../../src/host/agent/agentLoop';
import { AgentLoopAdapter, MockAgentAdapter } from '../../../src/host/testing/agentAdapter';
import type { ToolExecutionRecord } from '../../../src/host/testing/types';

function createToolExecutionRecord(): ToolExecutionRecord {
  return {
    tool: 'read_file',
    input: { path: '/tmp/example.txt' },
    output: 'ok',
    success: true,
    duration: 12,
    timestamp: 123,
  };
}

describe('AgentLoopAdapter', () => {
  it('extracts assistant messages, tool executions, and turn count from loop state', async () => {
    const toolExecution = createToolExecutionRecord();
    const loop = {
      run: vi.fn().mockResolvedValue(undefined),
      state: {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
          { role: 'assistant', content: '' },
        ],
        toolExecutions: [toolExecution],
        turnCount: 3,
      },
    } as unknown as AgentLoop;

    const adapter = new AgentLoopAdapter(loop, {
      name: 'test-agent',
      model: 'test-model',
      provider: 'test-provider',
    });

    await expect(adapter.sendMessage('hello')).resolves.toEqual({
      responses: ['world'],
      toolExecutions: [toolExecution],
      turnCount: 3,
      errors: [],
    });
    expect(loop.run).toHaveBeenCalledWith('hello');
  });

  it('calls reset when the loop exposes the test-only reset facade', async () => {
    const reset = vi.fn().mockResolvedValue(undefined);
    const loop = {
      run: vi.fn().mockResolvedValue(undefined),
      reset,
    } as unknown as AgentLoop;

    const adapter = new AgentLoopAdapter(loop, {
      name: 'test-agent',
      model: 'test-model',
      provider: 'test-provider',
    });

    await adapter.reset();

    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('MockAgentAdapter', () => {
  it('returns configured responses by prompt pattern', async () => {
    const adapter = new MockAgentAdapter();
    const toolExecution = createToolExecutionRecord();

    adapter.setMockResponse('hello', {
      responses: ['configured'],
      toolExecutions: [toolExecution],
      turnCount: 2,
    });

    await expect(adapter.sendMessage('say hello')).resolves.toEqual({
      responses: ['configured'],
      toolExecutions: [toolExecution],
      turnCount: 2,
      errors: [],
    });
  });
});
