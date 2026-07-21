import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '@shared/contract/tool';
import type {
  SurfaceConversationSnapshotV1,
  SurfaceExecutionEventV1,
  SurfaceSessionProjectionV1,
} from '@shared/contract/surfaceExecution';
import { useSurfaceExecutionStore } from '@renderer/stores/surfaceExecutionStore';
import { surfaceExecutionScopeKeyV1 } from '@renderer/utils/surfaceExecutionProjection';
import type {
  SurfaceExecutionCompatibilityEnvelopeV1,
  SurfaceExecutionScopeV1,
} from '@renderer/utils/surfaceExecutionProjection';

function scope(
  conversationId: string,
  runId: string,
  agentId: string,
  surfaceSessionId = 'surface-shared',
): SurfaceExecutionScopeV1 {
  return { conversationId, runId, agentId, surfaceSessionId };
}

function event(identity: SurfaceExecutionScopeV1, label: string, startedAt = 10): SurfaceExecutionEventV1 {
  return {
    version: 1,
    eventId: `event-${label}`,
    sequence: 1,
    sessionId: identity.surfaceSessionId,
    conversationId: identity.conversationId,
    runId: identity.runId,
    agentId: identity.agentId,
    surface: 'browser',
    provider: 'managed',
    sessionState: 'running',
    phase: 'observe',
    status: 'running',
    userSummary: label,
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: ['pause', 'stop'],
    startedAt,
  };
}

function envelope(
  identity: SurfaceExecutionScopeV1,
  label: string,
): SurfaceExecutionCompatibilityEnvelopeV1 {
  const surfaceEvent = event(identity, label);
  const result: ToolResult = {
    toolCallId: `tool-${label}`,
    success: true,
    metadata: {
      conversationId: identity.conversationId,
      surfaceExecutionEventsV1: [surfaceEvent],
    },
  };
  return {
    ...identity,
    toolResults: [result],
  };
}

