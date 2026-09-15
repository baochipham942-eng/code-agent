import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: string; email: string; isAdmin?: boolean },
  sessionVerified: false,
  getCurrentPromptStackSummary: vi.fn(),
  registry: {
    listPrompts: vi.fn(),
    getPromptDetail: vi.fn(),
    setPromptOverride: vi.fn(),
    resetPromptOverride: vi.fn(),
  },
}));

vi.mock('../../../src/host/services/auth', () => ({
  getAuthService: () => ({
    getCurrentUser: () => mocks.currentUser,
    hasVerifiedSession: () => mocks.sessionVerified,
  }),
}));

vi.mock('../../../src/host/prompts/registry', () => ({
  listPrompts: mocks.registry.listPrompts,
  getPromptDetail: mocks.registry.getPromptDetail,
  setPromptOverride: mocks.registry.setPromptOverride,
  resetPromptOverride: mocks.registry.resetPromptOverride,
}));

vi.mock('../../../src/host/prompts/promptIndex', () => ({}));

vi.mock('../../../src/host/prompts/builder', () => ({
  SYSTEM_PROMPT: 'FULL SYSTEM PROMPT',
}));

vi.mock('../../../src/host/services/promptStack', () => ({
  getCurrentPromptStackSummary: mocks.getCurrentPromptStackSummary,
}));

import { registerPromptHandlers } from '../../../src/host/ipc/prompt.ipc';

type DomainHandler = (_: unknown, request: IPCRequest) => Promise<IPCResponse>;

function makeFakeIpc(): { handle: Mock; invoke: (request: IPCRequest) => Promise<IPCResponse> } {
  const registry = new Map<string, DomainHandler>();
  const handle = vi.fn((channel: string, fn: DomainHandler) => {
    registry.set(channel, fn);
  });
  return {
    handle,
    invoke: async (request: IPCRequest) => {
      const fn = registry.get(IPC_DOMAINS.PROMPT);
      if (!fn) throw new Error('PROMPT handler not registered');
      return fn({}, request);
    },
  };
}

describe('prompt.ipc access control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = null;
    mocks.sessionVerified = false;
    delete process.env.CODE_AGENT_ALLOW_SYSTEM_PROMPT_DEBUG;
    mocks.registry.listPrompts.mockReturnValue([
      { id: 'core.identity', category: 'core', name: 'Identity', overridden: false },
    ]);
    mocks.registry.getPromptDetail.mockReturnValue({
      id: 'core.identity',
      category: 'core',
      name: 'Identity',
      defaultText: 'default prompt',
      override: null,
      overridden: false,
    });
    mocks.getCurrentPromptStackSummary.mockReturnValue({
      sessionId: 'session-ledger',
      invocationId: 'turn-ledger',
      promptVersion: 'test-version',
      totalChars: 120,
      totalTokens: 30,
      layers: [],
      warnings: [],
    });
  });

  it('rejects unauthenticated prompt reads before exposing registry details', async () => {
    const ipc = makeFakeIpc();
    registerPromptHandlers(ipc as never);

    const response = await ipc.invoke({ action: 'list' });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(mocks.registry.listPrompts).not.toHaveBeenCalled();
  });

  it('rejects non-admin prompt overrides before mutating local prompt state', async () => {
    mocks.currentUser = { id: 'user-1', email: 'user@example.com', isAdmin: false };
    mocks.sessionVerified = true;
    const ipc = makeFakeIpc();
    registerPromptHandlers(ipc as never);

    const response = await ipc.invoke({
      action: 'set',
      payload: { id: 'core.identity', text: 'patched prompt' },
    });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(mocks.registry.setPromptOverride).not.toHaveBeenCalled();
  });

  it('allows admin prompt overrides', async () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = true;
    const ipc = makeFakeIpc();
    registerPromptHandlers(ipc as never);

    const response = await ipc.invoke({
      action: 'set',
      payload: { id: 'core.identity', text: 'patched prompt' },
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        id: 'core.identity',
        defaultText: 'default prompt',
      },
    });
    expect(mocks.registry.setPromptOverride).toHaveBeenCalledWith('core.identity', 'patched prompt');
  });

  it('requires an explicit debug env before returning full system prompt text', async () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = true;
    const ipc = makeFakeIpc();
    registerPromptHandlers(ipc as never);

    const response = await ipc.invoke({ action: 'debugSystemPrompt' });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
  });

  it('allows admin system prompt debug when the local debug env is enabled', async () => {
    process.env.CODE_AGENT_ALLOW_SYSTEM_PROMPT_DEBUG = '1';
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = true;
    const ipc = makeFakeIpc();
    registerPromptHandlers(ipc as never);

    const response = await ipc.invoke({ action: 'debugSystemPrompt' });

    expect(response).toMatchObject({
      success: true,
      data: {
        length: 18,
        preview: 'FULL SYSTEM PROMPT',
        text: 'FULL SYSTEM PROMPT',
      },
    });
  });

  it('returns prompt stack metadata without exposing system prompt text', async () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = true;
    const ipc = makeFakeIpc();
    registerPromptHandlers(ipc as never);

    const response = await ipc.invoke({
      action: 'stackSummary',
      payload: { sessionId: 'session-ledger', invocationId: 'turn-ledger' },
    });

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      sessionId: 'session-ledger',
      invocationId: 'turn-ledger',
      totalChars: 120,
    });
    expect(mocks.getCurrentPromptStackSummary).toHaveBeenCalledWith({
      sessionId: 'session-ledger',
      invocationId: 'turn-ledger',
    });
    expect(JSON.stringify(response.data)).not.toContain('FULL SYSTEM PROMPT');
  });
});

