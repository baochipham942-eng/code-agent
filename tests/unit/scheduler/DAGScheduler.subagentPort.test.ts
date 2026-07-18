import { describe, expect, it, vi } from 'vitest';
import { DAGScheduler } from '../../../src/host/scheduler/DAGScheduler';
import { TaskDAG } from '../../../src/host/scheduler/TaskDAG';
import type { SubagentExecutionRequest } from '../../../src/host/agent/subagentExecutorTypes';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('DAGScheduler subagent executor port', () => {
  const executionContext = (sessionId: string) => ({
    sessionId,
    cwd: process.cwd(),
    modelConfig: { provider: 'mock', model: 'mock-model' },
    resolver: { getDefinition: vi.fn() },
    permission: { request: vi.fn(async () => true) },
    events: { emit: vi.fn() },
    abortSignal: new AbortController().signal,
    currentToolCallId: 'call-1',
  });

  it('executes agent tasks through the injected executor port', async () => {
    const scheduler = new DAGScheduler({
      maxParallelism: 1,
      scheduleInterval: 1,
      defaultTimeout: 5000,
    });
    const execute = vi.fn(async (_request: SubagentExecutionRequest) => ({
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
      executionContext: executionContext('session-port') as never,
    });

    expect(result.success).toBe(true);
    expect(result.completedTasks).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].prompt).toBe('do the task');
    expect(execute.mock.calls[0][0].config).toMatchObject({
      name: 'agent-a',
      systemPrompt: 'system prompt',
      availableTools: ['Read'],
      maxIterations: 3,
    });
  });

  it('marks DAG agent tasks as teammate topology（2026-07-13 拓扑激活批：平面任务图禁递归 spawn）', async () => {
    const scheduler = new DAGScheduler({
      maxParallelism: 1,
      scheduleInterval: 1,
      defaultTimeout: 5000,
    });
    const execute = vi.fn(async (_request: SubagentExecutionRequest) => ({
      success: true,
      output: 'agent output',
      toolsUsed: [],
      iterations: 1,
    }));
    scheduler.setSubagentExecutor({ execute });
    scheduler.setAgentResolver({
      resolve: () => ({ systemPrompt: 'sp', tools: ['Read'], maxIterations: 3 }),
    });

    const dag = new TaskDAG('dag-topo', 'Topology DAG');
    dag.addAgentTask('agent-a', { role: 'coder', prompt: 'do the task' });

    await scheduler.execute(dag, {
      executionContext: executionContext('session-topo') as never,
    });

    expect(execute.mock.calls[0][0].context.executionTopology).toBe('teammate');
  });

  it('forks independent mutable state for concurrent runs with the same task id', async () => {
    const template = new DAGScheduler({
      maxParallelism: 1,
      scheduleInterval: 1,
      defaultTimeout: 5000,
    });
    const resolvers = new Map<string, (value: {
      success: boolean;
      output: string;
      toolsUsed: string[];
      iterations: number;
    }) => void>();
    const execute = vi.fn((request: { prompt: string }) => new Promise<{
      success: boolean;
      output: string;
      toolsUsed: string[];
      iterations: number;
    }>((resolve) => {
      resolvers.set(request.prompt, resolve);
    }));
    template.setSubagentExecutor({ execute });
    template.setAgentResolver({
      resolve: () => ({
        systemPrompt: 'system prompt',
        tools: ['Read'],
        maxIterations: 3,
      }),
    });

    const runA = template.createRunScheduler();
    const runB = template.createRunScheduler();
    const dagA = new TaskDAG('dag-a', 'Team A');
    const dagB = new TaskDAG('dag-b', 'Team B');
    dagA.addAgentTask('agent_coder_0', { role: 'coder', prompt: 'team-a' });
    dagB.addAgentTask('agent_coder_0', { role: 'coder', prompt: 'team-b' });

    const resultA = runA.execute(dagA, {
      executionContext: executionContext('session-a') as never,
    });
    const resultB = runB.execute(dagB, {
      executionContext: executionContext('session-b') as never,
    });

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(template.isExecuting()).toBe(false);
    expect(runA.getCurrentDAG()).toBe(dagA);
    expect(runB.getCurrentDAG()).toBe(dagB);

    resolvers.get('team-b')?.({
      success: true,
      output: 'B done',
      toolsUsed: [],
      iterations: 1,
    });
    await expect(resultB).resolves.toMatchObject({ success: true, dag: dagB });
    expect(runA.isExecuting()).toBe(true);
    expect(dagA.getTask('agent_coder_0')?.status).toBe('running');

    resolvers.get('team-a')?.({
      success: true,
      output: 'A done',
      toolsUsed: [],
      iterations: 1,
    });
    await expect(resultA).resolves.toMatchObject({ success: true, dag: dagA });
  });
});
