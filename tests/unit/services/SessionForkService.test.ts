import { describe, expect, it, vi } from 'vitest';

import {
  SessionForkService,
  type SessionForkServiceDatabase,
} from '../../../src/host/services/sessionFork/SessionForkService';
import { SessionForkError } from '../../../src/shared/contract/sessionFork';

const sourceSession = {
  id: 'source',
  userId: 'user-1',
  title: 'Source task',
  modelConfig: { provider: 'openai', model: 'gpt-5' },
  workingDirectory: '/repo',
  createdAt: 1,
  updatedAt: 2,
  status: 'idle',
  engine: { kind: 'native', model: 'gpt-5', cwd: '/repo' },
  memoryMode: 'auto',
  projectId: 'project-1',
};

const childSession = {
  ...sourceSession,
  id: 'child-1',
  title: 'Source task · 分支',
  parentSessionId: 'source',
  createdAt: 3,
  updatedAt: 3,
};

function database(): SessionForkServiceDatabase {
  return {
    getSession: vi.fn((id: string, options?: { userId?: string | null }) => {
      const session = id === sourceSession.id ? sourceSession : id === childSession.id ? childSession : null;
      if (!session || options?.userId === undefined) return session;
      return session.userId === options.userId ? session : null;
    }),
    createSessionFork: vi.fn((input) => ({
      forkId: 'fork-1',
      childSessionId: childSession.id,
      copiedMessageCount: 4,
      sourcePrefixDigest: 'digest',
      lineage: {
        forkId: 'fork-1',
        rootSessionId: sourceSession.id,
        parentSessionId: sourceSession.id,
        childSessionId: childSession.id,
        sourceAnchorMessageId: 'a2',
        anchorChildMessageId: 'child-a2',
        depth: 1,
        workspaceMode: 'shared_current',
        contextDeliveryMode: input.contextDeliveryMode,
        status: 'completed',
        syncState: 'local_only',
        createdAt: 3,
      },
      messageMappings: [],
    })),
    getSessionForkLineage: vi.fn(() => null),
    listSessionForkChildren: vi.fn(() => []),
  };
}