function nativeSession(
  identity: SurfaceExecutionScopeV1,
  label: string,
): SurfaceSessionProjectionV1 {
  return {
    version: 1,
    session: {
      version: 1,
      sessionId: identity.surfaceSessionId,
      conversationId: identity.conversationId,
      runId: identity.runId,
      agentId: identity.agentId,
      surface: 'browser',
      provider: 'relay',
      capabilities: {
        version: 1,
        surface: 'browser',
        provider: 'relay',
        protocolVersion: '2',
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
      startedAt: 10,
      heartbeatAt: 20,
    },
    grant: { state: 'active', capabilities: ['observe'], actionClasses: ['read'], dataScopes: [] },
    events: [event(identity, label)],
    evidence: [],
    outputs: [],
    availableControls: ['pause', 'stop'],
    source: 'live',
    writable: true,
    updatedAt: 20,
  };
}

describe('surfaceExecutionStore', () => {
  beforeEach(() => {
    useSurfaceExecutionStore.getState().reset();
  });

  it('keeps three concurrent sessions isolated by conversation/run/agent/surface identity', () => {
    const first = scope('conversation-a', 'run-a', 'agent-a');
    const second = scope('conversation-a', 'run-b', 'agent-b');
    const third = scope('conversation-b', 'run-a', 'agent-a');
    const store = useSurfaceExecutionStore.getState();

    store.replaceCompatibility('conversation-a', [
      envelope(first, 'first'),
      envelope(second, 'second'),
    ]);
    store.replaceCompatibility('conversation-b', [envelope(third, 'third')]);

    expect(useSurfaceExecutionStore.getState().getSession(first)?.events[0].userSummary).toBe('first');
    expect(useSurfaceExecutionStore.getState().getSession(second)?.events[0].userSummary).toBe('second');
    expect(useSurfaceExecutionStore.getState().getSession(third)?.events[0].userSummary).toBe('third');
    expect(useSurfaceExecutionStore.getState().getSessions({ conversationId: 'conversation-a' }))
      .toHaveLength(2);
    expect(useSurfaceExecutionStore.getState().getSessions({
      conversationId: 'conversation-a',
      runId: 'run-b',
      agentId: 'agent-b',
    }).map((session) => session.scope)).toEqual([second]);
  });

  it('keeps native data authoritative and reveals compatibility only after native is cleared', () => {
    const identity = scope('conversation-a', 'run-a', 'agent-a', 'surface-a');
    const store = useSurfaceExecutionStore.getState();
    store.replaceCompatibility('conversation-a', [envelope(identity, 'compatibility')]);

    const snapshot: SurfaceConversationSnapshotV1 = {
      version: 1,
      conversationId: 'conversation-a',
      sessions: [nativeSession(identity, 'native')],
      updatedAt: 30,
    };
    expect(store.setNativeSnapshot('conversation-a', snapshot)).toBe(true);
    expect(useSurfaceExecutionStore.getState().getSession(identity)).toMatchObject({
      source: 'live',
      writable: true,
      events: [expect.objectContaining({ userSummary: 'native' })],
    });

    store.replaceCompatibility('conversation-a', [envelope(identity, 'newer fallback')]);
    expect(useSurfaceExecutionStore.getState().getSession(identity)?.events[0].userSummary).toBe('native');

    store.clearNativeSnapshot('conversation-a');
    expect(useSurfaceExecutionStore.getState().getSession(identity)).toMatchObject({
      source: 'compat',
      writable: false,
      events: [expect.objectContaining({ userSummary: 'newer fallback' })],
    });
  });

  it('rejects a native snapshot that belongs to a different conversation', () => {
    const snapshot: SurfaceConversationSnapshotV1 = {
      version: 1,
      conversationId: 'conversation-b',
      sessions: [],
      updatedAt: 10,
    };

    expect(useSurfaceExecutionStore.getState().setNativeSnapshot('conversation-a', snapshot)).toBe(false);
    expect(useSurfaceExecutionStore.getState().nativeByConversation).toEqual({});
  });

  it('does not let a stale native response overwrite a newer live snapshot', () => {
    const identity = scope('conversation-a', 'run-a', 'agent-a', 'surface-a');
    const newer: SurfaceConversationSnapshotV1 = {
      version: 1,
      conversationId: 'conversation-a',
      sessions: [{ ...nativeSession(identity, 'newer'), updatedAt: 50 }],
      updatedAt: 50,
    };
    const stale: SurfaceConversationSnapshotV1 = {
      version: 1,
      conversationId: 'conversation-a',
      sessions: [{ ...nativeSession(identity, 'stale'), updatedAt: 30 }],
      updatedAt: 30,
    };

    const store = useSurfaceExecutionStore.getState();
    expect(store.setNativeSnapshot('conversation-a', newer)).toBe(true);
    expect(store.setNativeSnapshot('conversation-a', stale)).toBe(true);

    expect(useSurfaceExecutionStore.getState().getSession(identity)).toMatchObject({
      updatedAt: 50,
      events: [expect.objectContaining({ userSummary: 'newer' })],
    });
  });

  it('models frame, evidence, and control pending states independently per scope', () => {
    const first = scope('conversation-a', 'run-a', 'agent-a', 'surface-a');
    const second = scope('conversation-a', 'run-b', 'agent-b', 'surface-b');
    const store = useSurfaceExecutionStore.getState();
    const firstKey = surfaceExecutionScopeKeyV1(first);
    const secondKey = surfaceExecutionScopeKeyV1(second);

    store.setFrameState(first, {
      status: 'pending',
      requestId: 'frame-request',
      updatedAt: 10,
    });
    store.setEvidenceRequestState(first, 'evidence-1', {
      status: 'pending',
      requestId: 'evidence-request',
      startedAt: 11,
    });
    store.setControlRequestState(first, {
      action: 'takeover',
      status: 'pending',
      requestId: 'control-request',
      startedAt: 12,
    });
    store.setControlRequestState(second, {
      action: 'stop',
      status: 'pending',
      requestId: 'control-other',
      startedAt: 13,
    });

    store.setFrameState(first, {
      status: 'ready',
      frameRef: 'frame-1',
      observationStateId: 'observation-1',
      updatedAt: 20,
    });

    const current = useSurfaceExecutionStore.getState();
    expect(current.frameByScope[firstKey]).toMatchObject({ status: 'ready', frameRef: 'frame-1' });
    expect(current.evidenceByScope[firstKey].requests['evidence-1']).toMatchObject({ status: 'pending' });
    expect(current.controlByScope[firstKey]).toMatchObject({ action: 'takeover', status: 'pending' });
    expect(current.controlByScope[secondKey]).toMatchObject({ action: 'stop', status: 'pending' });

    store.setEvidenceRequestState(first, 'evidence-1', null);
    expect(useSurfaceExecutionStore.getState().evidenceByScope[firstKey]).toBeUndefined();
    expect(useSurfaceExecutionStore.getState().controlByScope[firstKey]).toBeDefined();
  });

  it('clears one conversation without touching another conversation state', () => {
    const first = scope('conversation-a', 'run-a', 'agent-a', 'surface-a');
    const second = scope('conversation-b', 'run-b', 'agent-b', 'surface-b');
    const store = useSurfaceExecutionStore.getState();
    store.replaceCompatibility('conversation-a', [envelope(first, 'first')]);
    store.replaceCompatibility('conversation-b', [envelope(second, 'second')]);
    store.setFrameState(first, { status: 'pending' });
    store.setFrameState(second, { status: 'ready' });
    store.setControlRequestState(first, { action: 'stop', status: 'pending', startedAt: 1 });
    store.setControlRequestState(second, { action: 'pause', status: 'pending', startedAt: 1 });

    store.clearConversation('conversation-a');

    const current = useSurfaceExecutionStore.getState();
    expect(current.getSession(first)).toBeUndefined();
    expect(current.getSession(second)).toBeDefined();
    expect(current.frameByScope[surfaceExecutionScopeKeyV1(first)]).toBeUndefined();
    expect(current.frameByScope[surfaceExecutionScopeKeyV1(second)]).toBeDefined();
    expect(current.controlByScope[surfaceExecutionScopeKeyV1(first)]).toBeUndefined();
    expect(current.controlByScope[surfaceExecutionScopeKeyV1(second)]).toBeDefined();
  });
});
