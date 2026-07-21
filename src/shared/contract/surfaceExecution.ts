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
  | 'continue'
  | 'takeover'
  | 'skip'
  | 'stop'
  | 'end_session';

export type SurfaceEvidenceKindV1 =
  | 'screenshot'
  | 'dom'
  | 'a11y'
  | 'ax'
  | 'window'
  | 'network'
  | 'console';

export interface SurfaceEvidenceInspectionV1 {
  captureState: 'captured' | 'unavailable' | 'blocked';
  analysisState: 'not_requested' | 'analyzing' | 'analyzed' | 'failed';
  verificationState: 'not_requested' | 'verified' | 'rejected' | 'inconclusive';
  inspectedBy?: {
    kind: 'agent' | 'human' | 'service';
    id: string;
    method: 'vision' | 'dom' | 'a11y' | 'ax' | 'manual';
  };
  inspectedAt?: number;
  supportsStepIds: string[];
  checklist: Array<{
    id: string;
    label: string;
    status: 'passed' | 'failed' | 'inconclusive' | 'not_checked';
    finding?: string;
  }>;
  beforeEvidenceRef?: string;
  afterEvidenceRef?: string;
}

export interface SurfaceEvidenceCaptureContextV1 {
  target: SurfaceTargetRefV1;
  sourceUrl?: string;
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  };
}

export interface SurfaceEvidenceCardV1 {
  version: 1;
  evidenceId: string;
  kind: SurfaceEvidenceKindV1;
  source: 'browser' | 'computer' | 'compat';
  title: string;
  summary?: string;
  capturedAt: number;
  captureContext?: SurfaceEvidenceCaptureContextV1;
  assetRef?: string;
  observationStateId?: string;
  redactionStatus: 'clean' | 'redacted' | 'blocked';
  inspection: SurfaceEvidenceInspectionV1;
}

export interface SurfaceGrantSummaryV1 {
  state: 'active' | 'consumed' | 'revoked' | 'expired' | 'none';
  capabilities: SurfaceGrantCapabilityV1[];
  actionClasses: string[];
  dataScopes: string[];
  expiresAt?: number;
}

export interface SurfaceOutputRefV1 {
  ref: string;
  kind: 'artifact' | 'file' | 'download' | 'trace';
  label: string;
  createdAt?: number;
}

export type SurfaceSessionViewV1 = Omit<InteractiveSurfaceSessionV1, 'grantId'>;

export interface SurfaceExecutionEventV1 {
  version: 1;
  eventId: string;
  sequence: number;
  sessionId: string;
  conversationId?: string;
  runId: string;
  turnId?: string;
  agentId: string;
  surface: SurfaceKind;
  provider?: string;
  sessionState?: SurfaceSessionStateV1;
  heartbeatAt?: number;
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
  evidence?: SurfaceEvidenceCardV1[];
  artifactRefs: string[];
  availableControls: SurfaceExecutionControlV1[];
  startedAt: number;
  completedAt?: number;
}

export interface SurfaceSessionProjectionV1 {
  version: 1;
  session: SurfaceSessionViewV1;
  grant: SurfaceGrantSummaryV1;
  events: SurfaceExecutionEventV1[];
  evidence: SurfaceEvidenceCardV1[];
  outputs: SurfaceOutputRefV1[];
  availableControls: SurfaceExecutionControlV1[];
  source: 'live' | 'persisted' | 'compat';
  writable: boolean;
  updatedAt: number;
}

export interface SurfaceConversationSnapshotV1 {
  version: 1;
  conversationId: string;
  sessions: SurfaceSessionProjectionV1[];
  updatedAt: number;
}

export interface SurfaceConversationSnapshotRequestV1 {
  version: 1;
  conversationId: string;
}

export interface SurfaceFrameRequestV1 {
  version: 1;
  conversationId: string;
  surfaceSessionId: string;
  assetRef: string;
}

export interface SurfaceFramePayloadV1 {
  version: 1;
  assetRef: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  dataUrl: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
}

export interface SurfaceOutputRequestV1 {
  version: 1;
  conversationId: string;
  surfaceSessionId: string;
  outputRef: string;
}

export type SurfaceOutputPayloadV1 = {
  version: 1;
  outputRef: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
} & ({
  contentKind: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  dataUrl: string;
  text?: never;
} | {
  contentKind: 'text';
  mimeType: 'text/plain' | 'text/html' | 'text/markdown' | 'text/csv' | 'application/json' | 'application/xml';
  text: string;
  dataUrl?: never;
});

