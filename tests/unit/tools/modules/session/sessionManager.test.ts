import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import type { Session } from '../../../../../src/shared/contract/session';

const mocks = vi.hoisted(() => ({
  sessionManager: {
    listSessions: vi.fn(),
    listArchivedSessions: vi.fn(),
    getSession: vi.fn(),
    createSession: vi.fn(),
    addMessageToSession: vi.fn(),
    archiveSession: vi.fn(),
    unarchiveSession: vi.fn(),
    updateSession: vi.fn(),
    setCurrentSession: vi.fn(),
  },
  taskManager: {
    getSessionState: vi.fn(),
  },
  resolveSessionDefaultModelConfig: vi.fn(),
}));

vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => mocks.sessionManager,
}));

vi.mock('../../../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => mocks.taskManager,
}));

vi.mock('../../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: (...args: unknown[]) => mocks.resolveSessionDefaultModelConfig(...args),
}));

import { sessionManagerModule } from '../../../../../src/host/tools/modules/session/sessionManager';

const parentModel = { provider: 'openai', model: 'gpt-test-parent' } as const;
const defaultModel = { provider: 'openai', model: 'gpt-test-default' } as const;

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'parent-session',
    workingDir: '/repo',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: vi.fn(),
    currentToolCallId: 'tool-call-1',
    ...overrides,
  } as unknown as ToolContext;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: 'Session 1',
    modelConfig: defaultModel,
    workingDirectory: '/repo',
    type: 'chat',
    status: 'idle',
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = vi.fn(async () => ({ allow: true as const }));
const denyAll: CanUseToolFn = vi.fn(async () => ({ allow: false as const, reason: 'blocked' }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionManager.listSessions.mockResolvedValue([]);
  mocks.sessionManager.listArchivedSessions.mockResolvedValue([]);
  mocks.sessionManager.getSession.mockResolvedValue(null);
  mocks.sessionManager.createSession.mockImplementation(async (options: Partial<Session>) => makeSession({
    id: 'created-session',
    title: options.title,
    modelConfig: options.modelConfig,
    workingDirectory: options.workingDirectory,
    parentSessionId: options.parentSessionId,
    sourceRunId: options.sourceRunId,
    origin: options.origin,
    readOnly: options.readOnly,
  }));
  mocks.sessionManager.addMessageToSession.mockResolvedValue(undefined);
  mocks.sessionManager.archiveSession.mockResolvedValue(null);
  mocks.sessionManager.unarchiveSession.mockResolvedValue(null);
  mocks.sessionManager.updateSession.mockResolvedValue(undefined);
  mocks.taskManager.getSessionState.mockReturnValue({ status: 'idle' });
  mocks.resolveSessionDefaultModelConfig.mockReturnValue(defaultModel);
});

describe('SessionManager schema', () => {
  it('exposes the supported action set and intentionally omits delete', () => {
    expect(sessionManagerModule.schema.name).toBe('SessionManager');
    expect(sessionManagerModule.schema.category).toBe('planning');
    expect(sessionManagerModule.schema.readOnly).toBe(false);
    expect(sessionManagerModule.schema.inputSchema.required).toEqual(['action']);

    const props = sessionManagerModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toEqual(['list', 'get', 'create', 'archive', 'unarchive', 'rename']);
    expect(props.action.enum).not.toContain('delete');
  });
});

