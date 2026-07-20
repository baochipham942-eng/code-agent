import type {
  ComputerUseMutationV1,
} from './desktop';

export type SurfaceKind = 'browser' | 'computer';

export type SurfaceSessionStateV1 =
  | 'preparing'
  | 'waiting_permission'
  | 'running'
  | 'waiting_human'
  | 'paused'
  | 'stopping'
  | 'completed'
  | 'failed';

export type SurfaceGrantCapabilityV1 =
  | 'observe'
  | 'input'
  | 'navigate'
  | 'file'
  | 'secret'
  | 'destructive';

export interface SurfaceCapabilityManifestV1 {
  version: 1;
  surface: SurfaceKind;
  provider: string;
  protocolVersion: string;
  operations: string[];
  observationKinds: Array<'dom' | 'a11y' | 'ax' | 'screenshot' | 'window' | 'network' | 'console'>;
  supports: {
    cancel: boolean;
    pause: boolean;
    takeover: boolean;
    cleanup: boolean;
    successorObservation: boolean;
  };
}

export type SurfaceTargetRefV1 =
  | {
      kind: 'browser';
      browserInstanceId: string;
      windowRef: string;
      tabRef: string;
      frameRef?: string;
      origin?: string;
      documentRevision: string;
      title?: string;
    }
  | {
      kind: 'computer';
      deviceId: string;
      appName: string;
      bundleId?: string;
      pid: number;
      windowRef: string;
      spaceId?: string;
      windowRevision: string;
      title?: string;
    };

export interface InteractiveSurfaceSessionV1 {
  version: 1;
  sessionId: string;
  runId: string;
  taskId?: string;
  turnId?: string;
  conversationId: string;
  agentId: string;
  surface: SurfaceKind;
  provider: string;
  capabilities: SurfaceCapabilityManifestV1;
  state: SurfaceSessionStateV1;
  activeTarget?: SurfaceTargetRefV1;
  grantId?: string;
  parentSessionId?: string;
  startedAt: number;
  heartbeatAt: number;
  expiresAt?: number;
}

