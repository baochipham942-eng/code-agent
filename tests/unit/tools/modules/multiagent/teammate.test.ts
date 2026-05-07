// ============================================================================
// Teammate (native ToolModule) Tests — Wave 3 multiagent
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

const getServiceMock = vi.fn();

vi.mock('../../../../../src/main/agent/teammate', () => ({
  getTeammateService: () => getServiceMock(),
}));

import { teammateModule } from '../../../../../src/main/tools/modules/multiagent/teammate';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess-1',
    workingDir: '/tmp/test',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

interface MockService {
  getAgent: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
  getInbox: ReturnType<typeof vi.fn>;
  listAgents: ReturnType<typeof vi.fn>;
  getHistory: ReturnType<typeof vi.fn>;
  getConversation: ReturnType<typeof vi.fn>;
}

function makeMockService(overrides: Partial<MockService> = {}): MockService {
  return {
    getAgent: vi.fn(),
    register: vi.fn(),
    send: vi.fn().mockReturnValue({ id: 'msg-1' }),
    respond: vi.fn().mockReturnValue({ id: 'msg-2' }),
    getInbox: vi.fn().mockReturnValue([]),
    listAgents: vi.fn().mockReturnValue([]),
    getHistory: vi.fn().mockReturnValue([]),
    getConversation: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('teammate schema', () => {
  it('对齐 legacy schema (9 个 action enum)', () => {
    expect(teammateModule.schema.name).toBe('teammate');
    expect(teammateModule.schema.inputSchema.required).toEqual(['action']);
    expect(teammateModule.schema.category).toBe('multiagent');
    expect(teammateModule.schema.permissionLevel).toBe('execute');
    const props = teammateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toEqual([
      'send', 'coordinate', 'handoff', 'query', 'respond',
      'broadcast', 'inbox', 'agents', 'history',
    ]);
  });
});

describe('teammate behavior', () => {
  it('未知 action → INVALID_ARGS', async () => {
    const handler = await teammateModule.createHandler();
    const result = await handler.execute({ action: 'foo' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await teammateModule.createHandler();
    const result = await handler.execute({ action: 'inbox' }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await teammateModule.createHandler();
    const result = await handler.execute(
      { action: 'inbox' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('opaque ctx fields: 用 ctx.agentId / ctx.subagent.agentName / agentRole 注册自身', async () => {
    const service = makeMockService();
    getServiceMock.mockReturnValue(service);
    const ctx = makeCtx({
      agentId: 'subagent-x',
      subagent: { agentName: 'Coder', agentRole: 'coder' },
    });
    const handler = await teammateModule.createHandler();
    await handler.execute({ action: 'inbox' }, ctx, allowAll);
    expect(service.register).toHaveBeenCalledWith('subagent-x', 'Coder', 'coder');
  });

  it('opaque ctx 缺失 → fallback 到 sessionId 与 "Orchestrator"', async () => {
    const service = makeMockService();
    getServiceMock.mockReturnValue(service);
    const ctx = makeCtx(); // 没有 agentId / subagent
    const handler = await teammateModule.createHandler();
    await handler.execute({ action: 'inbox' }, ctx, allowAll);
    expect(service.register).toHaveBeenCalledWith('sess-1', 'Orchestrator', 'orchestrator');
  });

  it('send 缺 to → INVALID_ARGS', async () => {
    getServiceMock.mockReturnValue(makeMockService());
    const handler = await teammateModule.createHandler();
    const result = await handler.execute(
      { action: 'send', message: 'hi' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('send 目标不存在 → NOT_FOUND', async () => {
    const service = makeMockService({
      getAgent: vi.fn((id: string) => (id === 'sess-1' ? { id: 'sess-1', name: 'me' } : undefined)),
      listAgents: vi.fn().mockReturnValue([{ id: 'a1', name: 'A1' }]),
    });
    getServiceMock.mockReturnValue(service);
    const handler = await teammateModule.createHandler();
    const result = await handler.execute(
      { action: 'send', to: 'missing', message: 'hi' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.error).toContain('a1 (A1)');
    }
  });

  it('send happy → 调用 service.send + 复刻文案', async () => {
    const service = makeMockService({
      getAgent: vi.fn().mockReturnValue({ id: 'a1', name: 'Coder1' }),
    });
    getServiceMock.mockReturnValue(service);
    const handler = await teammateModule.createHandler();
    const result = await handler.execute(
      { action: 'send', to: 'a1', message: 'hello world' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Message sent to Coder1 (a1)');
      expect(result.output).toContain('Type: send');
      expect(result.output).toContain('Message ID: msg-1');
      expect(result.meta).toMatchObject({
        action: 'send',
        agentId: 'sess-1',
        status: 'sent',
        targets: ['a1'],
        counts: { bytes: 11 },
        result: { messageId: 'msg-1', type: 'coordination' },
        artifact: expect.objectContaining({ kind: 'text', sourceTool: 'teammate' }),
      });
    }
    expect(service.send).toHaveBeenCalled();
  });

  it('respond 缺 responseTo → INVALID_ARGS', async () => {
    getServiceMock.mockReturnValue(makeMockService());
    const handler = await teammateModule.createHandler();
    const result = await handler.execute(
      { action: 'respond', to: 'a1', message: 'r' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('broadcast happy → 排除自己 + 输出 agent count', async () => {
    const service = makeMockService({
      listAgents: vi.fn().mockReturnValue([{ id: 'sess-1' }, { id: 'a1' }, { id: 'a2' }]),
    });
    getServiceMock.mockReturnValue(service);
    const handler = await teammateModule.createHandler();
    const result = await handler.execute(
      { action: 'broadcast', message: 'attention' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Broadcast sent to 2 agents');
      expect(result.meta).toMatchObject({
        action: 'broadcast',
        status: 'sent',
        targets: ['all'],
        counts: { agents: 2 },
      });
    }
  });

  it('inbox 空 → 友好文案', async () => {
    getServiceMock.mockReturnValue(makeMockService({ getInbox: vi.fn().mockReturnValue([]) }));
    const handler = await teammateModule.createHandler();
    const result = await handler.execute({ action: 'inbox' }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('No messages in inbox.');
    }
  });

  it('agents 含 self 标记', async () => {
    const service = makeMockService({
      listAgents: vi.fn().mockReturnValue([
        { id: 'sess-1', name: 'me', role: 'orch', status: 'idle', lastActiveAt: Date.now() },
      ]),
    });
    getServiceMock.mockReturnValue(service);
    const handler = await teammateModule.createHandler();
    const result = await handler.execute({ action: 'agents' }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('(you)');
    }
  });

  it('history 无 to → 总历史；带 to → 双向对话', async () => {
    const service = makeMockService({
      getHistory: vi.fn().mockReturnValue([
        { from: 'sess-1', to: 'a1', timestamp: Date.now(), content: 'hello' },
      ]),
    });
    getServiceMock.mockReturnValue(service);
    const handler = await teammateModule.createHandler();
    const r1 = await handler.execute({ action: 'history' }, makeCtx(), allowAll);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.output).toContain('Recent Messages (1)');

    const service2 = makeMockService({
      getAgent: vi.fn((id: string) => (id === 'a1' ? { id: 'a1', name: 'A1' } : undefined)),
      getConversation: vi.fn().mockReturnValue([
        { from: 'sess-1', to: 'a1', timestamp: Date.now(), content: 'hi' },
      ]),
    });
    getServiceMock.mockReturnValue(service2);
    const r2 = await handler.execute({ action: 'history', to: 'a1' }, makeCtx(), allowAll);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.output).toContain('Conversation with A1 (1 messages)');
    }
  });
});
