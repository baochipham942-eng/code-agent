import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SurfaceConversationSnapshotV1,
  SurfaceSessionControlResultV1,
  SurfaceSessionProjectionV1,
} from '@shared/contract/surfaceExecution';
import { executeSurfaceExecutionControl } from '@renderer/services/surfaceExecutionController';
import { useSurfaceExecutionStore } from '@renderer/stores/surfaceExecutionStore';
import { surfaceExecutionScopeKeyV1 } from '@renderer/utils/surfaceExecutionProjection';

function projection(overrides: Partial<SurfaceSessionProjectionV1> = {}): SurfaceSessionProjectionV1 {
  return {
    version: 1,
    session: {
      version: 1,
      sessionId: 'surface-1',
      conversationId: 'conversation-1',
      runId: 'run-1',
      agentId: 'agent-1',
      surface: 'browser',
      provider: 'managed',
      capabilities: {
        version: 1,
        surface: 'browser',
        provider: 'managed',
        protocolVersion: '1',
        operations: ['observe'],
        observationKinds: ['screenshot'],
        supports: {
          cancel: true,
          pause: true,
          takeover: true,
          cleanup: true,
          successorObservation: true,
        },
      },
      state: 'running',
      startedAt: 1,
      heartbeatAt: 2,
    },
    grant: { state: 'active', capabilities: ['observe'], actionClasses: ['read'], dataScopes: [] },
    events: [],
    evidence: [],
    outputs: [],
    availableControls: ['pause', 'stop'],
    source: 'live',
    writable: true,
    updatedAt: 2,
    ...overrides,
  };
}

function snapshot(session = projection(), updatedAt = session.updatedAt): SurfaceConversationSnapshotV1 {
  return { version: 1, conversationId: 'conversation-1', sessions: [session], updatedAt };
}

describe('executeSurfaceExecutionControl', () => {
  beforeEach(() => {
    useSurfaceExecutionStore.getState().reset();
  });

  it('routes a scoped control through Host and records the authoritative snapshot', async () => {
    useSurfaceExecutionStore.getState().setNativeSnapshot('conversation-1', snapshot());
    const next = snapshot(projection({
      session: { ...projection().session, state: 'paused', heartbeatAt: 5 },
      availableControls: ['resume', 'stop'],
      updatedAt: 5,
    }), 5);
    const control = vi.fn(async (): Promise<SurfaceSessionControlResultV1> => ({
      version: 1,
      requestId: 'host-request',
      snapshot: next,
    }));

    await executeSurfaceExecutionControl({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-1',
      action: 'pause',
    }, { control, now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(20), requestId: () => 'local-request' });

    expect(control).toHaveBeenCalledWith({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-1',
      action: 'pause',
    });
    const state = useSurfaceExecutionStore.getState();
    const scope = state.getSessions({ conversationId: 'conversation-1' })[0].scope;
    expect(state.getSession(scope)?.session.state).toBe('paused');
    expect(state.controlByScope[surfaceExecutionScopeKeyV1(scope)]).toMatchObject({
      action: 'pause',
      status: 'succeeded',
      requestId: 'local-request',
      startedAt: 10,
      settledAt: 20,
    });
  });

  it('fails closed for compatibility sessions and unavailable controls', async () => {
    useSurfaceExecutionStore.getState().setNativeSnapshot('conversation-1', snapshot(projection({
      source: 'compat',
      writable: false,
    })));
    const control = vi.fn();
    const deps = { control, now: () => 1, requestId: () => 'request' };

    await expect(executeSurfaceExecutionControl({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-1',
      action: 'pause',
    }, deps)).rejects.toThrow('read-only');
    expect(control).not.toHaveBeenCalled();
  });

  it('routes explicit continuation for a native persisted checkpoint without reviving write authority', async () => {
    useSurfaceExecutionStore.getState().setNativeSnapshot('conversation-1', snapshot(projection({
      source: 'persisted',
      writable: false,
      availableControls: ['continue'],
    })));
    const next = snapshot(projection({
      source: 'persisted',
      writable: false,
      availableControls: [],
      updatedAt: 3,
    }), 3);
    const control = vi.fn(async (): Promise<SurfaceSessionControlResultV1> => ({
      version: 1,
      requestId: 'host-continuation',
      snapshot: next,
    }));

    await executeSurfaceExecutionControl({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-1',
      action: 'continue',
    }, { control, now: () => 10, requestId: () => 'local-continuation' });

    expect(control).toHaveBeenCalledWith(expect.objectContaining({ action: 'continue' }));
    expect(useSurfaceExecutionStore.getState().getSessions({ conversationId: 'conversation-1' })[0])
      .toMatchObject({ source: 'persisted', writable: false, availableControls: [] });
  });

  it('does not let a stale control response overwrite a newer live update', async () => {
    const initial = snapshot();
    useSurfaceExecutionStore.getState().setNativeSnapshot('conversation-1', initial);
    let resolveControl!: (result: SurfaceSessionControlResultV1) => void;
    const control = vi.fn(() => new Promise<SurfaceSessionControlResultV1>((resolve) => {
      resolveControl = resolve;
    }));
    const pending = executeSurfaceExecutionControl({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-1',
      action: 'pause',
    }, { control, now: () => 10, requestId: () => 'request' });

    const live = snapshot(projection({ updatedAt: 50 }), 50);
    useSurfaceExecutionStore.getState().setNativeSnapshot('conversation-1', live);
    resolveControl({ version: 1, snapshot: initial });
    await pending;

    expect(useSurfaceExecutionStore.getState().nativeByConversation['conversation-1'].updatedAt).toBe(50);
  });
});
