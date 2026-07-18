import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import {
  applyPermissionQueueEvent,
  reconcilePermissionQueue,
  type PermissionQueueEventDeps,
} from '../../../src/renderer/hooks/agent/effects/usePermissionQueueEffects';

interface PermissionQueueState {
  currentSessionId: string | null;
  lastEventAt: number;
  pendingPermissionRequest: PermissionRequest | null;
  pendingPermissionSessionId: string | null;
  queuedPermissionRequests: Record<string, PermissionRequest[]>;
  unreadSessionIds: string[];
}

function permissionRequest(id: string): PermissionRequest {
  return {
    id,
    type: 'command',
    tool: 'shell',
    details: { command: `echo ${id}` },
    timestamp: 100,
  };
}

function createHarness(overrides: Partial<PermissionQueueState> = {}) {
  const state: PermissionQueueState = {
    currentSessionId: null,
    lastEventAt: 0,
    pendingPermissionRequest: null,
    pendingPermissionSessionId: null,
    queuedPermissionRequests: {},
    unreadSessionIds: [],
    ...overrides,
  };

  const setPendingPermissionRequest: PermissionQueueEventDeps['setPendingPermissionRequest'] = (
    request,
    sessionId = null,
  ) => {
    state.pendingPermissionRequest = request;
    state.pendingPermissionSessionId = request ? sessionId : null;
  };

  const enqueuePermissionRequest: PermissionQueueEventDeps['enqueuePermissionRequest'] = (
    sessionId,
    request,
    options,
  ) => {
    const queue = state.queuedPermissionRequests[sessionId] || [];
    state.queuedPermissionRequests[sessionId] = options?.front
      ? [request, ...queue]
      : [...queue, request];
  };

  const deps: PermissionQueueEventDeps = {
    clearPermissionRequestsForSession: (sessionId) => {
      if (state.pendingPermissionSessionId === sessionId) {
        setPendingPermissionRequest(null);
      }
      delete state.queuedPermissionRequests[sessionId];
    },
    debug: () => {},
    enqueuePermissionRequest,
    getCurrentSessionId: () => state.currentSessionId,
    getPendingPermissionRequest: () => state.pendingPermissionRequest,
    markSessionUnread: (sessionId) => {
      state.unreadSessionIds.push(sessionId);
    },
    now: () => 500,
    setLastEventAt: (timestamp) => {
      state.lastEventAt = timestamp;
    },
    setPendingPermissionRequest,
  };

  const reconcile = () => {
    reconcilePermissionQueue({
      currentSessionId: state.currentSessionId,
      pendingPermissionRequest: state.pendingPermissionRequest,
      pendingPermissionSessionId: state.pendingPermissionSessionId,
      enqueuePermissionRequest,
      setPendingPermissionRequest,
      shiftQueuedPermissionRequest: (sessionId) => {
        const queue = state.queuedPermissionRequests[sessionId] || [];
        const nextRequest = queue[0] || null;
        const remaining = queue.slice(1);

        if (remaining.length > 0) {
          state.queuedPermissionRequests[sessionId] = remaining;
        } else {
          delete state.queuedPermissionRequests[sessionId];
        }

        return nextRequest;
      },
    });
  };

  return { deps, reconcile, state };
}

