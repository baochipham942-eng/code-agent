// ============================================================================
// WaitAgent (native ToolModule) Tests — Wave 3 multiagent
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

const getSpawnGuardMock = vi.fn();

vi.mock('../../../../../src/main/agent/spawnGuard', () => ({
  getSpawnGuard: () => getSpawnGuardMock(),
}));

import { waitAgentModule } from '../../../../../src/main/tools/modules/multiagent/waitAgent';

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
  waitFor: ReturnType<typeof vi.fn>;
}

function makeMockGuard(overrides: Partial<MockGuard> = {}): MockGuard {
  return {
    get: vi.fn().mockReturnValue({ id: 'a1', status: 'running', role: 'coder' }),
    waitFor: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('wait_agent schema', () => {
  it('对齐 legacy schema (readOnly + allowInPlanMode)', () => {
    expect(waitAgentModule.schema.name).toBe('wait_agent');
    expect(waitAgentModule.schema.inputSchema.required).toEqual(['agentIds']);
    expect(waitAgentModule.schema.category).toBe('multiagent');
    expect(waitAgentModule.schema.permissionLevel).toBe('read');
    expect(waitAgentModule.schema.readOnly).toBe(true);
    expect(waitAgentModule.schema.allowInPlanMode).toBe(true);
  });
});

describe('wait_agent behavior', () => {
  it('agentIds 缺失或空数组 → INVALID_ARGS', async () => {
    const handler = await waitAgentModule.createHandler();
    const r1 = await handler.execute({}, makeCtx(), allowAll);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('INVALID_ARGS');
    const r2 = await handler.execute({ agentIds: [] }, makeCtx(), allowAll);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('INVALID_ARGS');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await waitAgentModule.createHandler();
    const result = await handler.execute({ agentIds: ['a1'] }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await waitAgentModule.createHandler();
    const result = await handler.execute(
      { agentIds: ['a1'] },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('未知 agent → NOT_FOUND', async () => {
    const guard = makeMockGuard({ get: vi.fn().mockReturnValue(undefined) });
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await waitAgentModule.createHandler();
    const result = await handler.execute(
      { agentIds: ['a1', 'a2'] },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.error).toContain('a1, a2');
    }
  });

  it('happy path 全部完成（含 stats）', async () => {
    const completed = new Map([
      [
        'a1',
        {
          status: 'completed',
          role: 'coder',
          createdAt: 1000,
          completedAt: 1500,
          result: {
            output: 'done',
            iterations: 3,
            toolsUsed: ['read', 'edit'],
            cost: 0.1234,
          },
        },
      ],
    ]);
    const guard = makeMockGuard({
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'running', role: 'coder' }),
      waitFor: vi.fn().mockResolvedValue(completed),
    });
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await waitAgentModule.createHandler();
    const result = await handler.execute({ agentIds: ['a1'] }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('all done');
      expect(result.output).toContain('✅ [a1] coder — completed (500ms)');
      expect(result.output).toContain('Result: done');
      expect(result.output).toContain('Stats: 3 iterations, 2 tools, $0.1234');
    }
  });

  it('result.output 超 1200 字符截断 + ...', async () => {
    const longOutput = 'x'.repeat(2000);
    const map = new Map([
      [
        'a1',
        {
          status: 'completed',
          role: 'explorer',
          createdAt: 0,
          completedAt: 100,
          result: { output: longOutput, iterations: 1, toolsUsed: [] },
        },
      ],
    ]);
    const guard = makeMockGuard({
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'running', role: 'explorer' }),
      waitFor: vi.fn().mockResolvedValue(map),
    });
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await waitAgentModule.createHandler();
    const result = await handler.execute({ agentIds: ['a1'] }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('x'.repeat(1200) + '...');
      expect(result.output.indexOf('xxxx...')).toBeGreaterThan(0);
    }
  });

  it('timeout — 部分仍 running 时 allDone=false', async () => {
    const map = new Map([
      ['a1', { status: 'running', role: 'coder', createdAt: 0 }],
    ]);
    const guard = makeMockGuard({
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'running', role: 'coder' }),
      waitFor: vi.fn().mockResolvedValue(map),
    });
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await waitAgentModule.createHandler();
    const result = await handler.execute(
      { agentIds: ['a1'], timeoutMs: 5_000 },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('timeout — some still running');
      expect(result.output).toContain('Still in progress after 5000ms timeout');
    }
  });

  it('timeoutMs 超 600s 被钳到 600s', async () => {
    const guard = makeMockGuard({
      get: vi.fn().mockReturnValue({ id: 'a1', status: 'running', role: 'coder' }),
      waitFor: vi.fn().mockResolvedValue(new Map()),
    });
    getSpawnGuardMock.mockReturnValue(guard);
    const handler = await waitAgentModule.createHandler();
    await handler.execute(
      { agentIds: ['a1'], timeoutMs: 9_999_999 },
      makeCtx(),
      allowAll,
    );
    expect(guard.waitFor).toHaveBeenCalledWith(['a1'], 600_000);
  });
});
