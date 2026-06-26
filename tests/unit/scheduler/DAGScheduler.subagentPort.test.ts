import { describe, expect, it, vi } from 'vitest';
import { DAGScheduler } from '../../../src/host/scheduler/DAGScheduler';
import { TaskDAG } from '../../../src/host/scheduler/TaskDAG';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('DAGScheduler subagent executor port', () => {
  it('executes agent tasks through the injected executor port', async () => {
    const scheduler = new DAGScheduler({
      maxParallelism: 1,
      scheduleInterval: 1,
      defaultTimeout: 5000,
    });
    const execute = vi.fn(async () => ({
      success: true,
      output: 'agent output',
      toolsUsed: ['Read'],
      iterations: 2,
    }));
    scheduler.setSubagentExecutor({ execute });
    scheduler.setAgentResolver({
      resolve: () => ({
        systemPrompt: 'system prompt',
        tools: ['Read'],
        maxIterations: 3,
      }),
    });

    const dag = new TaskDAG('dag-port', 'Port DAG');
    dag.addAgentTask('agent-a', {
      role: 'coder',
      prompt: 'do the task',
    });

    const result = await scheduler.execute(dag, {
      modelConfig: { provider: 'mock', model: 'mock-model' } as never,
      toolResolver: {} as never,
      toolContext: { currentToolCallId: 'call-1' } as never,
      workingDirectory: process.cwd(),
    });

    expect(result.success).toBe(true);
    expect(result.completedTasks).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe('do the task');
    expect(execute.mock.calls[0][1]).toMatchObject({
      name: 'agent-a',
      systemPrompt: 'system prompt',
      availableTools: ['Read'],
      maxIterations: 3,
    });
  });
});
