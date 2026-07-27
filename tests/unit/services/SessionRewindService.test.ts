import { describe, expect, it, vi } from 'vitest';

import {
  SessionRewindService,
  type SessionRewindServiceDatabase,
} from '../../../src/host/services/sessionRewind/SessionRewindService';

function database(): SessionRewindServiceDatabase {
  return {
    applyPromptRewind: vi.fn(() => ({
      rewindId: 'rewind-1',
      anchorMessage: {
        id: 'u2',
        role: 'user',
        content: 'rewrite this',
        timestamp: 30,
        attachments: [{ name: 'brief.md' }],
        visibility: 'rewound',
      },
      hiddenMessageIds: ['u2', 'a2'],
      hiddenMessageCount: 2,
      activeMessages: [{ id: 'u1', role: 'user', content: 'before', timestamp: 10 }],
    })),
    restorePromptRewind: vi.fn(() => ({
      rewindId: 'rewind-1',
      restoredMessageCount: 2,
      activeMessages: [
        { id: 'u1', role: 'user', content: 'before', timestamp: 10 },
        { id: 'u2', role: 'user', content: 'rewrite this', timestamp: 30 },
      ],
    })),
  };
}

describe('SessionRewindService', () => {
  it('rewinds conversation history only and leaves workspace files untouched', async () => {
    const db = database();
    const setSessionContext = vi.fn();
    const service = new SessionRewindService(db, {
      getRuntimeStatus: () => 'idle',
      setSessionContext,
      ownerUserId: null,
    });

    const result = await service.rewindConversation({
      sessionId: 'session-1',
      anchorUserMessageId: 'u2',
      idempotencyKey: 'rewind-request-1',
    });

    expect(db.applyPromptRewind).toHaveBeenCalledWith('session-1', 'u2', {
      idempotencyKey: 'rewind-request-1',
      ownerUserId: null,
    });
    expect(result).toMatchObject({
      success: true,
      rewindId: 'rewind-1',
      workspaceChanged: false,
      filesRestored: 0,
      filesDeleted: 0,
      hiddenMessageCount: 2,
      draft: { content: 'rewrite this', attachments: [{ name: 'brief.md' }] },
    });
    expect(setSessionContext).toHaveBeenCalledWith('session-1', result.activeMessages);
  });

  it.each(['running', 'paused', 'queued', 'cancelling'])(
    'rejects %s sessions before any database write',
    async (status) => {
      const db = database();
      const service = new SessionRewindService(db, {
        getRuntimeStatus: () => status,
        ownerUserId: null,
      });

      await expect(service.rewindConversation({
        sessionId: 'session-1',
        anchorUserMessageId: 'u2',
        idempotencyKey: 'rewind-request-1',
      })).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
      expect(db.applyPromptRewind).not.toHaveBeenCalled();
    },
  );

  it('recovers hidden messages as an explicit auditable action', async () => {
    const db = database();
    const setSessionContext = vi.fn();
    const service = new SessionRewindService(db, {
      getRuntimeStatus: () => 'idle',
      setSessionContext,
      now: () => 200,
      ownerUserId: null,
    });

    const result = await service.restoreConversation({
      sessionId: 'session-1',
      rewindId: 'rewind-1',
    });

    expect(db.restorePromptRewind).toHaveBeenCalledWith('session-1', 'rewind-1', 200, null);
    expect(result.restoredMessageCount).toBe(2);
    expect(setSessionContext).toHaveBeenCalledWith('session-1', result.activeMessages);
  });

  it('fails closed before database access when the surface did not inject an owner boundary', async () => {
    const db = database();
    const service = new SessionRewindService(db);

    await expect(service.rewindConversation({
      sessionId: 'session-1',
      anchorUserMessageId: 'u2',
      idempotencyKey: 'rewind-request-1',
    })).rejects.toMatchObject({ code: 'REWIND_OPERATION_FAILED' });
    expect(db.applyPromptRewind).not.toHaveBeenCalled();

    await expect(service.restoreConversation({
      sessionId: 'session-1',
      rewindId: 'rewind-1',
    })).rejects.toMatchObject({ code: 'REWIND_OPERATION_FAILED' });
    expect(db.restorePromptRewind).not.toHaveBeenCalled();
  });

  it('preserves repository SESSION_RUNNING failures as the public fail-closed error', async () => {
    const db = database();
    vi.mocked(db.applyPromptRewind).mockImplementation(() => {
      throw new Error('SESSION_RUNNING: durable run run-1 is recovering');
    });
    const service = new SessionRewindService(db, {
      getRuntimeStatus: () => 'idle',
      ownerUserId: null,
    });

    await expect(service.rewindConversation({
      sessionId: 'session-1',
      anchorUserMessageId: 'u2',
      idempotencyKey: 'rewind-request-1',
    })).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
  });
});