describe('applyPermissionQueueEvent', () => {
  it('shows the first global request and queues later global requests', () => {
    const first = permissionRequest('global-1');
    const second = permissionRequest('global-2');
    const { deps, state } = createHarness({ currentSessionId: 'session-current' });

    applyPermissionQueueEvent({ type: 'permission_request', data: first }, deps);
    applyPermissionQueueEvent(
      { type: 'permission_request', data: second, sessionId: 'global' },
      deps,
    );

    expect(state).toEqual({
      currentSessionId: 'session-current',
      lastEventAt: 500,
      pendingPermissionRequest: first,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: { global: [second] },
      unreadSessionIds: [],
    });
  });

  it('shows an available current-session request and queues occupied or foreign sessions', () => {
    const current = permissionRequest('current-1');
    const foreign = permissionRequest('foreign-1');
    const queuedCurrent = permissionRequest('current-2');
    const { deps, state } = createHarness({ currentSessionId: 'session-current' });

    applyPermissionQueueEvent(
      { type: 'permission_request', data: current, sessionId: 'session-current' },
      deps,
    );
    applyPermissionQueueEvent(
      { type: 'permission_request', data: foreign, sessionId: 'session-foreign' },
      deps,
    );
    applyPermissionQueueEvent(
      { type: 'permission_request', data: queuedCurrent, sessionId: 'session-current' },
      deps,
    );

    expect(state.pendingPermissionRequest).toBe(current);
    expect(state.pendingPermissionSessionId).toBe('session-current');
    expect(state.queuedPermissionRequests).toEqual({
      'session-foreign': [foreign],
      'session-current': [queuedCurrent],
    });
    expect(state.unreadSessionIds).toEqual(['session-foreign', 'session-current']);
  });

  it('updates event activity but does not enqueue malformed permission payloads', () => {
    const { deps, state } = createHarness({ currentSessionId: 'session-current' });

    applyPermissionQueueEvent(
      { type: 'permission_request', data: { type: 'command' }, sessionId: 'session-current' },
      deps,
    );

    expect(state.lastEventAt).toBe(500);
    expect(state.pendingPermissionRequest).toBeNull();
    expect(state.queuedPermissionRequests).toEqual({});
    expect(state.unreadSessionIds).toEqual([]);
  });

  it.each(['agent_complete', 'agent_cancelled', 'error', 'stream_end'])(
    'clears only the terminal session permission state for %s',
    (type) => {
      const pending = permissionRequest('active');
      const queued = permissionRequest('queued');
      const foreign = permissionRequest('foreign');
      const global = permissionRequest('global');
      const { deps, state } = createHarness({
        currentSessionId: 'session-current',
        lastEventAt: 41,
        pendingPermissionRequest: pending,
        pendingPermissionSessionId: 'session-current',
        queuedPermissionRequests: {
          'session-current': [queued],
          'session-foreign': [foreign],
          global: [global],
        },
      });

      applyPermissionQueueEvent({ type, data: null, sessionId: 'session-current' }, deps);

      expect(state).toEqual({
        currentSessionId: 'session-current',
        lastEventAt: 41,
        pendingPermissionRequest: null,
        pendingPermissionSessionId: null,
        queuedPermissionRequests: {
          'session-foreign': [foreign],
          global: [global],
        },
        unreadSessionIds: [],
      });
    },
  );

  it.each(['agent_complete', 'agent_cancelled', 'error', 'stream_end'])(
    'leaves permission state untouched for %s without a session id',
    (type) => {
      const pending = permissionRequest('active');
      const queued = permissionRequest('queued');
      const { deps, state } = createHarness({
        currentSessionId: 'session-current',
        lastEventAt: 41,
        pendingPermissionRequest: pending,
        pendingPermissionSessionId: 'session-current',
        queuedPermissionRequests: { 'session-current': [queued] },
      });

      applyPermissionQueueEvent({ type, data: null }, deps);

      expect(state).toEqual({
        currentSessionId: 'session-current',
        lastEventAt: 41,
        pendingPermissionRequest: pending,
        pendingPermissionSessionId: 'session-current',
        queuedPermissionRequests: { 'session-current': [queued] },
        unreadSessionIds: [],
      });
    },
  );
});

describe('reconcilePermissionQueue', () => {
  it('puts a drifted pending request back at the front of its session queue', () => {
    const drifted = permissionRequest('drifted');
    const olderQueued = permissionRequest('older-queued');
    const { reconcile, state } = createHarness({
      currentSessionId: 'session-new',
      pendingPermissionRequest: drifted,
      pendingPermissionSessionId: 'session-old',
      queuedPermissionRequests: { 'session-old': [olderQueued] },
    });

    reconcile();

    expect(state.pendingPermissionRequest).toBeNull();
    expect(state.pendingPermissionSessionId).toBeNull();
    expect(state.queuedPermissionRequests).toEqual({
      'session-old': [drifted, olderQueued],
    });
  });

  it('promotes a global request when the active permission slot is clear', () => {
    const global = permissionRequest('global');
    const { reconcile, state } = createHarness({
      currentSessionId: 'session-current',
      queuedPermissionRequests: { global: [global] },
    });

    reconcile();

    expect(state.pendingPermissionRequest).toBe(global);
    expect(state.pendingPermissionSessionId).toBeNull();
    expect(state.queuedPermissionRequests).toEqual({});
  });

  it('promotes the current-session request before preserving and later promoting the global request', () => {
    const current = permissionRequest('current');
    const global = permissionRequest('global');
    const { reconcile, state } = createHarness({
      currentSessionId: 'session-current',
      queuedPermissionRequests: {
        'session-current': [current],
        global: [global],
      },
    });

    reconcile();

    expect(state.pendingPermissionRequest).toBe(current);
    expect(state.pendingPermissionSessionId).toBe('session-current');
    expect(state.queuedPermissionRequests).toEqual({ global: [global] });

    state.pendingPermissionRequest = null;
    state.pendingPermissionSessionId = null;
    reconcile();

    expect(state.pendingPermissionRequest).toBe(global);
    expect(state.pendingPermissionRequest?.id).toBe('global');
    expect(state.pendingPermissionSessionId).toBeNull();
    expect(state.queuedPermissionRequests).toEqual({});
  });
});
