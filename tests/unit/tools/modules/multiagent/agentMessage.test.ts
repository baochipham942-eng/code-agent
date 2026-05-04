// ============================================================================
// AgentMessage (native ToolModule) Tests — Wave 3 multiagent
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

const getSpawnedAgentMock = vi.fn();
const listSpawnedAgentsMock = vi.fn();
const getSpawnGuardMock = vi.fn();

vi.mock('../../../../../src/main/agent/multiagentTools/spawnAgent', () => ({
  getSpawnedAgent: (...args: unknown[]) => getSpawnedAgentMock(...args),
  listSpawnedAgents: (...args: unknown[]) => listSpawnedAgentsMock(...args),
}));

vi.mock('../../../../../src/main/agent/spawnGuard', () => ({
  getSpawnGuard: () => getSpawnGuardMock(),
}));

import { agentMessageModule } from '../../../../../src/main/tools/modules/multiagent/agentMessage';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test',
    workingDir: '/tmp/test',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent_message schema', () => {
  it('对齐 legacy schema (action enum)', () => {
    expect(agentMessageModule.schema.name).toBe('agent_message');
    expect(agentMessageModule.schema.inputSchema.required).toEqual(['action']);
    expect(agentMessageModule.schema.category).toBe('multiagent');
    expect(agentMessageModule.schema.permissionLevel).toBe('execute');
    const props = agentMessageModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toEqual(['status', 'list', 'result', 'cancel']);
  });
});

describe('agent_message behavior', () => {
  it('未知 action → INVALID_ARGS', async () => {
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute({ action: 'unknown' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute({ action: 'list' }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute(
      { action: 'list' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('list 空 → 友好文案', async () => {
    listSpawnedAgentsMock.mockReturnValue([]);
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute({ action: 'list' }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('No agents have been spawned in this session.');
    }
  });

  it('list 多个 agent → 含状态图标 + task 截断', async () => {
    listSpawnedAgentsMock.mockReturnValue([
      { id: 'a1', role: 'coder', status: 'running', task: 'a'.repeat(60) },
      { id: 'a2', role: 'reviewer', status: 'completed', task: 'short' },
    ]);
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute({ action: 'list' }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Spawned Agents (2)');
      expect(result.output).toContain('🔄 [a1] coder - running');
      expect(result.output).toContain('✅ [a2] reviewer - completed');
      expect(result.output).toMatch(/Task: a{50}\.\.\./); // 50 字符 + ...
    }
  });

  it('status 不存在 → NOT_FOUND', async () => {
    getSpawnedAgentMock.mockReturnValue(undefined);
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute(
      { action: 'status', agentId: 'missing' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  it('status 缺 agentId → INVALID_ARGS', async () => {
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute({ action: 'status' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('result running → 提示 try later', async () => {
    getSpawnedAgentMock.mockReturnValue({ id: 'a1', role: 'coder', status: 'running', task: 't' });
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute(
      { action: 'result', agentId: 'a1' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('still running');
    }
  });

  it('result failed → DOMAIN_ERROR', async () => {
    getSpawnedAgentMock.mockReturnValue({
      id: 'a1',
      role: 'coder',
      status: 'failed',
      task: 't',
      error: 'oops',
    });
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute(
      { action: 'result', agentId: 'a1' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOMAIN_ERROR');
      expect(result.error).toContain('oops');
    }
  });

  it('result completed happy path', async () => {
    getSpawnedAgentMock.mockReturnValue({
      id: 'a1',
      role: 'coder',
      status: 'completed',
      task: 'do thing',
      result: 'output text',
    });
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute(
      { action: 'result', agentId: 'a1' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Agent [a1] Result:');
      expect(result.output).toContain('Task: do thing');
      expect(result.output).toContain('output text');
    }
  });

  it('cancel 调用 SpawnGuard.cancel', async () => {
    const guard = {
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'running' }),
      cancel: vi.fn(),
    };
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute(
      { action: 'cancel', agentId: 'a1' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('Agent [a1] cancelled via abort signal.');
    }
    expect(guard.cancel).toHaveBeenCalledWith('a1');
  });

  it('cancel 已不在 running → ok 但 no-op', async () => {
    const guard = {
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'completed' }),
      cancel: vi.fn(),
    };
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await agentMessageModule.createHandler();
    const result = await handler.execute(
      { action: 'cancel', agentId: 'a1' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('not running (status: completed)');
    }
    expect(guard.cancel).not.toHaveBeenCalled();
  });
});