export type SurfaceSessionControlActionV1 = Exclude<SurfaceExecutionControlV1, 'skip'>;

export interface SurfaceSessionControlRequestV1 {
  version: 1;
  conversationId: string;
  surfaceSessionId: string;
  action: SurfaceSessionControlActionV1;
  reason?: string;
}

export interface SurfaceSessionControlResultV1 {
  version: 1;
  requestId?: string;
  snapshot: SurfaceConversationSnapshotV1;
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

const SURFACE_SESSION_STATES_V1: readonly SurfaceSessionStateV1[] = [
  'preparing',
  'waiting_permission',
  'running',
  'waiting_human',
  'paused',
  'stopping',
  'completed',
  'failed',
];

const SURFACE_CONTROLS_V1: readonly SurfaceExecutionControlV1[] = [
  'pause',
  'resume',
  'continue',
  'takeover',
  'skip',
  'stop',
  'end_session',
];

export function isSurfaceTargetRefV1(value: unknown): value is SurfaceTargetRefV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Partial<SurfaceTargetRefV1>;
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
}

export function isSurfaceCapabilityManifestV1(
  value: unknown,
): value is SurfaceCapabilityManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Partial<SurfaceCapabilityManifestV1>;
  const supports = manifest.supports as Partial<SurfaceCapabilityManifestV1['supports']> | undefined;
  const observationKinds: SurfaceCapabilityManifestV1['observationKinds'] = [
    'dom',
    'a11y',
    'ax',
    'screenshot',
    'window',
    'network',
    'console',
  ];
  return manifest.version === 1
    && (manifest.surface === 'browser' || manifest.surface === 'computer')
    && typeof manifest.provider === 'string'
    && typeof manifest.protocolVersion === 'string'
    && Array.isArray(manifest.operations)
    && manifest.operations.every((operation) => typeof operation === 'string')
    && Array.isArray(manifest.observationKinds)
    && manifest.observationKinds.every((kind) => observationKinds.includes(kind))
    && Boolean(supports)
    && typeof supports?.cancel === 'boolean'
    && typeof supports.pause === 'boolean'
    && typeof supports.takeover === 'boolean'
    && typeof supports.cleanup === 'boolean'
    && typeof supports.successorObservation === 'boolean';
}

export function isSurfaceSessionViewV1(value: unknown): value is SurfaceSessionViewV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const session = value as Partial<SurfaceSessionViewV1> & { grantId?: unknown };
  return session.version === 1
    && typeof session.sessionId === 'string'
    && typeof session.runId === 'string'
    && (session.taskId === undefined || typeof session.taskId === 'string')
    && (session.turnId === undefined || typeof session.turnId === 'string')
    && typeof session.conversationId === 'string'
    && typeof session.agentId === 'string'
    && (session.surface === 'browser' || session.surface === 'computer')
    && typeof session.provider === 'string'
    && isSurfaceCapabilityManifestV1(session.capabilities)
    && session.capabilities.surface === session.surface
    && session.capabilities.provider === session.provider
    && SURFACE_SESSION_STATES_V1.includes(session.state as SurfaceSessionStateV1)
    && (session.activeTarget === undefined
      || (isSurfaceTargetRefV1(session.activeTarget) && session.activeTarget.kind === session.surface))
    && (session.parentSessionId === undefined || typeof session.parentSessionId === 'string')
    && Number.isFinite(session.startedAt)
    && Number.isFinite(session.heartbeatAt)
    && (session.expiresAt === undefined || Number.isFinite(session.expiresAt))
    && session.grantId === undefined;
}

