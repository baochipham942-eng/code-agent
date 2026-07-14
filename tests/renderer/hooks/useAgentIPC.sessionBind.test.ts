import { describe, expect, it, vi } from 'vitest';
import { resolveEffectiveSessionIdForSend } from '../../../src/renderer/hooks/agent/useAgentIPC';

describe('resolveEffectiveSessionIdForSend (B4 session-create race)', () => {
  it('awaits in-flight create and binds to the new session, not the pre-create currentSessionId', async () => {
    let currentSessionId: string | null = 'session-old';
    let releaseCreate!: (session: { id: string }) => void;
    const pendingCreate = new Promise<{ id: string }>((resolve) => {
      releaseCreate = resolve;
    });

    const resolvePromise = resolveEffectiveSessionIdForSend({
      getCurrentSessionId: () => currentSessionId,
      getPendingSessionCreate: () => pendingCreate,
      createFallbackSession: async () => null,
    });

    // Create still in flight — old session would be wrong bind target.
    expect(currentSessionId).toBe('session-old');

    currentSessionId = 'session-new';
    releaseCreate({ id: 'session-new' });

    await expect(resolvePromise).resolves.toBe('session-new');
  });

  it('prefers explicit envelope.sessionId after pending create settles', async () => {
    let currentSessionId: string | null = 'session-old';
    const pendingCreate = Promise.resolve({ id: 'session-new' }).then((session) => {
      currentSessionId = session.id;
      return session;
    });

    await expect(resolveEffectiveSessionIdForSend({
      envelopeSessionId: 'session-pinned',
      getCurrentSessionId: () => currentSessionId,
      getPendingSessionCreate: () => pendingCreate,
      createFallbackSession: async () => null,
    })).resolves.toBe('session-pinned');
  });

  it('creates a fallback session when none is current and no create is pending', async () => {
    const createFallbackSession = vi.fn(async () => ({ id: 'session-fallback' }));

    await expect(resolveEffectiveSessionIdForSend({
      getCurrentSessionId: () => null,
      getPendingSessionCreate: () => null,
      createFallbackSession,
    })).resolves.toBe('session-fallback');
    expect(createFallbackSession).toHaveBeenCalledOnce();
  });
});
