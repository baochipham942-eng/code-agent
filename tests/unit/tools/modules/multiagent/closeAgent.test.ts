// ============================================================================
// CloseAgent (native ToolModule) Tests — Wave 3 multiagent
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

const getSpawnGuardMock = vi.fn();

vi.mock('../../../../../src/main/agent/spawnGuard', () => ({
  getSpawnGuard: () => getSpawnGuardMock(),
}));

import { closeAgentModule } from '../../../../../src/main/tools/modules/multiagent/closeAgent';

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

interface MockGuard {
  get: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  getRunningCount: ReturnType<typeof vi.fn>;
}

function makeMockGuard(overrides: Partial<MockGuard> = {}): MockGuard {
  return {
    get: vi.fn(),
    cancel: vi.fn().mockReturnValue(true),
    getRunningCount: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('close_agent schema', () => {
  it('对齐 legacy schema', () => {
    expect(closeAgentModule.schema.name).toBe('close_agent');
    expect(closeAgentModule.schema.inputSchema.required).toEqual(['agentId']);
    expect(closeAgentModule.schema.category).toBe('multiagent');
    expect(closeAgentModule.schema.permissionLevel).toBe('execute');
  });
});

describe('close_agent behavior', () => {
  it('缺 agentId → INVALID_ARGS', async () => {
    const handler = await closeAgentModule.createHandler();
    const result = await handler.execute({}, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await closeAgentModule.createHandler();
    const result = await handler.execute({ agentId: 'a1' }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await closeAgentModule.createHandler();
    const result = await handler.execute(
      { agentId: 'a1' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('agent 不存在 → NOT_FOUND', async () => {
    const guard = makeMockGuard({ get: vi.fn().mockReturnValue(undefined) });
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await closeAgentModule.createHandler();
    const result = await handler.execute({ agentId: 'missing' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  it('agent 非 running → 返回 ok=true 且 no-op 文案（"already X"）', async () => {
    const guard = makeMockGuard({
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'completed', role: 'coder' }),
    });
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await closeAgentModule.createHandler();
    const result = await handler.execute({ agentId: 'a1' }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('Agent [a1] is already completed. No action needed.');
    }
    expect(guard.cancel).not.toHaveBeenCalled();
  });

  it('happy path cancel running agent', async () => {
    const guard = makeMockGuard({
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'running', role: 'explorer' }),
      getRunningCount: vi.fn().mockReturnValue(2),
    });
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await closeAgentModule.createHandler();
    const onProgress = vi.fn();
    const result = await handler.execute({ agentId: 'a1' }, makeCtx(), allowAll, onProgress);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('Agent [a1] (explorer) cancelled. Running agents: 2');
      expect(result.meta).toMatchObject({
        action: 'close',
        agentId: 'a1',
        status: 'cancelled',
        targets: ['a1'],
        counts: { running: 2 },
        result: { cancelled: true, role: 'explorer' },
        artifact: expect.objectContaining({ kind: 'text', sourceTool: 'close_agent' }),
      });
    }
    expect(guard.cancel).toHaveBeenCalledWith('a1');
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'close_agent' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('cancel 失败 → DOMAIN_ERROR', async () => {
    const guard = makeMockGuard({
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'running', role: 'coder' }),
      cancel: vi.fn().mockReturnValue(false),
    });
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await closeAgentModule.createHandler();
    const result = await handler.execute({ agentId: 'a1' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DOMAIN_ERROR');
  });
});
