import { describe, expect, it, vi } from 'vitest';
import {
  requestCancelUntilSettled,
  resolveEffectiveSessionIdForSend,
} from '../../../src/renderer/hooks/agent/useAgentIPC';

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

  it('does not fall back to the stale session when an in-flight create fails', async () => {
    const createFallbackSession = vi.fn(async () => ({ id: 'session-fallback' }));

    await expect(resolveEffectiveSessionIdForSend({
      getCurrentSessionId: () => 'session-old',
      getPendingSessionCreate: () => Promise.resolve(null),
      createFallbackSession,
    })).resolves.toBe('session-fallback');
    expect(createFallbackSession).toHaveBeenCalledOnce();
  });
});

describe('requestCancelUntilSettled (A3 renderer convergence)', () => {
  it('retries cancel_requested against the same run until settlement is confirmed', async () => {
    const requestCancel = vi.fn()
      .mockResolvedValueOnce({
        message: 'cancel_requested',
        runId: 'run-1',
        sessionId: 'session-1',
      })
      .mockResolvedValueOnce({
        message: 'Cancelled',
        runId: 'run-1',
        sessionId: 'session-1',
      });
    const wait = vi.fn(async () => undefined);

    await expect(requestCancelUntilSettled({
      sessionId: 'session-1',
      requestCancel,
      isCancellationActive: () => true,
      wait,
    })).resolves.toBe(true);

    expect(requestCancel).toHaveBeenNthCalledWith(1, { sessionId: 'session-1' });
    expect(requestCancel).toHaveBeenNthCalledWith(2, {
      runId: 'run-1',
      sessionId: 'session-1',
    });
    expect(wait).toHaveBeenCalledOnce();
  });

  it('stops retrying when the terminal SSE event already settled renderer state', async () => {
    let active = true;
    const requestCancel = vi.fn(async () => ({
      message: 'cancel_requested',
      runId: 'run-2',
      sessionId: 'session-2',
    }));

    await expect(requestCancelUntilSettled({
      sessionId: 'session-2',
      requestCancel,
      isCancellationActive: () => active,
      wait: async () => {
        active = false;
      },
    })).resolves.toBe(false);
    expect(requestCancel).toHaveBeenCalledOnce();
  });
});