export interface SurfaceAccessGrantV1 {
  version: 1;
  grantId: string;
  subject: { sessionId: string; runId: string; agentId: string };
  target: SurfaceTargetRefV1;
  capabilities: SurfaceGrantCapabilityV1[];
  dataScopes: string[];
  actionClasses: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  singleUse?: boolean;
  consumedAt?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SurfaceElementRefV1 =
  | {
      kind: 'browser-element';
      ref: string;
      stateId: string;
      tabRef: string;
      frameRef?: string;
      documentRevision: string;
      backendNodeId: number;
      role?: string;
      name?: string;
      bounds?: Rect;
      selectorFallback?: string;
    }
  | {
      kind: 'computer-element';
      ref: string;
      stateId: string;
      windowRef: string;
      windowRevision: string;
      axToken?: string;
      role?: string;
      label?: string;
      bounds?: Rect;
      screenshotId?: string;
    };

export type SurfaceObservationLifecycleV1 = 'fresh' | 'consumed' | 'superseded' | 'expired';

export interface SurfaceObservationV1 {
  version: 1;
  stateId: string;
  target: SurfaceTargetRefV1;
  providerGeneration: string;
  observedAt: number;
  expiresAt: number;
  elementRefs: SurfaceElementRefV1[];
  evidenceAssetIds: string[];
  redactionStatus: 'clean' | 'redacted' | 'blocked';
  lifecycle?: SurfaceObservationLifecycleV1;
  consumedAt?: number;
}

export type BrowserMutationV1 =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; elementRef?: string; point?: { x: number; y: number; screenshotId?: string } }
  | { kind: 'type'; elementRef?: string; text?: string; secretRef?: string }
  | { kind: 'press_key'; key: string }
  | { kind: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { kind: 'upload_file'; elementRef?: string; artifactRef: string }
  | { kind: 'fill_form'; fields: Array<{ elementRef: string; value?: string; secretRef?: string }> }
  | { kind: 'tab'; action: 'create' | 'close' | 'switch' | 'back' | 'forward' | 'reload' };

export type SurfaceExpectationV1 =
  | { kind: 'element_exists'; elementRef: string }
  | { kind: 'element_absent'; elementRef: string }
  | { kind: 'text_present'; text: string }
  | { kind: 'url_matches'; pattern: string }
  | { kind: 'window_present'; windowRef?: string }
  | { kind: 'custom'; description: string };

export interface SurfaceActionRequestV1 {
  version: 1;
  operationId: string;
  sessionId: string;
  predecessorStateId: string;
  target: SurfaceTargetRefV1;
  mutation: BrowserMutationV1 | ComputerUseMutationV1;
  expectation?: SurfaceExpectationV1;
  grantRef: string;
  deadlineMs: number;
  idempotencyKey?: string;
}

export type SurfaceExecutionErrorCodeV1 =
  | 'SURFACE_TRANSPORT_UNAVAILABLE'
  | 'SURFACE_PROTOCOL_VERSION_MISMATCH'
  | 'SURFACE_REQUEST_TIMEOUT'
  | 'SURFACE_REQUEST_CANCELLED'
  | 'SURFACE_USER_ABORTED'
  | 'SURFACE_SESSION_NOT_FOUND'
  | 'SURFACE_SESSION_EXPIRED'
  | 'SURFACE_SESSION_BUSY'
  | 'SURFACE_TARGET_NOT_OWNED'
  | 'BROWSER_TAB_BORROW_REQUIRED'
  | 'BROWSER_TAB_BORROW_DENIED'
  | 'SURFACE_STATE_STALE'
  | 'SURFACE_TARGET_REVISION_CHANGED'
  | 'SURFACE_ELEMENT_REF_NOT_FOUND'
  | 'SURFACE_TARGET_AMBIGUOUS'
  | 'SURFACE_CAPABILITY_UNSUPPORTED'
  | 'SURFACE_POLICY_BLOCKED'
  | 'SURFACE_APPROVAL_REQUIRED'
  | 'SURFACE_APPROVAL_INVALID'
  | 'SURFACE_SECRET_SCOPE_MISMATCH'
  | 'SURFACE_DELIVERY_UNKNOWN'
  | 'SURFACE_POSTCONDITION_FAILED'
  | 'SURFACE_DIALOG_BLOCKED'
  | 'SURFACE_CLEANUP_FAILED';

export interface SurfaceExecutionErrorV1 {
  version: 1;
  code: SurfaceExecutionErrorCodeV1;
  message: string;
  phase: 'prepare' | 'observe' | 'act' | 'verify' | 'human' | 'recover' | 'artifact' | 'cleanup';
  retryable: boolean;
  userActionRequired: boolean;
  recommendedAction: string;
  surface: SurfaceKind;
  provider: string;
  sessionId: string;
  targetRef?: SurfaceTargetRefV1;
  operationId?: string;
  detailsSafe?: Record<string, unknown>;
}

export interface SurfaceActionResultV1 {
  version: 1;
  operationId: string;
  predecessorStateId: string;
  delivery: 'not_attempted' | 'confirmed' | 'rejected' | 'unknown';
  verification: 'preexisting' | 'satisfied' | 'unsatisfied' | 'inconclusive' | 'not_requested';
  overall: 'succeeded' | 'failed' | 'ambiguous' | 'delivered_unverified';
  successorState?: SurfaceObservationV1;
  evidenceRefs: string[];
  artifactRefs: string[];
  error?: SurfaceExecutionErrorV1;
}

export type SurfaceExecutionControlV1 =
  | 'pause'
  | 'resume'
  | 'takeover'
  | 'skip'
  | 'stop'
  | 'end_session';

export interface SurfaceExecutionEventV1 {
  version: 1;
  eventId: string;
  sequence: number;
  sessionId: string;
  runId: string;
  turnId?: string;
  agentId: string;
  surface: SurfaceKind;
  phase: 'prepare' | 'observe' | 'act' | 'verify' | 'human' | 'recover' | 'artifact' | 'cleanup';
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'ambiguous' | 'cancelled';
  userSummary: string;
  target?: SurfaceTargetRefV1;
  operation?: {
    action: string;
    risk: string;
    approvalScope?: string;
    expectedOutcome?: string;
  };
  observation?: {
    verdict: 'pass' | 'partial' | 'fail' | 'inconclusive' | 'not_requested';
    findings: string[];
    confidence?: number;
  };
  evidenceRefs: string[];
  artifactRefs: string[];
  availableControls: SurfaceExecutionControlV1[];
  startedAt: number;
  completedAt?: number;
}

export const SURFACE_SESSION_TRANSITIONS_V1: Readonly<Record<SurfaceSessionStateV1, readonly SurfaceSessionStateV1[]>> = {
  preparing: ['waiting_permission', 'running', 'stopping', 'failed'],
  waiting_permission: ['running', 'stopping', 'failed'],
  running: ['waiting_human', 'paused', 'stopping', 'completed', 'failed'],
  waiting_human: ['running', 'paused', 'stopping', 'failed'],
  paused: ['running', 'waiting_human', 'stopping', 'failed'],
  stopping: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function canTransitionSurfaceSessionV1(
  from: SurfaceSessionStateV1,
  to: SurfaceSessionStateV1,
): boolean {
  return SURFACE_SESSION_TRANSITIONS_V1[from].includes(to);
}

export function getSurfaceTargetRevisionV1(target: SurfaceTargetRefV1): string {
  return target.kind === 'browser' ? target.documentRevision : target.windowRevision;
}

export function sameSurfaceTargetV1(a: SurfaceTargetRefV1, b: SurfaceTargetRefV1): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'browser' && b.kind === 'browser') {
    return a.browserInstanceId === b.browserInstanceId
      && a.windowRef === b.windowRef
      && a.tabRef === b.tabRef
      && (a.frameRef || '') === (b.frameRef || '')
      && a.documentRevision === b.documentRevision;
  }
  if (a.kind === 'computer' && b.kind === 'computer') {
    return a.deviceId === b.deviceId
      && a.pid === b.pid
      && a.windowRef === b.windowRef
      && a.windowRevision === b.windowRevision;
  }
  return false;
}

