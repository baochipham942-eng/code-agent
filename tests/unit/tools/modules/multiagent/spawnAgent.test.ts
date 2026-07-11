// ============================================================================
// SpawnAgent / AgentSpawn (native ToolModule) Tests — Wave 3 multiagent
//
// Protocol shell + native service dispatch，单测覆盖：
// - schema 字段对齐（spawn_agent 与 AgentSpawn 共享 inputSchema）
// - 五链 gate（INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_INITIALIZED）
// - 透传 args + 显式 execution context + 复制 success/error
// - onProgress 事件
// 完整 spawn 业务逻辑（worktree / parallel / fork cache 等）由
// tests/unit/agent/spawnGuard*.test.ts 等覆盖。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

const { executeSpawnAgentMock } = vi.hoisted(() => ({
  executeSpawnAgentMock: vi.fn(),
}));

vi.mock('../../../../../src/host/agent/multiagentTools/spawnAgent', () => ({
  executeSpawnAgent: executeSpawnAgentMock,
}));

import {
  spawnAgentModule,
  agentSpawnModule,
} from '../../../../../src/host/tools/modules/multiagent/spawnAgent';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess',
    workingDir: '/tmp/test',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    modelConfig: { provider: 'kimi', model: 'kimi-k2.5' },
    resolver: { getDefinition: vi.fn() },
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'no' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('spawn_agent / AgentSpawn schemas', () => {
  it('两 module 共享 inputSchema 但 description 不同', () => {
    expect(spawnAgentModule.schema.name).toBe('spawn_agent');
    expect(agentSpawnModule.schema.name).toBe('AgentSpawn');
    expect(spawnAgentModule.schema.inputSchema).toEqual(agentSpawnModule.schema.inputSchema);
    expect(spawnAgentModule.schema.description).not.toBe(agentSpawnModule.schema.description);
    expect(agentSpawnModule.schema.description).toContain('Advanced agent creation');
  });

  it('description 明确嵌套路由、并行路由和不派 agent 的边界', () => {
    expect(spawnAgentModule.schema.description).toContain('tree-shaped');
    expect(spawnAgentModule.schema.description).toContain('nested spawn');
    expect(spawnAgentModule.schema.description).toContain('parallel multi-agent');
    expect(spawnAgentModule.schema.description).toContain('single fact lookup');
    expect(spawnAgentModule.schema.description).toContain('known file location');
    expect(spawnAgentModule.schema.description).toContain('context offload');
    expect(spawnAgentModule.schema.description).toContain('2-3 layers');
  });

  it('inputSchema 含 role/task/agents/parallel/forkContext/isolation', () => {
    const props = spawnAgentModule.schema.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('role');
    expect(props).toHaveProperty('task');
    expect(props).toHaveProperty('agents');
    expect(props).toHaveProperty('parallel');
    expect(props).toHaveProperty('forkContext');
    expect(props).toHaveProperty('isolation');
  });

  it('permissionLevel = execute', () => {
    expect(spawnAgentModule.schema.permissionLevel).toBe('execute');
    expect(agentSpawnModule.schema.permissionLevel).toBe('execute');
  });
});

describe('spawn_agent five-link gates', () => {
  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await spawnAgentModule.createHandler();
    const result = await handler.execute({ role: 'coder', task: 't' }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    expect(executeSpawnAgentMock).not.toHaveBeenCalled();
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await spawnAgentModule.createHandler();
    const result = await handler.execute(
      { role: 'coder', task: 't' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('opaque service handle: 缺 ctx.modelConfig → NOT_INITIALIZED', async () => {
    const handler = await spawnAgentModule.createHandler();
    const result = await handler.execute(
      { role: 'coder', task: 't' },
      makeCtx({ modelConfig: undefined }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    expect(executeSpawnAgentMock).not.toHaveBeenCalled();
  });
});

describe('spawn_agent dispatch to protocol-native service', () => {
  it('happy path 透传 args + 桥接 ctx + adapt 结果', async () => {
    executeSpawnAgentMock.mockResolvedValue({
      success: true,
      output: 'spawned',
      metadata: { agentId: 'a1' },
    });
    const handler = await spawnAgentModule.createHandler();
    const onProgress = vi.fn();
    const result = await handler.execute(
      { role: 'coder', task: 'do thing' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('spawned');
      expect(result.meta).toMatchObject({
        agentId: 'a1',
        action: 'spawn',
        status: 'completed',
        targets: ['coder'],
        counts: { agents: 1 },
        result: { agentId: 'a1' },
        artifact: expect.objectContaining({ kind: 'text', sourceTool: 'spawn_agent' }),
      });
    }
    expect(executeSpawnAgentMock).toHaveBeenCalledWith(
      { role: 'coder', task: 'do thing' },
      expect.objectContaining({
        sessionId: 'sess',
        cwd: '/tmp/test',
        modelConfig: { provider: 'kimi', model: 'kimi-k2.5' },
        resolver: expect.any(Object),
        permission: expect.any(Object),
      }),
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'spawn_agent' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('normalizes public role aliases before dispatching to native spawn', async () => {
    executeSpawnAgentMock.mockResolvedValue({
      success: true,
      output: 'spawned',
      metadata: { agentId: 'a2' },
    });
    const handler = await agentSpawnModule.createHandler();
    const result = await handler.execute(
      { role: 'explorer', task: 'inspect', agents: [{ role: 'planner', task: 'plan' }] },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(executeSpawnAgentMock).toHaveBeenCalledWith(
      { role: 'explore', task: 'inspect', agents: [{ role: 'plan', task: 'plan' }] },
      expect.objectContaining({ cwd: '/tmp/test' }),
    );
    if (result.ok) {
      expect(result.meta).toMatchObject({
        targets: ['explore', 'plan'],
      });
    }
  });

  it('service failure → ok=false + error 透传', async () => {
    executeSpawnAgentMock.mockResolvedValue({ success: false, error: 'capacity exceeded' });
    const handler = await spawnAgentModule.createHandler();
    const result = await handler.execute(
      { role: 'coder', task: 't' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('capacity exceeded');
  });

  it('AgentSpawn 入口同样透传到 executeSpawnAgent', async () => {
    executeSpawnAgentMock.mockResolvedValue({ success: true, output: 'parallel done' });
    const handler = await agentSpawnModule.createHandler();
    const result = await handler.execute(
      { parallel: true, agents: [{ role: 'explorer', task: 'a' }] },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    expect(executeSpawnAgentMock).toHaveBeenCalled();
  });

  it('run_in_background uses a child-owned abort signal', async () => {
    const parent = new AbortController();
    let childSignal: AbortSignal | undefined;
    executeSpawnAgentMock.mockImplementation(async (_args, executionContext) => {
      childSignal = executionContext.abortSignal;
      return { success: true, output: 'background done' };
    });
    const handler = await spawnAgentModule.createHandler();
    const result = await handler.execute(
      { role: 'coder', task: 'background', run_in_background: true },
      makeCtx({ abortSignal: parent.signal }),
      allowAll,
    );

    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(childSignal).toBeDefined());
    expect(childSignal).not.toBe(parent.signal);
    parent.abort('parent-finished');
    expect(childSignal?.aborted).toBe(false);
  });
});