describe('SessionForkService', () => {
  it('creates a native shared-current fork without mutating the source', async () => {
    const db = database();
    const service = new SessionForkService(db, {
      createId: (kind) => `${kind}-1`,
      now: () => 3,
      getRuntimeStatus: () => 'idle',
      ownerUserId: 'user-1',
    });

    const before = JSON.stringify(sourceSession);
    const result = await service.createFork({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a2',
      idempotencyKey: 'request-1',
      workspaceMode: 'shared_current',
    });

    expect(result.childSession).toEqual(childSession);
    expect(result.workspaceLabel).toBe('历史对话 + 当前文件');
    expect(db.createSessionFork).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a2',
      forkId: 'fork-1',
      childSessionId: 'child-1',
      workspaceMode: 'shared_current',
      contextDeliveryMode: 'neo_native_prefix',
      childWorkingDirectory: '/repo',
      ownerUserId: 'user-1',
    }));
    expect(db.getSession).toHaveBeenCalledWith('source', { userId: 'user-1' });
    expect(JSON.stringify(sourceSession)).toBe(before);
  });

  it.each([
    ['another user', 'user-2'],
    ['the local unowned scope', null],
  ])('rejects a source outside %s with zero writes', async (_label, ownerUserId) => {
    const db = database();
    const service = new SessionForkService(db, { ownerUserId });

    await expect(service.createFork({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a2',
      idempotencyKey: 'request-1',
      workspaceMode: 'shared_current',
    })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(db.createSessionFork).not.toHaveBeenCalled();
  });

  it('returns no lineage or children outside the owner scope without querying lineage storage', () => {
    const db = database();
    const service = new SessionForkService(db, { ownerUserId: 'user-2' });

    expect(service.getLineage('child-1')).toBeNull();
    expect(service.listChildren('source')).toEqual([]);
    expect(db.getSessionForkLineage).not.toHaveBeenCalled();
    expect(db.listSessionForkChildren).not.toHaveBeenCalled();
  });

  it('passes an owned lineage lookup through with the same owner scope', () => {
    const db = database();
    const lineage = {
      forkId: 'fork-1',
      rootSessionId: 'source',
      parentSessionId: 'source',
      childSessionId: 'child-1',
      sourceAnchorMessageId: 'a2',
      anchorChildMessageId: 'child-a2',
      depth: 1,
      workspaceMode: 'shared_current' as const,
      contextDeliveryMode: 'neo_native_prefix' as const,
      status: 'completed' as const,
      syncState: 'local_only' as const,
      createdAt: 3,
    };
    vi.mocked(db.getSessionForkLineage).mockReturnValue(lineage);
    vi.mocked(db.listSessionForkChildren).mockReturnValue([lineage]);
    const service = new SessionForkService(db, { ownerUserId: 'user-1' });

    expect(service.getLineage('child-1')).toEqual(lineage);
    expect(service.listChildren('source')).toEqual([lineage]);
    expect(db.getSessionForkLineage).toHaveBeenCalledWith('child-1', 'user-1');
    expect(db.listSessionForkChildren).toHaveBeenCalledWith('source', 'user-1');
  });

  it('filters cross-owner lineage rows even when storage ignores the requested scope', () => {
    const db = database();
    const foreignLineage = {
      forkId: 'fork-foreign',
      rootSessionId: 'source',
      parentSessionId: 'source',
      childSessionId: 'child-foreign',
      sourceAnchorMessageId: 'a2',
      anchorChildMessageId: 'foreign-a2',
      depth: 1,
      workspaceMode: 'shared_current' as const,
      contextDeliveryMode: 'neo_native_prefix' as const,
      status: 'completed' as const,
      syncState: 'local_only' as const,
      createdAt: 3,
    };
    vi.mocked(db.listSessionForkChildren).mockReturnValue([foreignLineage]);
    const service = new SessionForkService(db, { ownerUserId: 'user-1' });

    expect(service.listChildren('source')).toEqual([]);
  });

  it.each(['running', 'paused', 'queued', 'cancelling'])(
    'rejects a live %s source before any write',
    async (status) => {
      const db = database();
      const service = new SessionForkService(db, {
        getRuntimeStatus: () => status,
      });

      await expect(service.createFork({
        sourceSessionId: 'source',
        anchorAssistantMessageId: 'a2',
        idempotencyKey: 'request-1',
        workspaceMode: 'shared_current',
      })).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
      expect(db.createSessionFork).not.toHaveBeenCalled();
    },
  );

  it('fails closed for isolated_at_anchor until complete workspace evidence is supplied', async () => {
    const db = database();
    const service = new SessionForkService(db);

    await expect(service.createFork({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a2',
      idempotencyKey: 'request-1',
      workspaceMode: 'isolated_at_anchor',
    })).rejects.toEqual(expect.objectContaining<Partial<SessionForkError>>({
      code: 'EVIDENCE_INCOMPLETE',
    }));
    expect(db.createSessionFork).not.toHaveBeenCalled();
  });

  it('publishes an isolated child only through the durable workspace saga', async () => {
    const db = database();
    const isolatedChild = {
      ...childSession,
      workingDirectory: '/durable/session-fork-worktrees/child-1',
      engine: {
        kind: 'native' as const,
        model: 'gpt-5',
        cwd: '/durable/session-fork-worktrees/child-1',
      },
    };
    vi.mocked(db.getSession).mockImplementation((id, options) => {
      const session = id === sourceSession.id ? sourceSession : id === isolatedChild.id ? isolatedChild : null;
      if (!session || options?.userId === undefined) return session;
      return session.userId === options.userId ? session : null;
    });
    db.createIsolatedSessionFork = vi.fn(async (input) => ({
      forkId: 'fork-1',
      childSessionId: isolatedChild.id,
      copiedMessageCount: 4,
      sourcePrefixDigest: 'digest',
      lineage: {
        forkId: 'fork-1',
        rootSessionId: sourceSession.id,
        parentSessionId: sourceSession.id,
        childSessionId: isolatedChild.id,
        sourceAnchorMessageId: 'a2',
        anchorChildMessageId: 'child-a2',
        depth: 1,
        workspaceMode: 'isolated_at_anchor',
        contextDeliveryMode: input.contextDeliveryMode,
        status: 'completed',
        syncState: 'local_only',
        createdAt: 3,
      },
      messageMappings: [],
    }));
    const service = new SessionForkService(db, {
      createId: (kind) => `${kind}-1`,
      now: () => 3,
      ownerUserId: 'user-1',
    });

    const result = await service.createFork({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a2',
      idempotencyKey: 'isolated-request',
      workspaceMode: 'isolated_at_anchor',
    });

    expect(result.workspaceLabel).toBe('历史对话 + 锚点文件');
    expect(result.childSession.workingDirectory).toBe('/durable/session-fork-worktrees/child-1');
    expect(db.createIsolatedSessionFork).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a2',
      workspaceMode: 'isolated_at_anchor',
      ownerUserId: 'user-1',
    }));
    expect(db.createSessionFork).not.toHaveBeenCalled();
  });

  it('marks verified external engines for validated context handoff without copying runtime identity', async () => {
    const db = database();
    vi.mocked(db.getSession).mockReturnValue({
      ...sourceSession,
      engine: {
        kind: 'codex_cli',
        model: 'gpt-5',
        cwd: '/repo',
        externalSessionId: 'provider-runtime-id',
      },
    });
    const service = new SessionForkService(db);

    const result = await service.createFork({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a2',
      idempotencyKey: 'request-1',
      workspaceMode: 'shared_current',
    });
    expect(result.lineage.contextDeliveryMode).toBe('validated_context_handoff');
    expect(db.createSessionFork).toHaveBeenCalledWith(expect.objectContaining({
      contextDeliveryMode: 'validated_context_handoff',
    }));
  });

  it('fails closed for an external engine without verified handoff wiring', async () => {
    const db = database();
    vi.mocked(db.getSession).mockReturnValue({
      ...sourceSession,
      engine: { kind: 'kimi_code', cwd: '/repo' },
    });
    const service = new SessionForkService(db);

    await expect(service.createFork({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a2',
      idempotencyKey: 'request-1',
      workspaceMode: 'shared_current',
    })).rejects.toMatchObject({ code: 'CONTEXT_HANDOFF_REJECTED' });
    expect(db.createSessionFork).not.toHaveBeenCalled();
  });
});