export function isSurfaceExecutionEventV1(value: unknown): value is SurfaceExecutionEventV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<SurfaceExecutionEventV1>;
  const phases: SurfaceExecutionEventV1['phase'][] = ['prepare', 'observe', 'act', 'verify', 'human', 'recover', 'artifact', 'cleanup'];
  const statuses: SurfaceExecutionEventV1['status'][] = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'ambiguous', 'cancelled'];
  const controls: SurfaceExecutionControlV1[] = ['pause', 'resume', 'takeover', 'skip', 'stop', 'end_session'];
  const stringArray = (candidate: unknown): candidate is string[] => Array.isArray(candidate)
    && candidate.every((item) => typeof item === 'string');
  const validTarget = (candidate: unknown): candidate is SurfaceTargetRefV1 => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const target = candidate as Partial<SurfaceTargetRefV1>;
    if (target.kind === 'browser') {
      return typeof target.browserInstanceId === 'string'
        && typeof target.windowRef === 'string'
        && typeof target.tabRef === 'string'
        && typeof target.documentRevision === 'string';
    }
    if (target.kind === 'computer') {
      return typeof target.deviceId === 'string'
        && typeof target.appName === 'string'
        && Number.isFinite(target.pid)
        && typeof target.windowRef === 'string'
        && typeof target.windowRevision === 'string';
    }
    return false;
  };
  const validOperation = !event.operation || (
    typeof event.operation.action === 'string'
    && typeof event.operation.risk === 'string'
  );
  const verdicts: NonNullable<SurfaceExecutionEventV1['observation']>['verdict'][] = ['pass', 'partial', 'fail', 'inconclusive', 'not_requested'];
  const validObservation = !event.observation || (
    verdicts.includes(event.observation.verdict)
    && stringArray(event.observation.findings)
    && (event.observation.confidence === undefined || Number.isFinite(event.observation.confidence))
  );
  return event.version === 1
    && typeof event.eventId === 'string'
    && Number.isSafeInteger(event.sequence)
    && (event.sequence as number) >= 0
    && typeof event.sessionId === 'string'
    && typeof event.runId === 'string'
    && typeof event.agentId === 'string'
    && (event.surface === 'browser' || event.surface === 'computer')
    && typeof event.phase === 'string'
    && phases.includes(event.phase)
    && typeof event.status === 'string'
    && statuses.includes(event.status)
    && typeof event.userSummary === 'string'
    && stringArray(event.evidenceRefs)
    && stringArray(event.artifactRefs)
    && Array.isArray(event.availableControls)
    && event.availableControls.every((control) => controls.includes(control))
    && Number.isFinite(event.startedAt)
    && (event.completedAt === undefined || Number.isFinite(event.completedAt))
    && (event.target === undefined || validTarget(event.target))
    && validOperation
    && validObservation;
}