describe('SessionManager dispatch', () => {
  it('unknown action returns INVALID_ARGS', async () => {
    const handler = await sessionManagerModule.createHandler();

    const result = await handler.execute({ action: 'delete' }, makeCtx(), allowAll);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('aborted context returns ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await sessionManagerModule.createHandler();

    const result = await handler.execute(
      { action: 'list' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('list supports active/all/archived scopes and cwd filtering', async () => {
    mocks.sessionManager.listSessions.mockResolvedValue([
      makeSession({ id: 's1', title: 'Current cwd', workingDirectory: '/repo' }),
      makeSession({ id: 's2', title: 'Other cwd', workingDirectory: '/other' }),
    ]);
    const handler = await sessionManagerModule.createHandler();

    const active = await handler.execute(
      { action: 'list', scope: 'active', currentWorkingDirectoryOnly: true },
      makeCtx({ workingDir: '/repo' }),
      allowAll,
    );

    expect(active.ok).toBe(true);
    if (active.ok) {
      expect(active.output).toContain('s1');
      expect(active.output).not.toContain('s2');
      expect(active.meta?.sessions).toHaveLength(1);
    }
    expect(mocks.sessionManager.listSessions).toHaveBeenCalledWith({ limit: 20, includeArchived: false });

    mocks.sessionManager.listArchivedSessions.mockResolvedValue([
      makeSession({ id: 'archived-1', title: 'Unique archived title', status: 'archived', isArchived: true }),
      makeSession({ id: 'archived-2', title: 'Old unrelated', status: 'archived', isArchived: true }),
    ]);
    const archived = await handler.execute(
      { action: 'list', scope: 'archived', limit: 5, query: 'Unique' },
      makeCtx(),
      allowAll,
    );

    expect(archived.ok).toBe(true);
    if (archived.ok) {
      expect(archived.output).toContain('archived-1');
      expect(archived.output).not.toContain('archived-2');
      expect(archived.meta?.sessions).toHaveLength(1);
    }
    expect(mocks.sessionManager.listArchivedSessions).toHaveBeenCalledWith(5, 0);
  });

  it('get returns NOT_FOUND for missing sessions', async () => {
    const handler = await sessionManagerModule.createHandler();

    const result = await handler.execute({ action: 'get', sessionId: 'missing' }, makeCtx(), allowAll);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  it('create uses SessionManager directly without switching the current session', async () => {
    const parent = makeSession({
      id: 'parent-session',
      title: 'Parent',
      modelConfig: parentModel,
      workingDirectory: '/repo',
    });
    const created = makeSession({
      id: 'created-session',
      title: 'Child',
      modelConfig: parentModel,
      workingDirectory: '/repo',
      parentSessionId: parent.id,
      sourceRunId: 'tool-call-1',
      origin: { kind: 'agent_session_manager', id: parent.id, name: 'SessionManager' },
      readOnly: true,
    });
    mocks.sessionManager.getSession.mockImplementation(async (id: string) => {
      if (id === parent.id) return parent;
      if (id === created.id) return created;
      return null;
    });
    mocks.sessionManager.createSession.mockResolvedValue(created);
    const handler = await sessionManagerModule.createHandler();

    const result = await handler.execute(
      {
        action: 'create',
        title: 'Child',
        handoffContent: 'Continue this in the new session.',
        readOnly: true,
      },
      makeCtx({ sessionId: parent.id, currentToolCallId: 'tool-call-1' }),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(mocks.sessionManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Child',
      modelConfig: parentModel,
      workingDirectory: '/repo',
      parentSessionId: parent.id,
      sourceRunId: 'tool-call-1',
      readOnly: true,
      origin: expect.objectContaining({
        kind: 'agent_session_manager',
        id: parent.id,
        name: 'SessionManager',
      }),
    }));
    expect(mocks.sessionManager.addMessageToSession).toHaveBeenCalledWith(
      created.id,
      expect.objectContaining({
        role: 'user',
        content: 'Continue this in the new session.',
        source: 'system',
      }),
    );
    expect(mocks.sessionManager.setCurrentSession).not.toHaveBeenCalled();
    expect(mocks.resolveSessionDefaultModelConfig).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.meta?.currentSessionPreserved).toBe(true);
      expect(result.meta?.handoffMessageCreated).toBe(true);
    }
  });

  it('create can fall back to default model when there is no parent session', async () => {
    const created = makeSession({
      id: 'created-session',
      title: 'Detached',
      modelConfig: defaultModel,
      workingDirectory: undefined,
    });
    mocks.sessionManager.createSession.mockResolvedValue(created);
    mocks.sessionManager.getSession.mockImplementation(async (id: string) => {
      if (id === created.id) return created;
      return null;
    });
    const handler = await sessionManagerModule.createHandler();

    const result = await handler.execute(
      { action: 'create', title: 'Detached', inheritCurrentContext: false },
      makeCtx({ sessionId: 'protocol-unknown', workingDir: '/repo' }),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(mocks.resolveSessionDefaultModelConfig).toHaveBeenCalled();
    expect(mocks.sessionManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Detached',
      modelConfig: defaultModel,
      workingDirectory: undefined,
      parentSessionId: undefined,
    }));
  });

  it('create does not inherit model or cwd when inheritCurrentContext is false', async () => {
    const parent = makeSession({
      id: 'parent-session',
      title: 'Parent',
      modelConfig: parentModel,
      workingDirectory: '/repo',
    });
    const created = makeSession({
      id: 'created-session',
      title: 'Detached child',
      modelConfig: defaultModel,
      workingDirectory: undefined,
      parentSessionId: parent.id,
    });
    mocks.sessionManager.getSession.mockImplementation(async (id: string) => {
      if (id === parent.id) return parent;
      if (id === created.id) return created;
      return null;
    });
    mocks.sessionManager.createSession.mockResolvedValue(created);
    const handler = await sessionManagerModule.createHandler();

    const result = await handler.execute(
      { action: 'create', title: 'Detached child', inheritCurrentContext: false },
      makeCtx({ sessionId: parent.id, workingDir: '/repo' }),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(mocks.resolveSessionDefaultModelConfig).toHaveBeenCalled();
    expect(mocks.sessionManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Detached child',
      modelConfig: defaultModel,
      workingDirectory: undefined,
      parentSessionId: parent.id,
    }));
  });

  it('create stops on permission denial', async () => {
    const handler = await sessionManagerModule.createHandler();

    const result = await handler.execute({ action: 'create', title: 'Nope' }, makeCtx(), denyAll);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    expect(mocks.sessionManager.createSession).not.toHaveBeenCalled();
  });

  it('archive refuses the current session before requesting permission', async () => {
    mocks.sessionManager.getSession.mockResolvedValue(makeSession({ id: 'parent-session' }));
    const permission = vi.fn(async () => ({ allow: true as const }));
    const handler = await sessionManagerModule.createHandler();

    const result = await handler.execute(
      { action: 'archive', sessionId: 'parent-session' },
      makeCtx({ sessionId: 'parent-session' }),
      permission,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CURRENT_SESSION_DENIED');
    expect(permission).not.toHaveBeenCalled();
    expect(mocks.sessionManager.archiveSession).not.toHaveBeenCalled();
  });

  it('archive refuses running sessions before requesting permission', async () => {
    mocks.sessionManager.getSession.mockResolvedValue(makeSession({ id: 'target-session', status: 'idle' }));
    mocks.taskManager.getSessionState.mockReturnValue({ status: 'running' });
    const permission = vi.fn(async () => ({ allow: true as const }));
    const handler = await sessionManagerModule.createHandler();

    const result = await handler.execute(
      { action: 'archive', sessionId: 'target-session' },
      makeCtx(),
      permission,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SESSION_RUNNING');
    expect(permission).not.toHaveBeenCalled();
    expect(mocks.sessionManager.archiveSession).not.toHaveBeenCalled();
  });

  it('archive delegates to SessionManager and records previous status', async () => {
    const target = makeSession({ id: 'target-session', title: 'Target', status: 'idle' });
    const archived = makeSession({
      ...target,
      status: 'archived',
      isArchived: true,
      archivedAt: 123,
    });
    mocks.sessionManager.getSession.mockResolvedValue(target);
    mocks.sessionManager.archiveSession.mockResolvedValue(archived);
    const permission = vi.fn(async () => ({ allow: true as const }));
    const handler = await sessionManagerModule.createHandler();

    const result = await handler.execute(
      { action: 'archive', sessionId: target.id, reason: 'cleanup' },
      makeCtx(),
      permission,
    );

    expect(result.ok).toBe(true);
    expect(mocks.sessionManager.archiveSession).toHaveBeenCalledWith(target.id);
    expect(permission).toHaveBeenCalledWith(
      'SessionManager',
      expect.objectContaining({ action: 'archive', sessionId: target.id }),
      'cleanup',
      expect.objectContaining({ dangerLevel: 'warning' }),
    );
    if (result.ok) {
      expect(result.meta?.previousStatus).toBe('idle');
      expect(result.meta?.session).toMatchObject({ id: target.id, isArchived: true });
    }
  });

  it('unarchive delegates to SessionManager', async () => {
    const target = makeSession({ id: 'archived-session', status: 'archived', isArchived: true });
    const restored = makeSession({ id: target.id, status: 'idle', isArchived: false });
    mocks.sessionManager.getSession.mockResolvedValue(target);
    mocks.sessionManager.unarchiveSession.mockResolvedValue(restored);
    const handler = await sessionManagerModule.createHandler();

    const result = await handler.execute(
      { action: 'unarchive', sessionId: target.id },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(mocks.sessionManager.unarchiveSession).toHaveBeenCalledWith(target.id);
    if (result.ok) expect(result.meta?.session).toMatchObject({ id: target.id, isArchived: false });
  });

  it('rename validates title and updates the target session', async () => {
    const target = makeSession({ id: 'target-session', title: 'Old' });
    const renamed = makeSession({ id: 'target-session', title: 'New' });
    mocks.sessionManager.getSession
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(renamed);
    const handler = await sessionManagerModule.createHandler();

    const invalid = await handler.execute(
      { action: 'rename', sessionId: target.id, title: '   ' },
      makeCtx(),
      allowAll,
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.code).toBe('INVALID_ARGS');

    mocks.sessionManager.getSession.mockReset();
    mocks.sessionManager.getSession
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(renamed);
    const result = await handler.execute(
      { action: 'rename', sessionId: target.id, title: 'New' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(mocks.sessionManager.updateSession).toHaveBeenCalledWith(
      target.id,
      expect.objectContaining({ title: 'New' }),
    );
    if (result.ok) expect(result.meta?.previousTitle).toBe('Old');
  });
});
