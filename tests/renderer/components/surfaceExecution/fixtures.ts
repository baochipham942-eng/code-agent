import type {
  SurfaceEvidenceCardV1,
  SurfaceExecutionEventV1,
  SurfaceSessionProjectionV1,
  SurfaceSessionStateV1,
} from '../../../../src/shared/contract/surfaceExecution';
import type {
  RendererSurfaceSessionProjectionV1,
  SurfaceExecutionScopeV1,
} from '../../../../src/renderer/utils/surfaceExecutionProjection';

export function surfaceScope(id: string, conversationId = 'conversation-1'): SurfaceExecutionScopeV1 {
  return {
    conversationId,
    runId: `run-${id}`,
    agentId: `agent-${id}`,
    surfaceSessionId: `surface-${id}`,
  };
}

export function surfaceEvent(
  scope: SurfaceExecutionScopeV1,
  overrides: Partial<SurfaceExecutionEventV1> = {},
): SurfaceExecutionEventV1 {
  return {
    version: 1,
    eventId: `event-${scope.surfaceSessionId}`,
    sequence: 1,
    sessionId: scope.surfaceSessionId,
    conversationId: scope.conversationId,
    runId: scope.runId,
    agentId: scope.agentId,
    surface: 'browser',
    provider: 'managed',
    sessionState: 'running',
    phase: 'observe',
    status: 'running',
    userSummary: '正在检查页面',
    observation: { verdict: 'not_requested', findings: [] },
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: ['pause', 'stop'],
    startedAt: 1_000,
    ...overrides,
  };
}

export function surfaceEvidence(
  id: string,
  overrides: Partial<SurfaceEvidenceCardV1> = {},
): SurfaceEvidenceCardV1 {
  return {
    version: 1,
    evidenceId: id,
    kind: 'screenshot',
    source: 'browser',
    title: '最新页面截图',
    summary: '页面主要区域已进入截图',
    capturedAt: 2_000,
    redactionStatus: 'clean',
    inspection: {
      captureState: 'captured',
      analysisState: 'analyzed',
      verificationState: 'verified',
      inspectedBy: { kind: 'agent', id: 'neo', method: 'vision' },
      inspectedAt: 2_100,
      supportsStepIds: ['step-1'],
      checklist: [{ id: 'check-1', label: '主区域完整', status: 'passed' }],
    },
    ...overrides,
  };
}

interface SurfaceSessionOptions {
  id: string;
  conversationId?: string;
  title?: string;
  provider?: string;
  surface?: 'browser' | 'computer';
  state?: SurfaceSessionStateV1;
  source?: SurfaceSessionProjectionV1['source'];
  writable?: boolean;
  updatedAt?: number;
  events?: SurfaceExecutionEventV1[];
  evidence?: SurfaceEvidenceCardV1[];
  outputs?: SurfaceSessionProjectionV1['outputs'];
}

export function surfaceSession({
  id,
  conversationId = 'conversation-1',
  title = `Target ${id}`,
  provider = 'managed',
  surface = 'browser',
  state = 'running',
  source = 'live',
  writable = source === 'live',
  updatedAt = 5_000,
  events,
  evidence = [],
  outputs = [],
}: SurfaceSessionOptions): RendererSurfaceSessionProjectionV1 {
  const scope = surfaceScope(id, conversationId);
  const target = surface === 'browser'
    ? {
        kind: 'browser' as const,
        browserInstanceId: `browser-${id}`,
        windowRef: `window-${id}`,
        tabRef: `tab-${id}`,
        origin: `https://${id}.example.test/private?token=hidden`,
        documentRevision: `document-${id}`,
        title,
      }
    : {
        kind: 'computer' as const,
        deviceId: `device-${id}`,
        appName: 'Preview',
        pid: 42,
        windowRef: `window-${id}`,
        windowRevision: `window-revision-${id}`,
        title,
      };
  const projectedEvents = events ?? [surfaceEvent(scope, {
    surface,
    provider,
    sessionState: state,
    availableControls: writable ? ['pause', 'takeover', 'stop', 'end_session'] : [],
  })];

  return {
    version: 1,
    scope,
    session: {
      version: 1,
      sessionId: scope.surfaceSessionId,
      runId: scope.runId,
      conversationId,
      agentId: scope.agentId,
      surface,
      provider,
      capabilities: {
        version: 1,
        surface,
        provider,
        protocolVersion: '2',
        operations: ['observe'],
        observationKinds: surface === 'browser' ? ['screenshot', 'dom'] : ['screenshot', 'ax'],
        supports: {
          cancel: true,
          pause: true,
          takeover: true,
          cleanup: true,
          successorObservation: true,
        },
      },
      state,
      activeTarget: target,
      startedAt: 1_000,
      heartbeatAt: 4_900,
    },
    grant: {
      state: writable ? 'active' : 'none',
      capabilities: writable ? ['observe', 'input'] : [],
      actionClasses: writable ? ['read', 'write'] : [],
      dataScopes: writable ? ['authorized-target'] : [],
      expiresAt: writable ? 60_000 : undefined,
    },
    events: projectedEvents,
    evidence,
    outputs,
    availableControls: writable ? ['pause', 'takeover', 'stop', 'end_session'] : [],
    source,
    writable,
    updatedAt,
  };
}
