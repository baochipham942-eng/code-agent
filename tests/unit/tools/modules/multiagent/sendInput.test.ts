// ============================================================================
// SendInput (native ToolModule) Tests — Wave 3 multiagent
// 五链 / 错误码 / fallback 路径全覆盖
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

const getSpawnGuardMock = vi.fn();
const getCoordinatorMock = vi.fn();

vi.mock('../../../../../src/host/agent/spawnGuard', () => ({
  getSpawnGuard: () => getSpawnGuardMock(),
}));

vi.mock('../../../../../src/host/agent/parallelAgentCoordinator', () => ({
  getParallelAgentCoordinator: () => getCoordinatorMock(),
}));

import { sendInputModule } from '../../../../../src/host/tools/modules/multiagent/sendInput';

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

describe('send_input schema', () => {
  it('对齐 legacy schema', () => {
    expect(sendInputModule.schema.name).toBe('send_input');
    expect(sendInputModule.schema.inputSchema.required).toEqual(['agentId', 'message']);
    expect(sendInputModule.schema.category).toBe('multiagent');
    expect(sendInputModule.schema.permissionLevel).toBe('execute');
  });
});

describe('send_input behavior', () => {
  it('缺 agentId 或 message → INVALID_ARGS', async () => {
    const handler = await sendInputModule.createHandler();
    const r1 = await handler.execute({ agentId: 'a1' }, makeCtx(), allowAll);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('INVALID_ARGS');
    const r2 = await handler.execute({ message: 'm' }, makeCtx(), allowAll);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('INVALID_ARGS');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await sendInputModule.createHandler();
    const result = await handler.execute(
      { agentId: 'a1', message: 'hi' },
      makeCtx(),
      denyAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await sendInputModule.createHandler();
    const result = await handler.execute(
      { agentId: 'a1', message: 'hi' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('SpawnGuard miss → ParallelAgent fallback hit', async () => {
    getSpawnGuardMock.mockReturnValue({ get: vi.fn().mockReturnValue(undefined), sendMessage: vi.fn() });
    getCoordinatorMock.mockReturnValue({ sendMessage: vi.fn().mockReturnValue(true) });
    const handler = await sendInputModule.createHandler();
    const result = await handler.execute(
      { agentId: 'parallel-x', message: 'hi' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe(
        'Message queued for parallel agent [parallel-x]. It will be delivered at the start of the next iteration.',
      );
    }
  });

  it('SpawnGuard miss + ParallelAgent miss → NOT_FOUND', async () => {
    getSpawnGuardMock.mockReturnValue({ get: vi.fn().mockReturnValue(undefined), sendMessage: vi.fn() });
    getCoordinatorMock.mockReturnValue({ sendMessage: vi.fn().mockReturnValue(false) });
    const handler = await sendInputModule.createHandler();
    const result = await handler.execute(
      { agentId: 'missing', message: 'hi' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  it('SpawnGuard hit 但状态非 running → DOMAIN_ERROR', async () => {
    getSpawnGuardMock.mockReturnValue({
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'completed', role: 'coder' }),
      sendMessage: vi.fn(),
    });
    const handler = await sendInputModule.createHandler();
    const result = await handler.execute(
      { agentId: 'a1', message: 'hi' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOMAIN_ERROR');
      expect(result.error).toContain('not running');
    }
  });

  it('happy path SpawnGuard 排队', async () => {
    const guard = {
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'running', role: 'coder' }),
      sendMessage: vi.fn().mockReturnValue(true),
    };
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await sendInputModule.createHandler();
    const result = await handler.execute(
      { agentId: 'a1', message: 'next step' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe(
        'Message queued for agent [a1] (coder). It will be delivered at the start of the next iteration.',
      );
      expect(result.meta).toMatchObject({
        action: 'send',
        agentId: 'a1',
        status: 'queued',
        targets: ['a1'],
        counts: { bytes: 9 },
        result: { queued: true, route: 'spawnGuard', role: 'coder' },
        artifact: expect.objectContaining({ kind: 'text', sourceTool: 'send_input' }),
      });
    }
    expect(guard.sendMessage).toHaveBeenCalledWith('a1', 'next step');
  });

  it('SpawnGuard hit 但 sendMessage 失败 → DOMAIN_ERROR', async () => {
    getSpawnGuardMock.mockReturnValue({
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'running', role: 'coder' }),
      sendMessage: vi.fn().mockReturnValue(false),
    });
    const handler = await sendInputModule.createHandler();
    const result = await handler.execute(
      { agentId: 'a1', message: 'hi' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DOMAIN_ERROR');
  });
});
