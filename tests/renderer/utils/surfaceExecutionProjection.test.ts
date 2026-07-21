import { describe, expect, it } from 'vitest';
import type { ToolResult } from '@shared/contract/tool';
import type {
  SurfaceConversationSnapshotV1,
  SurfaceEvidenceCardV1,
  SurfaceExecutionEventV1,
  SurfaceSessionProjectionV1,
} from '@shared/contract/surfaceExecution';
import {
  buildSurfaceExecutionProjectionV1,
  sortAndDedupeSurfaceEventsV1,
} from '@renderer/utils/surfaceExecutionProjection';
import type {
  SurfaceExecutionCompatibilityEnvelopeV1,
  SurfaceExecutionScopeV1,
} from '@renderer/utils/surfaceExecutionProjection';

const scope: SurfaceExecutionScopeV1 = {
  conversationId: 'conversation-a',
  runId: 'run-a',
  agentId: 'agent-a',
  surfaceSessionId: 'surface-a',
};

function event(
  identity: SurfaceExecutionScopeV1,
  eventId: string,
  sequence: number,
  overrides: Partial<SurfaceExecutionEventV1> = {},
): SurfaceExecutionEventV1 {
  return {
    version: 1,
    eventId,
    sequence,
    sessionId: identity.surfaceSessionId,
    conversationId: identity.conversationId,
    runId: identity.runId,
    agentId: identity.agentId,
    surface: 'browser',
    provider: 'managed',
    sessionState: 'running',
    phase: 'observe',
    status: 'running',
    userSummary: eventId,
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: ['pause', 'stop'],
    startedAt: sequence * 10,
    ...overrides,
  };
}

function nativeSession(
  identity: SurfaceExecutionScopeV1,
  events: SurfaceExecutionEventV1[],
  overrides: Partial<SurfaceSessionProjectionV1> = {},
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
      provider: 'managed',
      capabilities: {
        version: 1,
        surface: 'browser',
        provider: 'managed',
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
      heartbeatAt: 30,
    },
    grant: {
      state: 'active',
      capabilities: ['observe'],
      actionClasses: ['read'],
      dataScopes: ['page'],
    },
    events,
    evidence: [],
    outputs: [],
    availableControls: ['pause', 'stop'],
    source: 'live',
    writable: true,
    updatedAt: 30,
    ...overrides,
  };
}

function toolResult(
  events: SurfaceExecutionEventV1[],
  metadata: Record<string, unknown> = {},
): ToolResult {
  return {
    toolCallId: `tool-${events[0]?.eventId ?? 'empty'}`,
    success: true,
    metadata: {
      conversationId: scope.conversationId,
      surfaceExecutionEventsV1: events,
      ...metadata,
    },
  };
}

function compatEnvelope(
  identity: SurfaceExecutionScopeV1,
  results: ToolResult[],
): SurfaceExecutionCompatibilityEnvelopeV1 {
  return {
    conversationId: identity.conversationId,
    runId: identity.runId,
    agentId: identity.agentId,
    surfaceSessionId: identity.surfaceSessionId,
    toolResults: results,
  };
}

