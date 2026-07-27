import { describe, expect, it, vi } from 'vitest';

import {
  SessionForkService,
  type SessionForkServiceDatabase,
} from '../../../src/host/services/sessionFork/SessionForkService';
import { SessionForkError } from '../../../src/shared/contract/sessionFork';

const sourceSession = {
  id: 'source',
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
    getSession: vi.fn((id: string) => (
      id === sourceSession.id ? sourceSession : id === childSession.id ? childSession : null
    )),
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
    }));
    expect(JSON.stringify(sourceSession)).toBe(before);
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
