import { describe, expect, it, vi } from 'vitest';

import {
  SessionRewindService,
  type SessionRewindServiceDatabase,
} from '../../../src/host/services/sessionRewind/SessionRewindService';
import type {
  PromptRewindRestoreResult,
  PromptRewindResult,
} from '../../../src/host/services/core/repositories/SessionRepository';

function database(): SessionRewindServiceDatabase {
  return {
    applyPromptRewind: vi.fn((): PromptRewindResult => ({
      rewindId: 'rewind-1',
      anchorMessage: {
        id: 'u2',
        role: 'user',
        content: 'rewrite this',
        timestamp: 30,
        attachments: [{
          id: 'attachment-brief',
          type: 'file',
          category: 'document',
          name: 'brief.md',
          size: 12,
          mimeType: 'text/markdown',
        }],
        visibility: 'active',
      },
      hiddenMessageIds: ['a2'],
      hiddenMessageCount: 1,
      activeMessages: [
        { id: 'u1', role: 'user', content: 'before', timestamp: 10 },
        { id: 'u2', role: 'user', content: 'rewrite this', timestamp: 30 },
      ],
    })),
    restorePromptRewind: vi.fn((): PromptRewindRestoreResult => ({
      rewindId: 'rewind-1',
      restoredMessageCount: 1,
      activeMessages: [
        { id: 'u1', role: 'user', content: 'before', timestamp: 10 },
        { id: 'u2', role: 'user', content: 'rewrite this', timestamp: 30 },
      ],
    })),
  };
}

describe('SessionRewindService', () => {
  it('keeps the anchor visible, returns an empty draft, and leaves workspace files untouched', async () => {
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
      hiddenMessageCount: 1,
      draft: { content: '' },
    });
    expect(result.activeMessages.map((message) => message.id)).toEqual(['u1', 'u2']);
    expect(result.draft.attachments).toBeUndefined();
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
    expect(result.restoredMessageCount).toBe(1);
    expect(setSessionContext).toHaveBeenCalledWith('session-1', result.activeMessages);
  });

  it.each([
    ['rewind', 'rewindConversation'] as const,
    ['restore', 'restoreConversation'] as const,
  ])(
    'returns the committed %s result when the runtime projection refresh fails',
    async (phase, operation) => {
      const db = database();
      const projectionError = new Error('injected projection failure');
      const onProjectionFailure = vi.fn();
      const service = new SessionRewindService(db, {
        getRuntimeStatus: () => 'idle',
        setSessionContext: () => {
          throw projectionError;
        },
        onProjectionFailure,
        ownerUserId: null,
      });

      const result = operation === 'rewindConversation'
        ? await service.rewindConversation({
          sessionId: 'session-1',
          anchorUserMessageId: 'u2',
          idempotencyKey: 'rewind-request-1',
        })
        : await service.restoreConversation({
          sessionId: 'session-1',
          rewindId: 'rewind-1',
        });

      expect(result.success).toBe(true);
      expect(onProjectionFailure).toHaveBeenCalledWith(
        phase,
        'session-1',
        projectionError,
      );
      expect(
        operation === 'rewindConversation'
          ? db.applyPromptRewind
          : db.restorePromptRewind,
      ).toHaveBeenCalledTimes(1);
    },
  );

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