export function isSurfaceEvidenceCardV1(value: unknown): value is SurfaceEvidenceCardV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const card = value as Partial<SurfaceEvidenceCardV1>;
  const inspection = card.inspection as Partial<SurfaceEvidenceInspectionV1> | undefined;
  const captureContext = card.captureContext as Partial<SurfaceEvidenceCaptureContextV1> | undefined;
  const viewport = captureContext?.viewport;
  const kinds: SurfaceEvidenceKindV1[] = ['screenshot', 'dom', 'a11y', 'ax', 'window', 'network', 'console'];
  const captureStates: SurfaceEvidenceInspectionV1['captureState'][] = ['captured', 'unavailable', 'blocked'];
  const analysisStates: SurfaceEvidenceInspectionV1['analysisState'][] = ['not_requested', 'analyzing', 'analyzed', 'failed'];
  const verificationStates: SurfaceEvidenceInspectionV1['verificationState'][] = ['not_requested', 'verified', 'rejected', 'inconclusive'];
  return card.version === 1
    && typeof card.evidenceId === 'string'
    && typeof card.kind === 'string'
    && kinds.includes(card.kind)
    && (card.source === 'browser' || card.source === 'computer' || card.source === 'compat')
    && typeof card.title === 'string'
    && Number.isFinite(card.capturedAt)
    && (captureContext === undefined || (
      isSurfaceTargetRefV1(captureContext.target)
      && (captureContext.sourceUrl === undefined || typeof captureContext.sourceUrl === 'string')
      && (viewport === undefined || (
        Number.isFinite(viewport.width) && Number(viewport.width) > 0
        && Number.isFinite(viewport.height) && Number(viewport.height) > 0
        && (viewport.deviceScaleFactor === undefined
          || (Number.isFinite(viewport.deviceScaleFactor) && Number(viewport.deviceScaleFactor) > 0))
      ))
    ))
    && (card.redactionStatus === 'clean' || card.redactionStatus === 'redacted' || card.redactionStatus === 'blocked')
    && Boolean(inspection)
    && captureStates.includes(inspection?.captureState as SurfaceEvidenceInspectionV1['captureState'])
    && analysisStates.includes(inspection?.analysisState as SurfaceEvidenceInspectionV1['analysisState'])
    && verificationStates.includes(inspection?.verificationState as SurfaceEvidenceInspectionV1['verificationState'])
    && Array.isArray(inspection?.supportsStepIds)
    && inspection.supportsStepIds.every((id) => typeof id === 'string')
    && Array.isArray(inspection?.checklist)
    && inspection.checklist.every((item) => Boolean(item)
      && typeof item.id === 'string'
      && typeof item.label === 'string'
      && ['passed', 'failed', 'inconclusive', 'not_checked'].includes(item.status));
}

export function isSurfaceFramePayloadV1(value: unknown): value is SurfaceFramePayloadV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Partial<SurfaceFramePayloadV1>;
  return frame.version === 1
    && typeof frame.assetRef === 'string'
    && /^surface-frame:\/\/[a-zA-Z0-9._:-]+$/.test(frame.assetRef)
    && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(frame.mimeType || '')
    && typeof frame.dataUrl === 'string'
    && /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(frame.dataUrl)
    && Number.isSafeInteger(frame.bytes)
    && (frame.bytes as number) > 0
    && typeof frame.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(frame.sha256)
    && (frame.width === undefined || (Number.isSafeInteger(frame.width) && Number(frame.width) > 0))
    && (frame.height === undefined || (Number.isSafeInteger(frame.height) && Number(frame.height) > 0));
}

export function isSurfaceOutputPayloadV1(value: unknown): value is SurfaceOutputPayloadV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const output = value as Partial<SurfaceOutputPayloadV1> & Record<string, unknown>;
  const base = output.version === 1
    && typeof output.outputRef === 'string'
    && /^surface-output:\/\/[a-zA-Z0-9._:-]+$/.test(output.outputRef)
    && Number.isSafeInteger(output.bytes)
    && Number(output.bytes) > 0
    && typeof output.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(output.sha256)
    && typeof output.truncated === 'boolean';
  if (!base) return false;
  if (output.contentKind === 'image') {
    return Object.keys(output).every((key) => [
      'version', 'outputRef', 'contentKind', 'mimeType', 'dataUrl', 'bytes', 'sha256', 'truncated',
    ].includes(key))
      && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(output.mimeType))
      && typeof output.dataUrl === 'string'
      && /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(output.dataUrl)
      && output.text === undefined
      && output.truncated === false;
  }
  return output.contentKind === 'text'
    && Object.keys(output).every((key) => [
      'version', 'outputRef', 'contentKind', 'mimeType', 'text', 'bytes', 'sha256', 'truncated',
    ].includes(key))
    && ['text/plain', 'text/html', 'text/markdown', 'text/csv', 'application/json', 'application/xml']
      .includes(String(output.mimeType))
    && typeof output.text === 'string'
    && output.dataUrl === undefined;
}

