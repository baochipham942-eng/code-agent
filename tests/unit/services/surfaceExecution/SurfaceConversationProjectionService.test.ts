import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import type {
  SurfaceConversationSnapshotV1,
  SurfaceEvidenceCardV1,
  SurfaceExecutionEventV1,
  SurfaceSessionProjectionV1,
  SurfaceSessionViewV1,
} from '../../../../src/shared/contract/surfaceExecution';
import {
  SURFACE_EXECUTION_LEDGER_METADATA_KEY,
  SurfaceConversationProjectionService,
} from '../../../../src/host/services/surfaceExecution/SurfaceConversationProjectionService';
import { SurfaceExecutionRuntimeError } from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntimeError';
import { SurfaceContinuationService } from '../../../../src/host/services/surfaceExecution/SurfaceContinuationService';

function sessionView(
  sessionId: string,
  surface: 'browser' | 'computer' = 'browser',
): SurfaceSessionViewV1 {
  const provider = surface === 'browser' ? 'managed-playwright' : 'cua-driver';
  return {
    version: 1,
    sessionId,
    runId: `run-${sessionId}`,
    conversationId: 'conversation-1',
    agentId: `agent-${sessionId}`,
    surface,
    provider,
    capabilities: {
      version: 1,
      surface,
      provider,
      protocolVersion: 'surface-execution-v1',
      operations: ['observe', 'act'],
      observationKinds: surface === 'browser' ? ['dom', 'screenshot'] : ['ax', 'screenshot'],
      supports: {
        cancel: true,
        pause: true,
        takeover: true,
        cleanup: true,
        successorObservation: true,
      },
    },
    state: 'running',
    startedAt: 100,
    heartbeatAt: 120,
  };
}

function event(
  sessionId: string,
  sequence = 1,
  overrides: Partial<SurfaceExecutionEventV1> = {},
): SurfaceExecutionEventV1 {
  return {
    version: 1,
    eventId: `${sessionId}:event:${sequence}`,
    sequence,
    sessionId,
    conversationId: 'conversation-1',
    runId: `run-${sessionId}`,
    agentId: `agent-${sessionId}`,
    surface: 'browser',
    provider: 'managed-playwright',
    sessionState: 'running',
    phase: 'observe',
    status: 'succeeded',
    userSummary: `Observed ${sessionId}`,
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: ['pause', 'takeover', 'stop', 'end_session'],
    startedAt: 100 + sequence,
    completedAt: 100 + sequence,
    ...overrides,
  };
}

function projection(sessionId: string): SurfaceSessionProjectionV1 {
  const currentEvent = event(sessionId);
  return {
    version: 1,
    session: sessionView(sessionId),
    grant: {
      state: 'active',
      capabilities: ['observe'],
      actionClasses: ['observe'],
      dataScopes: ['origin:https://example.test'],
      expiresAt: 10_000,
    },
    events: [currentEvent],
    evidence: [],
    outputs: [],
    availableControls: ['pause', 'takeover', 'stop', 'end_session'],
    source: 'live',
    writable: true,
    updatedAt: 120,
  };
}

function messageWithSurfaceMetadata(input: {
  session: SurfaceSessionViewV1 & { grantId?: string };
  events: SurfaceExecutionEventV1[];
  mode: 'native' | 'compatibility';
  visibility?: Message['visibility'];
}): Message {
  return {
    id: `message-${input.session.sessionId}`,
    role: 'assistant',
    content: '',
    timestamp: 200,
    ...(input.visibility ? { visibility: input.visibility } : {}),
    toolResults: [{
      toolCallId: `tool-${input.session.sessionId}`,
      success: true,
      metadata: {
        surfaceExecutionSessionV1: input.session,
        surfaceExecutionEventsV1: input.events,
        surfaceProjectionMode: input.mode,
      },
    }],
  };
}

