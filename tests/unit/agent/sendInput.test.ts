// 行为级测试：在真实 SpawnGuard / ParallelAgentCoordinator 上验证
// send_input native module 的 fallback 路径（SpawnGuard hit / ParallelAgent
// fallback / unknown agent 三种）。
// schema 级断言已移到 tests/unit/tools/modules/multiagent/sendInput.test.ts。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
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

import { initParallelAgentCoordinator } from '../../../src/host/agent/parallelAgentCoordinator';
import type { AgentTask } from '../../../src/host/agent/parallelAgentCoordinator';
import { sendInputModule } from '../../../src/host/tools/modules/multiagent/sendInput';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutor';
import type { ToolContext, CanUseToolFn } from '../../../src/host/protocol/tools';

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

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test',
    workingDir: '/tmp/test',
    abortSignal: ctrl.signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

/** 子代理内执行 send_input 的宿主 ctx（ADR-067：落队必须铸 peer-agent；判据 spawnDepth 只有子代理管线才设）。 */
function makePeerCtx(): ToolContext {
  return makeCtx({
    agentId: 'peer-sender',
    spawnDepth: 1,
    spawnParentAgentId: 'parent-agent',
    subagent: { agentName: 'Peer', agentRole: 'coder' },
  } as Partial<ToolContext>);
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('sendInput native module (fallback paths)', () => {
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

    const handler = await sendInputModule.createHandler();
    const result = await handler.execute(
      { agentId: 'agent-spawned', message: 'follow up' },
      makePeerCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Message queued for agent [agent-spawned]');
    }
    expect(guard.get('agent-spawned')?.messageQueue).toHaveLength(1);
    expect(guard.get('agent-spawned')?.messageQueue[0]?.payload).toBe('follow up');
    // ADR-067 反向变异锚点：agent 转发的消息落队必须铸 peer-agent，不是 'user'/'parent'
    expect(guard.get('agent-spawned')?.messageQueue[0]?.origin).toMatchObject({
      senderKind: 'peer-agent',
      senderAgentId: 'peer-sender',
      sessionId: 'test',
    });
  });

  it('falls back to the parallel executor inbox when SpawnGuard misses', async () => {
    const queue = registerParallelInbox('parallel-agent');

    const handler = await sendInputModule.createHandler();
    const result = await handler.execute(
      { agentId: 'parallel-agent', message: 'parallel follow up' },
      makePeerCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Message queued for parallel agent [parallel-agent]');
    }
    expect(queue).toHaveLength(1);
    // ADR-067 反向变异锚点：coordinator 路同样铸 peer-agent + 真实 senderAgentId，不再是硬编码 'user'
    expect(queue[0]).toMatchObject({
      type: 'text',
      from: 'peer-sender',
      payload: 'parallel follow up',
      origin: { senderKind: 'peer-agent', senderAgentId: 'peer-sender', sessionId: 'test' },
    });
  });

  it('mints orchestrator origin when the main agent (no subagent ctx) sends', async () => {
    const guard = getSpawnGuard();
    guard.register('agent-spawned', 'coder', 'continue work', keepRunning(), new AbortController());

    const handler = await sendInputModule.createHandler();
    const result = await handler.execute(
      { agentId: 'agent-spawned', message: 'orchestrator follow up' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(guard.get('agent-spawned')?.messageQueue[0]?.origin).toMatchObject({
      senderKind: 'orchestrator',
      sessionId: 'test',
    });
    expect(guard.get('agent-spawned')?.messageQueue[0]?.origin?.senderAgentId).toBeUndefined();
  });

  it('returns NOT_FOUND for unknown agents', async () => {
    const handler = await sendInputModule.createHandler();
    const result = await handler.execute(
      { agentId: 'missing-agent', message: 'hello?' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.error).toBe('Agent not found: missing-agent');
    }
  });

  it('does not expose interrupt in the tool schema', () => {
    const props = sendInputModule.schema.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('agentId');
    expect(props).toHaveProperty('message');
    expect(props).not.toHaveProperty('interrupt');
  });
});