export function isSurfaceExecutionEventV1(value: unknown): value is SurfaceExecutionEventV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<SurfaceExecutionEventV1>;
  const phases: SurfaceExecutionEventV1['phase'][] = ['prepare', 'observe', 'act', 'verify', 'human', 'recover', 'artifact', 'cleanup'];
  const statuses: SurfaceExecutionEventV1['status'][] = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'ambiguous', 'cancelled'];
  const stringArray = (candidate: unknown): candidate is string[] => Array.isArray(candidate)
    && candidate.every((item) => typeof item === 'string');
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
    && (event.conversationId === undefined || typeof event.conversationId === 'string')
    && typeof event.runId === 'string'
    && typeof event.agentId === 'string'
    && (event.surface === 'browser' || event.surface === 'computer')
    && (event.provider === undefined || typeof event.provider === 'string')
    && (event.sessionState === undefined || SURFACE_SESSION_STATES_V1.includes(event.sessionState))
    && (event.heartbeatAt === undefined || Number.isFinite(event.heartbeatAt))
    && typeof event.phase === 'string'
    && phases.includes(event.phase)
    && typeof event.status === 'string'
    && statuses.includes(event.status)
    && typeof event.userSummary === 'string'
    && stringArray(event.evidenceRefs)
    && (event.evidence === undefined
      || (Array.isArray(event.evidence) && event.evidence.every(isSurfaceEvidenceCardV1)))
    && stringArray(event.artifactRefs)
    && Array.isArray(event.availableControls)
    && event.availableControls.every((control) => SURFACE_CONTROLS_V1.includes(control))
    && Number.isFinite(event.startedAt)
    && (event.completedAt === undefined || Number.isFinite(event.completedAt))
    && (event.target === undefined || isSurfaceTargetRefV1(event.target))
    && validOperation
    && validObservation;
}

export function isSurfaceSessionProjectionV1(
  value: unknown,
): value is SurfaceSessionProjectionV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const projection = value as Partial<SurfaceSessionProjectionV1>;
  const grant = projection.grant as Partial<SurfaceGrantSummaryV1> | undefined;
  const outputs = Array.isArray(projection.outputs) ? projection.outputs : [];
  const grantStates: SurfaceGrantSummaryV1['state'][] = [
    'active',
    'consumed',
    'revoked',
    'expired',
    'none',
  ];
  const grantCapabilities: SurfaceGrantCapabilityV1[] = [
    'observe',
    'input',
    'navigate',
    'file',
    'secret',
    'destructive',
  ];
  return projection.version === 1
    && isSurfaceSessionViewV1(projection.session)
    && Boolean(grant)
    && grantStates.includes(grant?.state as SurfaceGrantSummaryV1['state'])
    && Array.isArray(grant?.capabilities)
    && grant.capabilities.every((capability) => grantCapabilities.includes(capability))
    && Array.isArray(grant.actionClasses)
    && grant.actionClasses.every((actionClass) => typeof actionClass === 'string')
    && Array.isArray(grant.dataScopes)
    && grant.dataScopes.every((scope) => typeof scope === 'string')
    && (grant.expiresAt === undefined || Number.isFinite(grant.expiresAt))
    && Array.isArray(projection.events)
    && projection.events.every((event) => isSurfaceExecutionEventV1(event)
      && event.sessionId === projection.session?.sessionId)
    && Array.isArray(projection.evidence)
    && projection.evidence.every(isSurfaceEvidenceCardV1)
    && Array.isArray(projection.outputs)
    && outputs.every((output) => Boolean(output)
      && typeof output.ref === 'string'
      && ['artifact', 'file', 'download', 'trace'].includes(output.kind)
      && typeof output.label === 'string'
      && (output.createdAt === undefined || Number.isFinite(output.createdAt)))
    && Array.isArray(projection.availableControls)
    && projection.availableControls.every((control) => SURFACE_CONTROLS_V1.includes(control))
    && (projection.source === 'live' || projection.source === 'persisted' || projection.source === 'compat')
    && typeof projection.writable === 'boolean'
    && Number.isFinite(projection.updatedAt);
}

export function isSurfaceConversationSnapshotV1(
  value: unknown,
): value is SurfaceConversationSnapshotV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<SurfaceConversationSnapshotV1>;
  return snapshot.version === 1
    && typeof snapshot.conversationId === 'string'
    && Array.isArray(snapshot.sessions)
    && snapshot.sessions.every((session) => isSurfaceSessionProjectionV1(session)
      && session.session.conversationId === snapshot.conversationId)
    && Number.isFinite(snapshot.updatedAt);
}