function harness(input: {
  live?: SurfaceConversationSnapshotV1;
  messages?: Message[];
  metadata?: Record<string, unknown>;
  owned?: boolean;
  persistEvents?: boolean;
  continuations?: SurfaceContinuationService;
} = {}) {
  let observer: ((value: SurfaceExecutionEventV1) => void) | undefined;
  const stored = {
    id: 'conversation-1',
    metadata: { ...(input.metadata || {}) },
    messages: input.messages || [],
  };
  const runtime = {
    snapshotConversation: vi.fn(() => input.live || {
      version: 1 as const,
      conversationId: 'conversation-1',
      sessions: [],
      updatedAt: 300,
    }),
    frames: {
      resolve: vi.fn(async (request) => ({
        version: 1 as const,
        assetRef: request.assetRef,
        mimeType: 'image/png' as const,
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        bytes: 8,
        sha256: 'a'.repeat(64),
      })),
    },
    outputs: {
      resolve: vi.fn(async (request) => ({
        version: 1 as const,
        outputRef: request.outputRef,
        contentKind: 'text' as const,
        mimeType: 'text/html' as const,
        text: '<title>owner output</title>',
        truncated: false,
        bytes: 28,
        sha256: 'b'.repeat(64),
      })),
    },
    controlConversation: vi.fn(async () => ({
      version: 1 as const,
      snapshot: input.live || {
        version: 1 as const,
        conversationId: 'conversation-1',
        sessions: [],
        updatedAt: 300,
      },
    })),
    subscribeEvents: vi.fn((listener: (value: SurfaceExecutionEventV1) => void) => {
      observer = listener;
      return () => { observer = undefined; };
    }),
  };
  const sessionStore = {
    getSession: vi.fn(async () => input.owned === false ? null : stored as never),
    patchSessionMetadata: vi.fn(async (_conversationId: string, patch: Record<string, unknown>) => {
      Object.assign(stored.metadata, patch);
      return true;
    }),
  };
  const service = new SurfaceConversationProjectionService({
    runtime,
    sessionStore,
    continuations: input.continuations || new SurfaceContinuationService(),
    now: () => 500,
    persistEvents: input.persistEvents,
  });
  return {
    service,
    runtime,
    sessionStore,
    stored,
    emit: (value: SurfaceExecutionEventV1) => observer?.(value),
  };
}