describe('surfaceExecutionProjection', () => {
  it('uses a valid native conversation snapshot instead of ToolResult compatibility data', () => {
    const nativeEvent = event(scope, 'native-event', 1, { userSummary: 'native truth' });
    const compatibilityEvent = event(scope, 'compat-event', 2, { userSummary: 'stale fallback' });
    const nativeSnapshot: SurfaceConversationSnapshotV1 = {
      version: 1,
      conversationId: scope.conversationId,
      sessions: [nativeSession(scope, [nativeEvent])],
      updatedAt: 40,
    };

    const projection = buildSurfaceExecutionProjectionV1({
      conversationId: scope.conversationId,
      nativeSnapshot,
      compatibility: [compatEnvelope(scope, [toolResult([compatibilityEvent])])],
    });

    expect(projection.mode).toBe('native');
    expect(projection.sessions).toHaveLength(1);
    expect(projection.sessions[0]).toMatchObject({ source: 'live', writable: true });
    expect(projection.sessions[0].events.map((item) => item.eventId)).toEqual(['native-event']);
    expect(projection.sessions[0].availableControls).toEqual(['pause', 'stop']);
  });

  it('treats an empty native snapshot as authoritative instead of reviving compatibility controls', () => {
    const projection = buildSurfaceExecutionProjectionV1({
      conversationId: scope.conversationId,
      nativeSnapshot: {
        version: 1,
        conversationId: scope.conversationId,
        sessions: [],
        updatedAt: 50,
      },
      compatibility: [compatEnvelope(scope, [toolResult([event(scope, 'compat-event', 1)])])],
    });

    expect(projection).toMatchObject({ mode: 'native', sessions: [] });
  });

  it('deduplicates eventId updates, sorts out-of-order events, and makes compatibility read-only', () => {
    const seqTwoOld = event(scope, 'event-2', 2, {
      completedAt: 25,
      userSummary: 'old duplicate',
      status: 'running',
    });
    const seqOne = event(scope, 'event-1', 1, { completedAt: 15 });
    const seqTwoNew = event(scope, 'event-2', 2, {
      completedAt: 35,
      userSummary: 'new duplicate',
      status: 'succeeded',
    });

    const projection = buildSurfaceExecutionProjectionV1({
      conversationId: scope.conversationId,
      compatibility: [compatEnvelope(scope, [
        toolResult([seqTwoOld, seqOne]),
        toolResult([seqTwoNew]),
      ])],
    });

    expect(projection.mode).toBe('compatibility');
    expect(projection.sessions[0]).toMatchObject({
      source: 'compat',
      writable: false,
      availableControls: [],
    });
    expect(projection.sessions[0].events.map((item) => ({
      id: item.eventId,
      summary: item.userSummary,
      controls: item.availableControls,
    }))).toEqual([
      { id: 'event-1', summary: 'event-1', controls: [] },
      { id: 'event-2', summary: 'new duplicate', controls: [] },
    ]);
  });

  it('keeps legacy observed/analyzed evidence separate from business verification', () => {
    const observed = event(scope, 'observed-event', 1, {
      status: 'succeeded',
      observation: { verdict: 'pass', findings: ['legacy observed'] },
      evidenceRefs: ['shot-1'],
    });
    const result = toolResult([observed], {
      browserComputerProof: {
        evidenceRefs: [{
          id: 'shot-1',
          kind: 'screenshot',
          ref: 'data:image/png;base64,raw',
          source: 'screenshot',
          freshness: { capturedAtMs: 12, state: 'read' },
          redactionStatus: 'clean',
        }],
        visualObservation: { observed: true, source: 'analysis' },
      },
      browserComputerEvidenceCard: {
        title: 'Screenshot proof',
        status: 'observed',
        summary: 'Observed via analysis',
        evidenceRefIds: ['shot-1'],
      },
    });

    const projection = buildSurfaceExecutionProjectionV1({
      conversationId: scope.conversationId,
      compatibility: [compatEnvelope(scope, [result])],
    });

    expect(projection.sessions[0].evidence).toEqual([
      expect.objectContaining({
        evidenceId: 'shot-1',
        inspection: expect.objectContaining({
          captureState: 'captured',
          analysisState: 'analyzed',
          verificationState: 'not_requested',
        }),
      }),
    ]);
    expect(projection.sessions[0].writable).toBe(false);
  });

  it('preserves independent native capture, analysis, and verification axes', () => {
    const evidence: SurfaceEvidenceCardV1 = {
      version: 1,
      evidenceId: 'evidence-independent',
      kind: 'screenshot',
      source: 'browser',
      title: 'Latest screenshot',
      capturedAt: 20,
      redactionStatus: 'clean',
      inspection: {
        captureState: 'captured',
        analysisState: 'failed',
        verificationState: 'inconclusive',
        supportsStepIds: ['step-1'],
        checklist: [],
      },
    };
    const nativeSnapshot: SurfaceConversationSnapshotV1 = {
      version: 1,
      conversationId: scope.conversationId,
      sessions: [nativeSession(scope, [event(scope, 'event-1', 1, { evidence: [evidence] })])],
      updatedAt: 30,
    };

    const projection = buildSurfaceExecutionProjectionV1({
      conversationId: scope.conversationId,
      nativeSnapshot,
    });

    expect(projection.sessions[0].evidence[0].inspection).toEqual(expect.objectContaining({
      captureState: 'captured',
      analysisState: 'failed',
      verificationState: 'inconclusive',
    }));
  });

  it('rejects events that conflict with any supplied outer identity field', () => {
    const foreign = event(scope, 'foreign', 1);
    const projection = buildSurfaceExecutionProjectionV1({
      conversationId: scope.conversationId,
      compatibility: [{
        conversationId: scope.conversationId,
        runId: 'run-other',
        agentId: scope.agentId,
        surfaceSessionId: scope.surfaceSessionId,
        toolResults: [toolResult([foreign])],
      }],
    });

    expect(projection).toMatchObject({ mode: 'empty', sessions: [] });
  });

  it('deduplicates identical eventIds inside a scope without collapsing other scopes', () => {
    const otherScope: SurfaceExecutionScopeV1 = {
      ...scope,
      runId: 'run-b',
      agentId: 'agent-b',
      surfaceSessionId: 'surface-b',
    };
    const projection = buildSurfaceExecutionProjectionV1({
      conversationId: scope.conversationId,
      compatibility: [
        compatEnvelope(scope, [toolResult([event(scope, 'shared-id', 2)])]),
        compatEnvelope(otherScope, [{
          ...toolResult([event(otherScope, 'shared-id', 1)]),
          metadata: {
            ...toolResult([event(otherScope, 'shared-id', 1)]).metadata,
            conversationId: otherScope.conversationId,
          },
        }]),
      ],
    });

    expect(projection.sessions).toHaveLength(2);
    expect(projection.sessions.map((session) => session.events[0].eventId)).toEqual([
      'shared-id',
      'shared-id',
    ]);
  });

  it('exports deterministic event sorting for streaming callers', () => {
    expect(sortAndDedupeSurfaceEventsV1([
      event(scope, 'event-3', 3),
      event(scope, 'event-1', 1),
      event(scope, 'event-2', 2),
    ]).map((item) => item.eventId)).toEqual(['event-1', 'event-2', 'event-3']);
  });
});