describe('prompt.ipc dispatch 特征（RQ-183 续作·PROMPT 刀迁表前钉住现状）', () => {
  const admin = () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = true;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = null;
    mocks.sessionVerified = false;
    delete process.env.CODE_AGENT_ALLOW_SYSTEM_PROMPT_DEBUG;
    mocks.registry.getPromptDetail.mockReturnValue({
      id: 'core.identity',
      category: 'core',
      name: 'Identity',
      defaultText: 'default prompt',
      override: null,
      overridden: false,
    });
  });

  it('权限门先于分发：未登录发未知 action 也返回 FORBIDDEN（不泄露 INVALID_ACTION）', async () => {
    const ipc = makeFakeIpc();
    registerPromptHandlers(ipc as never);
    expect(await ipc.invoke({ action: 'bogus' } as IPCRequest)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
  });

  it('管理员发未知 action → INVALID_ACTION + Unknown action 文案', async () => {
    admin();
    const ipc = makeFakeIpc();
    registerPromptHandlers(ipc as never);
    expect(await ipc.invoke({ action: 'bogus' } as IPCRequest)).toEqual({
      success: false,
      error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' },
    });
  });

  it('get / reset 返回详情；reset 先清 override', async () => {
    admin();
    const ipc = makeFakeIpc();
    registerPromptHandlers(ipc as never);
    expect(await ipc.invoke({ action: 'get', payload: { id: 'core.identity' } })).toMatchObject({ success: true, data: { id: 'core.identity' } });
    expect(await ipc.invoke({ action: 'reset', payload: { id: 'core.identity' } })).toMatchObject({ success: true, data: { id: 'core.identity' } });
    expect(mocks.registry.resetPromptOverride).toHaveBeenCalledWith('core.identity');
  });

  it('preview：override 优先于 defaultText；详情不存在 → data null', async () => {
    admin();
    const ipc = makeFakeIpc();
    registerPromptHandlers(ipc as never);
    mocks.registry.getPromptDetail.mockReturnValueOnce({ id: 'core.identity', defaultText: 'default prompt', override: 'patched', overridden: true });
    expect(await ipc.invoke({ action: 'preview', payload: { id: 'core.identity' } })).toEqual({
      success: true,
      data: { id: 'core.identity', live: 'patched', length: 7 },
    });
    mocks.registry.getPromptDetail.mockReturnValueOnce(null);
    expect(await ipc.invoke({ action: 'preview', payload: { id: 'missing' } })).toEqual({ success: true, data: null });
  });

  it('handler 抛错 → INTERNAL_ERROR + message', async () => {
    admin();
    const ipc = makeFakeIpc();
    registerPromptHandlers(ipc as never);
    mocks.registry.listPrompts.mockImplementationOnce(() => {
      throw new Error('registry broken');
    });
    expect(await ipc.invoke({ action: 'list' })).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'registry broken' },
    });
  });
});