describe('SurfaceConversationProjectionService', () => {
  it('owner-gates snapshots and controls before touching runtime authority', async () => {
    const { service, runtime } = harness({ owned: false });

    await expect(service.getSnapshot('conversation-1')).rejects.toBeInstanceOf(SurfaceExecutionRuntimeError);
    await expect(service.control({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-foreign',
      action: 'stop',
    })).rejects.toMatchObject({
      surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' },
    });
    expect(runtime.snapshotConversation).not.toHaveBeenCalled();
    expect(runtime.controlConversation).not.toHaveBeenCalled();
  });

  it('merges durable, message, and live projections while stripping raw grant ids', async () => {
    const legacySession = { ...sessionView('surface-live'), grantId: 'raw-grant-must-not-cross' };
    const legacyEvent = event('surface-live', 0, {
      eventId: 'legacy-event',
      provider: undefined,
      observation: { verdict: 'pass', findings: ['Legacy observed success'] },
      artifactRefs: ['artifact://travel-site-final.html'],
    });
    const liveProjection = projection('surface-live');
    liveProjection.outputs = [{
      ref: 'artifact://travel-site-final.html',
      kind: 'artifact',
      label: 'travel-site-final.html',
    }];
    const live = {
      version: 1 as const,
      conversationId: 'conversation-1',
      sessions: [liveProjection],
      updatedAt: 300,
    };
    const { service } = harness({
      live,
      persistEvents: false,
      messages: [messageWithSurfaceMetadata({
        session: legacySession,
        events: [legacyEvent],
        mode: 'compatibility',
      })],
    });

    const snapshot = await service.getSnapshot('conversation-1');
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({ source: 'live', writable: true });
    expect(snapshot.sessions[0].events.map((value) => value.eventId)).toEqual([
      'legacy-event',
      'surface-live:event:1',
    ]);
    expect(snapshot.sessions[0].session).not.toHaveProperty('grantId');
    expect(snapshot.sessions[0].evidence).toEqual([]);
    expect(snapshot.sessions[0].outputs).toEqual([{
      ref: 'artifact://travel-site-final.html',
      kind: 'artifact',
      label: 'travel-site-final.html',
    }]);
  });

  it('resolves only a clean captured frame attached to the owned live session', async () => {
    const liveProjection = projection('surface-live-frame');
    liveProjection.evidence = [{
      version: 1,
      evidenceId: 'evidence-live-frame',
      kind: 'screenshot',
      source: 'browser',
      title: 'Live frame',
      capturedAt: 110,
      assetRef: 'surface-frame://frame-live-1',
      redactionStatus: 'clean',
      inspection: {
        captureState: 'captured',
        analysisState: 'analyzed',
        verificationState: 'verified',
        supportsStepIds: ['verify-live-frame'],
        checklist: [],
      },
    }];
    const { service, runtime } = harness({
      persistEvents: false,
      live: {
        version: 1,
        conversationId: 'conversation-1',
        sessions: [liveProjection],
        updatedAt: 300,
      },
    });
    const request = {
      version: 1 as const,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-live-frame',
      assetRef: 'surface-frame://frame-live-1',
    };

    await expect(service.getFrame(request)).resolves.toMatchObject({
      assetRef: request.assetRef,
      mimeType: 'image/png',
    });
    expect(runtime.frames.resolve).toHaveBeenCalledWith(request);
    await expect(service.getFrame({
      ...request,
      assetRef: 'surface-frame://frame-foreign',
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });
    expect(runtime.frames.resolve).toHaveBeenCalledTimes(1);
  });

  it('resolves only an output ref projected by the owned live session', async () => {
    const liveProjection = projection('surface-live-output');
    liveProjection.outputs = [{
      ref: 'surface-output://output-live-1',
      kind: 'artifact',
      label: 'Output',
    }];
    const { service, runtime } = harness({
      persistEvents: false,
      live: {
        version: 1,
        conversationId: 'conversation-1',
        sessions: [liveProjection],
        updatedAt: 300,
      },
    });
    const request = {
      version: 1 as const,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-live-output',
      outputRef: 'surface-output://output-live-1',
    };

    await expect(service.getOutput(request)).resolves.toMatchObject({
      outputRef: request.outputRef,
      contentKind: 'text',
      mimeType: 'text/html',
    });
    expect(runtime.outputs.resolve).toHaveBeenCalledWith(request);
    await expect(service.getOutput({
      ...request,
      outputRef: 'surface-output://output-foreign',
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });
    expect(runtime.outputs.resolve).toHaveBeenCalledTimes(1);
  });

  it('rebinds imported safe exports as archive-only projections without reviving authority', async () => {
    const archivedEvidence = {
      evidenceId: 'archive-evidence',
      kind: 'screenshot',
      source: 'browser',
      title: 'Archived screenshot metadata',
      capturedAt: 115,
      captureContext: {
        target: {
          kind: 'browser',
          browserInstanceId: 'browser-archive',
          windowRef: 'window-archive',
          tabRef: 'tab-archive',
          documentRevision: 'revision-archive',
          title: 'Archived result',
        },
        sourceUrl: 'https://user:password@example.test/result?token=surface-secret-canary-archive-url',
        viewport: { width: 1365, height: 768, deviceScaleFactor: 1 },
      },
      redactionStatus: 'clean',
      captureState: 'captured',
      analysisState: 'analyzed',
      verificationState: 'verified',
      supportsStepIds: ['archive-step'],
      checklist: [{ id: 'archive-check', label: 'Archived state passed', status: 'passed' }],
      assetRef: '/Users/private/raw-screenshot.png',
    };
    const { service, runtime } = harness({
      persistEvents: false,
      metadata: {
        surfaceExecutionExportV1: {
          version: 1,
          sessions: [{
            sessionId: 'foreign-original-surface',
            surface: 'browser',
            provider: 'system-chrome-cdp',
            state: 'running',
            startedAt: 100,
            heartbeatAt: 120,
            source: 'native',
            grant: { state: 'active', grantId: 'must-strip' },
            activeTarget: { tabRef: 'must-strip' },
            events: [{
              eventId: 'foreign-event',
              sequence: 1,
              surface: 'browser',
              phase: 'verify',
              status: 'succeeded',
              userSummary: 'Imported business state passed',
              observation: { verdict: 'pass', findings: ['Archived state is correct'] },
              evidenceRefs: ['archive-evidence'],
              evidence: [archivedEvidence],
              artifactRefs: ['artifact:archive-result'],
              availableControls: ['takeover', 'stop'],
              startedAt: 110,
              completedAt: 120,
              target: { tabRef: 'must-strip' },
            }],
          }],
        },
      },
    });

    const snapshot = await service.getSnapshot('conversation-1');
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      source: 'compat',
      writable: false,
      availableControls: [],
      grant: { state: 'none', capabilities: [], actionClasses: [], dataScopes: [] },
      session: {
        conversationId: 'conversation-1',
        runId: 'surface-archive-run:conversation-1',
        agentId: 'surface-archive-import',
        state: 'completed',
      },
    });
    expect(snapshot.sessions[0].session.sessionId).not.toBe('foreign-original-surface');
    expect(snapshot.sessions[0].session).not.toHaveProperty('activeTarget');
    expect(snapshot.sessions[0].events[0]).toMatchObject({
      conversationId: 'conversation-1',
      availableControls: [],
      observation: { verdict: 'pass' },
    });
    expect(snapshot.sessions[0].events[0].sessionId).toBe(snapshot.sessions[0].session.sessionId);
    expect(snapshot.sessions[0].events[0]).not.toHaveProperty('target');
    expect(snapshot.sessions[0].evidence[0]).not.toHaveProperty('assetRef');
    expect(snapshot.sessions[0].evidence[0]).toMatchObject({
      captureContext: {
        target: {
          kind: 'browser',
          browserInstanceId: 'browser-archive',
          windowRef: 'window-archive',
          tabRef: 'tab-archive',
          documentRevision: 'revision-archive',
          title: 'Archived result',
        },
        sourceUrl: 'https://example.test/result',
        viewport: { width: 1365, height: 768, deviceScaleFactor: 1 },
      },
    });
    await expect(service.control({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: snapshot.sessions[0].session.sessionId,
      action: 'continue',
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_POLICY_BLOCKED' } });
    expect(runtime.controlConversation).not.toHaveBeenCalled();
  });

  it('keeps three concurrent Surface sessions isolated and ignores rewound history', async () => {
    const messages = ['surface-a', 'surface-b', 'surface-rewound'].map((sessionId) => (
      messageWithSurfaceMetadata({
        session: sessionView(sessionId),
        events: [event(sessionId)],
        mode: 'native',
        ...(sessionId === 'surface-rewound' ? { visibility: 'rewound' as const } : {}),
      })
    ));
    const liveComputer = projection('surface-c');
    liveComputer.session = sessionView('surface-c', 'computer');
    liveComputer.events = [event('surface-c', 1, {
      surface: 'computer',
      provider: 'cua-driver',
    })];
    const { service } = harness({
      persistEvents: false,
      messages,
      live: {
        version: 1,
        conversationId: 'conversation-1',
        sessions: [liveComputer],
        updatedAt: 300,
      },
    });

    const snapshot = await service.getSnapshot('conversation-1');
    expect(snapshot.sessions.map((item) => item.session.sessionId)).toEqual([
      'surface-a',
      'surface-b',
      'surface-c',
    ]);
    expect(snapshot.sessions.map((item) => item.events[0].sessionId)).toEqual([
      'surface-a',
      'surface-b',
      'surface-c',
    ]);
  });

  it('does not revive durable or live projections owned by a rewound turn', async () => {
    const rewound = projection('surface-rewound-turn');
    rewound.session = { ...rewound.session, turnId: 'turn-rewound' };
    rewound.events = rewound.events.map((value) => ({ ...value, turnId: 'turn-rewound' }));
    const persisted = {
      version: 1 as const,
      conversationId: 'conversation-1',
      sessions: [{ ...rewound, source: 'persisted' as const, writable: false, availableControls: [] }],
      updatedAt: 300,
    };
    const { service } = harness({
      persistEvents: false,
      metadata: { [SURFACE_EXECUTION_LEDGER_METADATA_KEY]: persisted },
      messages: [{
        id: 'turn-rewound',
        role: 'assistant',
        content: '',
        timestamp: 200,
        visibility: 'rewound',
      }],
      live: { ...persisted, sessions: [rewound] },
    });

    await expect(service.getSnapshot('conversation-1')).resolves.toMatchObject({ sessions: [] });
  });

  it('persists redacted read-only projections independently of tool completion', async () => {
    const liveProjection = projection('surface-live');
    const evidence: SurfaceEvidenceCardV1 = {
      version: 1,
      evidenceId: 'evidence-nested-checklist',
      kind: 'screenshot',
      source: 'browser',
      title: 'Nested evidence survives projection-scoped redaction',
      capturedAt: 101,
      redactionStatus: 'clean',
      inspection: {
        captureState: 'captured',
        analysisState: 'analyzed',
        verificationState: 'verified',
        inspectedBy: { kind: 'agent', id: 'agent-surface-live', method: 'vision' },
        inspectedAt: 102,
        supportsStepIds: ['step-1'],
        checklist: [{ id: 'check-1', label: 'Nested checklist retained', status: 'passed' }],
      },
    };
    liveProjection.evidence = [evidence];
    liveProjection.events = [event('surface-live', 1, {
      userSummary: 'Read token=surface-secret-canary-danger at /Users/private/proof.png',
      evidenceRefs: [evidence.evidenceId],
      evidence: [evidence],
    })];
    const { service, sessionStore, stored, emit } = harness({
      persistEvents: true,
      live: {
        version: 1,
        conversationId: 'conversation-1',
        sessions: [liveProjection],
        updatedAt: 300,
      },
    });

    emit(liveProjection.events[0]);
    await service.flushPersistence('conversation-1');

    expect(sessionStore.patchSessionMetadata).toHaveBeenCalledTimes(1);
    const ledger = stored.metadata[SURFACE_EXECUTION_LEDGER_METADATA_KEY] as SurfaceConversationSnapshotV1;
    expect(ledger.sessions[0]).toMatchObject({
      source: 'persisted',
      writable: false,
      availableControls: ['continue'],
    });
    expect(ledger.sessions[0].events[0].userSummary).toContain('[redacted]');
    expect(ledger.sessions[0].events[0].userSummary).toContain('[redacted-path]');
    expect(ledger.sessions[0].evidence[0].inspection.checklist).toEqual([
      { id: 'check-1', label: 'Nested checklist retained', status: 'passed' },
    ]);
    expect(JSON.stringify(ledger)).not.toContain('surface-secret-canary-danger');
  });

  it('recovers a persisted checkpoint read-only and prepares one owner-scoped continuation', async () => {
    const durable = projection('surface-checkpoint');
    durable.source = 'persisted';
    durable.writable = false;
    durable.availableControls = [];
    const continuations = new SurfaceContinuationService({ createId: () => 'continue-request-1' });
    const { service } = harness({
      continuations,
      persistEvents: false,
      metadata: {
        [SURFACE_EXECUTION_LEDGER_METADATA_KEY]: {
          version: 1,
          conversationId: 'conversation-1',
          sessions: [durable],
          updatedAt: 300,
        },
      },
    });

    const recovered = await service.getSnapshot('conversation-1');
    expect(recovered.sessions[0]).toMatchObject({
      source: 'persisted',
      writable: false,
      availableControls: ['continue'],
      grant: { state: 'revoked' },
    });
    const prepared = await service.control({
      version: 1,
      conversationId: 'conversation-1',
      surfaceSessionId: 'surface-checkpoint',
      action: 'continue',
    });
    expect(prepared.requestId).toBe('continue-request-1');
    expect(prepared.snapshot.sessions[0].availableControls).toEqual([]);
    expect(continuations.consume({
      conversationId: 'conversation-1',
      runId: 'run-after-restart',
      agentId: 'agent-surface-checkpoint',
    })).toMatchObject({ parentSessionId: 'surface-checkpoint' });
    expect(continuations.consume({
      conversationId: 'conversation-1',
      runId: 'run-after-restart',
      agentId: 'agent-surface-checkpoint',
    })).toBeNull();
  });
});
