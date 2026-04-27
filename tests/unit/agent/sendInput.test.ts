import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/infra/logger', () => ({
  LogLevel: {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dispose: vi.fn(),
  },
}));

import { initParallelAgentCoordinator } from '../../../src/main/agent/parallelAgentCoordinator';
import type { AgentTask } from '../../../src/main/agent/parallelAgentCoordinator';
import { sendInputTool } from '../../../src/main/agent/multiagentTools/sendInput';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/main/agent/spawnGuard';
import type { SubagentResult } from '../../../src/main/agent/subagentExecutor';

function keepRunning(): Promise<SubagentResult> {
  return new Promise(() => {});
}

function registerParallelInbox(taskId: string): unknown[] {
  const coordinator = initParallelAgentCoordinator();
  const task: AgentTask = {
    id: taskId,
    role: 'researcher',
    task: 'keep context warm',
    tools: [],
  };
  const taskDefinitions = (coordinator as unknown as { taskDefinitions: Map<string, AgentTask> }).taskDefinitions;
  const messageQueues = (coordinator as unknown as { messageQueues: Map<string, unknown[]> }).messageQueues;
  const queue: unknown[] = [];

  taskDefinitions.set(taskId, task);
  messageQueues.set(taskId, queue);

  return queue;
}

describe('sendInputTool', () => {
  beforeEach(() => {
    resetSpawnGuard();
    initParallelAgentCoordinator();
  });

  afterEach(() => {
    resetSpawnGuard();
    initParallelAgentCoordinator();
  });

  it('queues messages for running SpawnGuard agents first', async () => {
    const guard = getSpawnGuard();
    guard.register('agent-spawned', 'coder', 'continue work', keepRunning(), new AbortController());

    const result = await sendInputTool.execute(
      { agentId: 'agent-spawned', message: 'follow up' },
      {}
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Message queued for agent [agent-spawned]');
    expect(guard.get('agent-spawned')?.messageQueue).toHaveLength(1);
    expect(guard.get('agent-spawned')?.messageQueue[0]?.payload).toBe('follow up');
  });

  it('falls back to the parallel executor inbox when SpawnGuard misses', async () => {
    const queue = registerParallelInbox('parallel-agent');

    const result = await sendInputTool.execute(
      { agentId: 'parallel-agent', message: 'parallel follow up' },
      {}
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Message queued for parallel agent [parallel-agent]');
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ type: 'text', from: 'user', payload: 'parallel follow up' });
  });

  it('returns a clear failure for unknown agents', async () => {
    const result = await sendInputTool.execute(
      { agentId: 'missing-agent', message: 'hello?' },
      {}
    );

    expect(result).toEqual({
      success: false,
      error: 'Agent not found: missing-agent',
    });
  });

  it('does not expose interrupt in the tool schema', () => {
    expect(sendInputTool.inputSchema.properties).toHaveProperty('agentId');
    expect(sendInputTool.inputSchema.properties).toHaveProperty('message');
    expect(sendInputTool.inputSchema.properties).not.toHaveProperty('interrupt');
  });
});
