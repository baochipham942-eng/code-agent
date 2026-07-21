import type {
  SurfaceActionResultV1,
  SurfaceConversationSnapshotV1,
  SurfaceEvidenceCaptureContextV1,
  SurfaceEvidenceCardV1,
  SurfaceEvidenceInspectionV1,
  SurfaceEvidenceKindV1,
  SurfaceExecutionControlV1,
  SurfaceExecutionEventV1,
  SurfaceSessionStateV1,
} from '../contract/surfaceExecution';
import {
  isSurfaceConversationSnapshotV1,
  isSurfaceEvidenceCardV1,
  isSurfaceExecutionEventV1,
} from '../contract/surfaceExecution';
import {
  redactSurfaceExecutionValue,
  sanitizeSurfaceExecutionEventV1,
} from './surfaceExecutionRedaction';
import { isBrowserComputerToolName } from './browserComputerInputPayloadRedaction';
import { projectSurfaceEvidenceCaptureContextForExport } from './surfaceExecutionExportCaptureContext';
import {
  carriesSurfaceExecutionAuthority,
  stripRawSurfaceExecutionExportFields,
} from './surfaceExecutionExportFieldSanitizer';

export { stripRawSurfaceExecutionExportFields } from './surfaceExecutionExportFieldSanitizer';

export interface SurfaceExecutionExportErrorV1 {
  code: string;
  message: string;
  phase?: SurfaceExecutionEventV1['phase'];
  retryable?: boolean;
  userActionRequired?: boolean;
  recommendedAction?: string;
}

export interface SurfaceExecutionExportActionResultV1 {
  operationId?: string;
  delivery?: SurfaceActionResultV1['delivery'];
  verification?: SurfaceActionResultV1['verification'];
  overall?: SurfaceActionResultV1['overall'];
  error?: SurfaceExecutionExportErrorV1;
}

export interface SurfaceExecutionExportEvidenceV1 {
  evidenceId: string;
  kind: SurfaceEvidenceKindV1;
  source: SurfaceEvidenceCardV1['source'];
  title: string;
  summary?: string;
  capturedAt: number;
  captureContext?: SurfaceEvidenceCaptureContextV1;
  redactionStatus: SurfaceEvidenceCardV1['redactionStatus'];
  captureState: SurfaceEvidenceInspectionV1['captureState'];
  analysisState: SurfaceEvidenceInspectionV1['analysisState'];
  verificationState: SurfaceEvidenceInspectionV1['verificationState'];
  inspectedBy?: {
    kind: NonNullable<SurfaceEvidenceInspectionV1['inspectedBy']>['kind'];
    id: string;
    method: NonNullable<SurfaceEvidenceInspectionV1['inspectedBy']>['method'];
  };
  inspectedAt?: number;
  supportsStepIds: string[];
  checklist: Array<{
    id: string;
    label: string;
    status: SurfaceEvidenceInspectionV1['checklist'][number]['status'];
    finding?: string;
  }>;
  beforeEvidenceRef?: string;
  afterEvidenceRef?: string;
}

export interface SurfaceExecutionExportEventV1 {
  eventId: string;
  sequence: number;
  turnId?: string;
  surface: 'browser' | 'computer';
  provider?: string;
  sessionState?: SurfaceSessionStateV1;
  phase: SurfaceExecutionEventV1['phase'];
  status: SurfaceExecutionEventV1['status'];
  userSummary: string;
  operation?: {
    action: string;
    risk: string;
    approvalScope?: string;
    expectedOutcome?: string;
  };
  observation?: {
    verdict: NonNullable<SurfaceExecutionEventV1['observation']>['verdict'];
    findings: string[];
    confidence?: number;
  };
  evidenceRefs: string[];
  evidence: SurfaceExecutionExportEvidenceV1[];
  artifactRefs: string[];
  availableControls: SurfaceExecutionControlV1[];
  actionResult?: SurfaceExecutionExportActionResultV1;
  startedAt: number;
  completedAt?: number;
}

export interface SurfaceExecutionExportSessionV1 {
  sessionId: string;
  surface: 'browser' | 'computer';
  provider?: string;
  state?: SurfaceSessionStateV1;
  startedAt?: number;
  heartbeatAt?: number;
  source: 'native' | 'compat';
  events: SurfaceExecutionExportEventV1[];
}

export interface SurfaceExecutionExportProjectionV1 {
  version: 1;
  sessions: SurfaceExecutionExportSessionV1[];
}

export interface SurfaceExecutionExportFallback {
  toolName?: string;
  toolCallId?: string;
  success?: boolean;
  error?: string;
  timestamp?: number;
}

export interface SurfaceExecutionExportMessageLike {
  timestamp?: number;
  metadata?: object;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
    result?: {
      success?: boolean;
      error?: string;
      metadata?: Record<string, unknown>;
    };
  }>;
  toolResults?: Array<{
    toolCallId: string;
    success?: boolean;
    error?: string;
    metadata?: Record<string, unknown>;
  }>;
}

const SESSION_STATES = new Set<SurfaceSessionStateV1>([
  'preparing',
  'waiting_permission',
  'running',
  'waiting_human',
  'paused',
  'stopping',
  'completed',
  'failed',
]);

const SURFACES = new Set<SurfaceExecutionExportSessionV1['surface']>(['browser', 'computer']);
const SESSION_SOURCES = new Set<SurfaceExecutionExportSessionV1['source']>(['native', 'compat']);
const EVENT_PHASES = new Set<SurfaceExecutionEventV1['phase']>([
  'prepare', 'observe', 'act', 'verify', 'human', 'recover', 'artifact', 'cleanup',
]);
const EVENT_STATUSES = new Set<SurfaceExecutionEventV1['status']>([
  'queued', 'running', 'waiting', 'succeeded', 'failed', 'ambiguous', 'cancelled',
]);
const OBSERVATION_VERDICTS = new Set<
  NonNullable<SurfaceExecutionEventV1['observation']>['verdict']
>([
  'pass', 'partial', 'fail', 'inconclusive', 'not_requested',
]);
const SURFACE_CONTROLS = new Set<SurfaceExecutionControlV1>([
  'pause', 'resume', 'continue', 'takeover', 'skip', 'stop', 'end_session',
]);
const EVIDENCE_KINDS = new Set<SurfaceEvidenceKindV1>([
  'screenshot', 'dom', 'a11y', 'ax', 'window', 'network', 'console',
]);
const EVIDENCE_SOURCES = new Set<SurfaceEvidenceCardV1['source']>([
  'browser', 'computer', 'compat',
]);
const EVIDENCE_REDACTION_STATUSES = new Set<SurfaceEvidenceCardV1['redactionStatus']>([
  'clean', 'redacted', 'blocked',
]);
const EVIDENCE_CAPTURE_STATES = new Set<SurfaceEvidenceInspectionV1['captureState']>([
  'captured', 'unavailable', 'blocked',
]);
const EVIDENCE_ANALYSIS_STATES = new Set<SurfaceEvidenceInspectionV1['analysisState']>([
  'not_requested', 'analyzing', 'analyzed', 'failed',
]);
const EVIDENCE_VERIFICATION_STATES = new Set<SurfaceEvidenceInspectionV1['verificationState']>([
  'not_requested', 'verified', 'rejected', 'inconclusive',
]);
const EVIDENCE_INSPECTOR_KINDS = new Set<
  NonNullable<SurfaceEvidenceInspectionV1['inspectedBy']>['kind']
>([
  'agent', 'human', 'service',
]);
const EVIDENCE_INSPECTION_METHODS = new Set<
  NonNullable<SurfaceEvidenceInspectionV1['inspectedBy']>['method']
>([
  'vision', 'dom', 'a11y', 'ax', 'manual',
]);
const EVIDENCE_CHECKLIST_STATUSES = new Set<
  SurfaceEvidenceInspectionV1['checklist'][number]['status']
>([
  'passed', 'failed', 'inconclusive', 'not_checked',
]);
const ACTION_DELIVERIES = new Set<SurfaceActionResultV1['delivery']>([
  'not_attempted', 'confirmed', 'rejected', 'unknown',
]);
const ACTION_VERIFICATIONS = new Set<SurfaceActionResultV1['verification']>([
  'preexisting', 'satisfied', 'unsatisfied', 'inconclusive', 'not_requested',
]);
const ACTION_OVERALLS = new Set<SurfaceActionResultV1['overall']>([
  'succeeded', 'failed', 'ambiguous', 'delivered_unverified',
]);

const MAX_EXPORT_COLLECTION_ITEMS = 200;
const MAX_EXPORT_ID_LENGTH = 240;
const MAX_EXPORT_REFERENCE_LENGTH = 500;
const MAX_EXPORT_LABEL_LENGTH = 500;
const MAX_EXPORT_TEXT_LENGTH = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, maxLength = 1_000): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const redacted = redactSurfaceExecutionValue(value);
  if (typeof redacted !== 'string') return undefined;
  return redacted.slice(0, maxLength);
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function allowedValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T | undefined {
  return typeof value === 'string' && allowed.has(value as T)
    ? value as T
    : undefined;
}

function safeStringArray(
  value: unknown,
  maxLength = MAX_EXPORT_REFERENCE_LENGTH,
): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .slice(0, MAX_EXPORT_COLLECTION_ITEMS)
    .map((item) => safeString(item, maxLength))
    .filter((item): item is string => Boolean(item));
  return Array.from(new Set(items));
}

function allowedArray<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .slice(0, MAX_EXPORT_COLLECTION_ITEMS)
    .map((item) => allowedValue(item, allowed))
    .filter((item): item is T => Boolean(item));
  return Array.from(new Set(items));
}

function projectError(value: unknown): SurfaceExecutionExportErrorV1 | undefined {
  if (!isRecord(value)) return undefined;
  const code = safeString(value.code, 120);
  const message = safeString(value.message, 1_000);
  const phase = allowedValue(value.phase, EVENT_PHASES);
  if (!code || !message) return undefined;
  return {
    code,
    message,
    ...(phase ? { phase } : {}),
    ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
    ...(typeof value.userActionRequired === 'boolean'
      ? { userActionRequired: value.userActionRequired }
      : {}),
    ...(safeString(value.recommendedAction, 1_000)
      ? { recommendedAction: safeString(value.recommendedAction, 1_000) }
      : {}),
  };
}

function projectActionResult(
  metadata: Record<string, unknown>,
  fallback?: SurfaceExecutionExportFallback,
): SurfaceExecutionExportActionResultV1 | undefined {
  const candidate = metadata.surfaceExecutionActionResultV1
    ?? metadata.surfaceActionResultV1
    ?? metadata.computerUseActionResultV1;
  const value = isRecord(candidate) ? candidate : null;
  const standaloneError = projectError(metadata.surfaceExecutionErrorV1);
  const delivery = allowedValue(value?.delivery, ACTION_DELIVERIES);
  const verification = allowedValue(value?.verification, ACTION_VERIFICATIONS);
  const overall = allowedValue(value?.overall, ACTION_OVERALLS);
  const projected: SurfaceExecutionExportActionResultV1 = {
    ...(safeString(value?.operationId, 200) ? { operationId: safeString(value?.operationId, 200) } : {}),
    ...(delivery ? { delivery } : {}),
    ...(verification ? { verification } : {}),
    ...(overall ? { overall } : {}),
    ...(projectError(value?.error) || standaloneError
      ? { error: projectError(value?.error) || standaloneError }
      : {}),
  };
  if (!projected.error && fallback?.success === false && fallback.error) {
    projected.error = {
      code: safeString(metadata.code, 120) || 'TOOL_RESULT_FAILED',
      message: safeString(fallback.error, 1_000) || 'Surface operation failed',
    };
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectEvidence(card: SurfaceEvidenceCardV1): SurfaceExecutionExportEvidenceV1 {
  const safe = redactSurfaceExecutionValue(card) as SurfaceEvidenceCardV1;
  const captureContext = projectSurfaceEvidenceCaptureContextForExport(safe.captureContext);
  return {
    evidenceId: safe.evidenceId,
    kind: safe.kind,
    source: safe.source,
    title: safe.title,
    ...(safe.summary ? { summary: safe.summary } : {}),
    capturedAt: safe.capturedAt,
    ...(captureContext ? { captureContext } : {}),
    redactionStatus: safe.redactionStatus,
    captureState: safe.inspection.captureState,
    analysisState: safe.inspection.analysisState,
    verificationState: safe.inspection.verificationState,
    ...(safe.inspection.inspectedBy ? { inspectedBy: { ...safe.inspection.inspectedBy } } : {}),
    ...(safe.inspection.inspectedAt !== undefined ? { inspectedAt: safe.inspection.inspectedAt } : {}),
    supportsStepIds: [...safe.inspection.supportsStepIds],
    checklist: safe.inspection.checklist.map((item) => ({ ...item })),
    ...(safe.inspection.beforeEvidenceRef
      ? { beforeEvidenceRef: safe.inspection.beforeEvidenceRef }
      : {}),
    ...(safe.inspection.afterEvidenceRef
      ? { afterEvidenceRef: safe.inspection.afterEvidenceRef }
      : {}),
  };
}

function projectEvent(event: SurfaceExecutionEventV1): SurfaceExecutionExportEventV1 {
  const safe = sanitizeSurfaceExecutionEventV1(event);
  return {
    eventId: safe.eventId,
    sequence: safe.sequence,
    ...(safe.turnId ? { turnId: safe.turnId } : {}),
    surface: safe.surface,
    ...(safe.provider ? { provider: safe.provider } : {}),
    ...(safe.sessionState ? { sessionState: safe.sessionState } : {}),
    phase: safe.phase,
    status: safe.status,
    userSummary: safe.userSummary,
    ...(safe.operation ? { operation: { ...safe.operation } } : {}),
    ...(safe.observation
      ? {
          observation: {
            verdict: safe.observation.verdict,
            findings: [...safe.observation.findings],
            ...(safe.observation.confidence !== undefined
              ? { confidence: safe.observation.confidence }
              : {}),
          },
        }
      : {}),
    evidenceRefs: [...safe.evidenceRefs],
    evidence: (safe.evidence || []).filter(isSurfaceEvidenceCardV1).map(projectEvidence),
    artifactRefs: [...safe.artifactRefs],
    availableControls: [...safe.availableControls],
    startedAt: safe.startedAt,
    ...(safe.completedAt !== undefined ? { completedAt: safe.completedAt } : {}),
  };
}

function readSurfaceEvents(metadata: Record<string, unknown>): SurfaceExecutionEventV1[] {
  const rawEvents = metadata.surfaceExecutionEventsV1;
  const eventValues: unknown[] = Array.isArray(rawEvents) ? rawEvents as unknown[] : [];
  const candidates: unknown[] = eventValues.concat(metadata.surfaceExecutionEventV1);
  const deduped = new Map<string, SurfaceExecutionEventV1>();
  for (const candidate of candidates) {
    if (!isSurfaceExecutionEventV1(candidate)) continue;
    deduped.set(`${candidate.sessionId}:${candidate.eventId}`, candidate);
  }
  return [...deduped.values()].sort((left, right) => (
    left.sequence - right.sequence || left.startedAt - right.startedAt
  ));
}

function sessionState(value: unknown): SurfaceSessionStateV1 | undefined {
  return typeof value === 'string' && SESSION_STATES.has(value as SurfaceSessionStateV1)
    ? value as SurfaceSessionStateV1
    : undefined;
}

function parseExportChecklist(
  value: unknown,
): SurfaceExecutionExportEvidenceV1['checklist'] | null {
  if (!Array.isArray(value)) return null;
  const checklist: SurfaceExecutionExportEvidenceV1['checklist'] = [];
  for (const candidate of value.slice(0, MAX_EXPORT_COLLECTION_ITEMS)) {
    if (!isRecord(candidate)) continue;
    const id = safeString(candidate.id, MAX_EXPORT_ID_LENGTH);
    const label = safeString(candidate.label, MAX_EXPORT_LABEL_LENGTH);
    const status = allowedValue(candidate.status, EVIDENCE_CHECKLIST_STATUSES);
    if (!id || !label || !status) continue;
    const finding = safeString(candidate.finding, MAX_EXPORT_TEXT_LENGTH);
    checklist.push({
      id,
      label,
      status,
      ...(finding ? { finding } : {}),
    });
  }
  return checklist;
}

function parseExportEvidence(value: unknown): SurfaceExecutionExportEvidenceV1 | null {
  if (!isRecord(value)) return null;
  const evidenceId = safeString(value.evidenceId, MAX_EXPORT_ID_LENGTH);
  const kind = allowedValue(value.kind, EVIDENCE_KINDS);
  const source = allowedValue(value.source, EVIDENCE_SOURCES);
  const title = safeString(value.title, MAX_EXPORT_LABEL_LENGTH);
  const capturedAt = safeNumber(value.capturedAt);
  const redactionStatus = allowedValue(value.redactionStatus, EVIDENCE_REDACTION_STATUSES);
  const captureState = allowedValue(value.captureState, EVIDENCE_CAPTURE_STATES);
  const analysisState = allowedValue(value.analysisState, EVIDENCE_ANALYSIS_STATES);
  const verificationState = allowedValue(value.verificationState, EVIDENCE_VERIFICATION_STATES);
  const supportsStepIds = safeStringArray(value.supportsStepIds, MAX_EXPORT_ID_LENGTH);
  const checklist = parseExportChecklist(value.checklist);
  if (
    !evidenceId
    || !kind
    || !source
    || !title
    || capturedAt === undefined
    || !redactionStatus
    || !captureState
    || !analysisState
    || !verificationState
    || supportsStepIds === null
    || checklist === null
  ) {
    return null;
  }

  const summary = safeString(value.summary, MAX_EXPORT_TEXT_LENGTH);
  const captureContext = projectSurfaceEvidenceCaptureContextForExport(value.captureContext);
  const inspectedAt = safeNumber(value.inspectedAt);
  const beforeEvidenceRef = safeString(value.beforeEvidenceRef, MAX_EXPORT_REFERENCE_LENGTH);
  const afterEvidenceRef = safeString(value.afterEvidenceRef, MAX_EXPORT_REFERENCE_LENGTH);
  let inspectedBy: SurfaceExecutionExportEvidenceV1['inspectedBy'];
  if (isRecord(value.inspectedBy)) {
    const inspectorKind = allowedValue(value.inspectedBy.kind, EVIDENCE_INSPECTOR_KINDS);
    const inspectorId = safeString(value.inspectedBy.id, MAX_EXPORT_ID_LENGTH);
    const method = allowedValue(value.inspectedBy.method, EVIDENCE_INSPECTION_METHODS);
    if (inspectorKind && inspectorId && method) {
      inspectedBy = { kind: inspectorKind, id: inspectorId, method };
    }
  }

  return {
    evidenceId,
    kind,
    source,
    title,
    ...(summary ? { summary } : {}),
    capturedAt,
    ...(captureContext ? { captureContext } : {}),
    redactionStatus,
    captureState,
    analysisState,
    verificationState,
    ...(inspectedBy ? { inspectedBy } : {}),
    ...(inspectedAt !== undefined ? { inspectedAt } : {}),
    supportsStepIds,
    checklist,
    ...(beforeEvidenceRef ? { beforeEvidenceRef } : {}),
    ...(afterEvidenceRef ? { afterEvidenceRef } : {}),
  };
}

function parseExportActionResult(
  value: unknown,
): SurfaceExecutionExportActionResultV1 | undefined {
  if (!isRecord(value)) return undefined;
  const operationId = safeString(value.operationId, MAX_EXPORT_ID_LENGTH);
  const delivery = allowedValue(value.delivery, ACTION_DELIVERIES);
  const verification = allowedValue(value.verification, ACTION_VERIFICATIONS);
  const overall = allowedValue(value.overall, ACTION_OVERALLS);
  const error = projectError(value.error);
  const result: SurfaceExecutionExportActionResultV1 = {
    ...(operationId ? { operationId } : {}),
    ...(delivery ? { delivery } : {}),
    ...(verification ? { verification } : {}),
    ...(overall ? { overall } : {}),
    ...(error ? { error } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseExportEvent(
  value: unknown,
  expectedSurface: SurfaceExecutionExportSessionV1['surface'],
): SurfaceExecutionExportEventV1 | null {
  if (!isRecord(value)) return null;
  const eventId = safeString(value.eventId, MAX_EXPORT_ID_LENGTH);
  const sequence = safeInteger(value.sequence);
  const surface = allowedValue(value.surface, SURFACES);
  const phase = allowedValue(value.phase, EVENT_PHASES);
  const status = allowedValue(value.status, EVENT_STATUSES);
  const userSummary = safeString(value.userSummary, MAX_EXPORT_TEXT_LENGTH);
  const evidenceRefs = safeStringArray(value.evidenceRefs, MAX_EXPORT_REFERENCE_LENGTH);
  const artifactRefs = safeStringArray(value.artifactRefs, MAX_EXPORT_REFERENCE_LENGTH);
  const availableControls = allowedArray(value.availableControls, SURFACE_CONTROLS);
  const startedAt = safeNumber(value.startedAt);
  if (
    !eventId
    || sequence === undefined
    || !surface
    || surface !== expectedSurface
    || !phase
    || !status
    || !userSummary
    || evidenceRefs === null
    || artifactRefs === null
    || availableControls === null
    || startedAt === undefined
    || !Array.isArray(value.evidence)
  ) {
    return null;
  }

  const evidence = value.evidence
    .slice(0, MAX_EXPORT_COLLECTION_ITEMS)
    .map(parseExportEvidence)
    .filter((candidate): candidate is SurfaceExecutionExportEvidenceV1 => Boolean(candidate));
  const turnId = safeString(value.turnId, MAX_EXPORT_ID_LENGTH);
  const provider = safeString(value.provider, 120);
  const state = sessionState(value.sessionState);
  const completedAt = safeNumber(value.completedAt);
  let operation: SurfaceExecutionExportEventV1['operation'];
  if (isRecord(value.operation)) {
    const action = safeString(value.operation.action, 120);
    const risk = safeString(value.operation.risk, 120);
    if (action && risk) {
      const approvalScope = safeString(value.operation.approvalScope, MAX_EXPORT_LABEL_LENGTH);
      const expectedOutcome = safeString(value.operation.expectedOutcome, MAX_EXPORT_TEXT_LENGTH);
      operation = {
        action,
        risk,
        ...(approvalScope ? { approvalScope } : {}),
        ...(expectedOutcome ? { expectedOutcome } : {}),
      };
    }
  }
  let observation: SurfaceExecutionExportEventV1['observation'];
  if (isRecord(value.observation)) {
    const verdict = allowedValue(value.observation.verdict, OBSERVATION_VERDICTS);
    const findings = safeStringArray(value.observation.findings, MAX_EXPORT_TEXT_LENGTH);
    if (verdict && findings !== null) {
      const confidence = safeNumber(value.observation.confidence);
      observation = {
        verdict,
        findings,
        ...(confidence !== undefined ? { confidence } : {}),
      };
    }
  }
  const actionResult = parseExportActionResult(value.actionResult);

  return {
    eventId,
    sequence,
    ...(turnId ? { turnId } : {}),
    surface,
    ...(provider ? { provider } : {}),
    ...(state ? { sessionState: state } : {}),
    phase,
    status,
    userSummary,
    ...(operation ? { operation } : {}),
    ...(observation ? { observation } : {}),
    evidenceRefs,
    evidence,
    artifactRefs,
    availableControls,
    ...(actionResult ? { actionResult } : {}),
    startedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

function parseExportSession(value: unknown): SurfaceExecutionExportSessionV1 | null {
  if (!isRecord(value) || !Array.isArray(value.events)) return null;
  const sessionId = safeString(value.sessionId, MAX_EXPORT_ID_LENGTH);
  const surface = allowedValue(value.surface, SURFACES);
  const source = allowedValue(value.source, SESSION_SOURCES);
  if (!sessionId || !surface || !source) return null;

  const eventsById = new Map<string, SurfaceExecutionExportEventV1>();
  for (const eventValue of value.events.slice(0, MAX_EXPORT_COLLECTION_ITEMS)) {
    const event = parseExportEvent(eventValue, surface);
    if (event && !eventsById.has(event.eventId)) eventsById.set(event.eventId, event);
  }
  const provider = safeString(value.provider, 120);
  const state = sessionState(value.state);
  const startedAt = safeNumber(value.startedAt);
  const heartbeatAt = safeNumber(value.heartbeatAt);
  return {
    sessionId,
    surface,
    ...(provider ? { provider } : {}),
    ...(state ? { state } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(heartbeatAt !== undefined ? { heartbeatAt } : {}),
    source,
    events: [...eventsById.values()].sort((left, right) => (
      left.sequence - right.sequence || left.startedAt - right.startedAt
    )),
  };
}

export function parseSurfaceExecutionExportProjectionV1(
  value: unknown,
): SurfaceExecutionExportProjectionV1 | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) return null;
  const sessionsById = new Map<string, SurfaceExecutionExportSessionV1>();
  for (const sessionValue of value.sessions.slice(0, MAX_EXPORT_COLLECTION_ITEMS)) {
    const session = parseExportSession(sessionValue);
    if (session && !sessionsById.has(session.sessionId)) {
      sessionsById.set(session.sessionId, session);
    }
  }
  return sessionsById.size > 0
    ? { version: 1, sessions: [...sessionsById.values()] }
    : null;
}

function projectSurfaceExecutionLedgerForExport(
  value: unknown,
): SurfaceExecutionExportProjectionV1 | null {
  if (!isSurfaceConversationSnapshotV1(value)) return null;
  const snapshot: SurfaceConversationSnapshotV1 = value;
  const sessions: SurfaceExecutionExportSessionV1[] = snapshot.sessions.map((projection) => {
    const evidenceById = new Map(
      projection.evidence
        .filter(isSurfaceEvidenceCardV1)
        .map((card) => [card.evidenceId, projectEvidence(card)]),
    );
    const outputRefs = projection.outputs.map((output) => safeString(output.ref, 500)).filter(Boolean) as string[];
    const events = projection.events.map(projectEvent).map((event) => {
      const evidence = [...event.evidence];
      for (const evidenceRef of event.evidenceRefs) {
        const card = evidenceById.get(evidenceRef);
        if (card && !evidence.some((candidate) => candidate.evidenceId === card.evidenceId)) {
          evidence.push(card);
        }
      }
      return { ...event, evidence };
    });
    const lastEvent = events.at(-1);
    if (lastEvent) {
      lastEvent.availableControls = Array.from(new Set([
        ...lastEvent.availableControls,
        ...projection.availableControls,
      ]));
      lastEvent.artifactRefs = Array.from(new Set([
        ...lastEvent.artifactRefs,
        ...outputRefs,
      ]));
    }
    return {
      sessionId: projection.session.sessionId,
      surface: projection.session.surface,
      ...(safeString(projection.session.provider, 120)
        ? { provider: safeString(projection.session.provider, 120) }
        : {}),
      state: projection.session.state,
      startedAt: projection.session.startedAt,
      heartbeatAt: projection.session.heartbeatAt,
      source: projection.source === 'compat' ? 'compat' : 'native',
      events,
    };
  });
  return sessions.length > 0 ? { version: 1, sessions } : null;
}

export function projectSurfaceExecutionMetadataForExport(
  metadata: Record<string, unknown> | undefined,
  fallback?: SurfaceExecutionExportFallback,
): SurfaceExecutionExportProjectionV1 | null {
  if (!metadata) return null;
  const alreadySafe = parseSurfaceExecutionExportProjectionV1(metadata.surfaceExecutionExportV1);
  const ledger = projectSurfaceExecutionLedgerForExport(metadata.surfaceExecutionLedgerV1);

  const events = readSurfaceEvents(metadata);
  const rawSession = isRecord(metadata.surfaceExecutionSessionV1)
    ? metadata.surfaceExecutionSessionV1
    : null;
  const sessionId = safeString(rawSession?.sessionId, 240)
    || safeString(events[0]?.sessionId, 240);
  const surface = rawSession?.surface === 'browser' || rawSession?.surface === 'computer'
    ? rawSession.surface
    : events[0]?.surface;
  if (!sessionId || (surface !== 'browser' && surface !== 'computer')) {
    return mergeSurfaceExecutionExportProjections([alreadySafe, ledger]);
  }

  const provider = safeString(rawSession?.provider, 120)
    || safeString(events.find((event) => event.provider)?.provider, 120);
  const state = sessionState(rawSession?.state)
    || events.slice().reverse().map((event) => event.sessionState).find(Boolean);
  const projectedEvents = events.map(projectEvent);
  const actionResult = projectActionResult(metadata, fallback);
  if (actionResult && projectedEvents.length > 0) {
    projectedEvents[projectedEvents.length - 1] = {
      ...projectedEvents[projectedEvents.length - 1],
      actionResult,
    };
  }

  const native: SurfaceExecutionExportProjectionV1 = {
    version: 1,
    sessions: [{
      sessionId,
      surface,
      ...(provider ? { provider } : {}),
      ...(state ? { state } : {}),
      ...(safeNumber(rawSession?.startedAt) !== undefined
        ? { startedAt: safeNumber(rawSession?.startedAt) }
        : {}),
      ...(safeNumber(rawSession?.heartbeatAt) !== undefined
        ? { heartbeatAt: safeNumber(rawSession?.heartbeatAt) }
        : {}),
      source: metadata.surfaceProjectionMode === 'compatibility' ? 'compat' : 'native',
      events: projectedEvents,
    }],
  };
  return mergeSurfaceExecutionExportProjections([alreadySafe, ledger, native]);
}

export function mergeSurfaceExecutionExportProjections(
  projections: Array<SurfaceExecutionExportProjectionV1 | null | undefined>,
): SurfaceExecutionExportProjectionV1 | null {
  const sessions = new Map<string, SurfaceExecutionExportSessionV1>();
  for (const projection of projections) {
    for (const candidate of projection?.sessions || []) {
      const existing = sessions.get(candidate.sessionId);
      if (!existing) {
        sessions.set(candidate.sessionId, {
          ...candidate,
          events: candidate.events.map((event) => ({ ...event })),
        });
        continue;
      }
      const events = new Map(existing.events.map((event) => [event.eventId, event]));
      for (const event of candidate.events) {
        const previous = events.get(event.eventId);
        events.set(event.eventId, previous
          ? {
              ...previous,
              ...event,
              evidenceRefs: Array.from(new Set([...previous.evidenceRefs, ...event.evidenceRefs])),
              evidence: [...previous.evidence, ...event.evidence]
                .filter((item, index, values) => (
                  values.findIndex((other) => other.evidenceId === item.evidenceId) === index
                )),
              artifactRefs: Array.from(new Set([...previous.artifactRefs, ...event.artifactRefs])),
              availableControls: Array.from(new Set([
                ...previous.availableControls,
                ...event.availableControls,
              ])),
            }
          : event);
      }
      sessions.set(candidate.sessionId, {
        ...existing,
        ...candidate,
        source: existing.source === 'native' || candidate.source === 'native' ? 'native' : 'compat',
        events: [...events.values()].sort((left, right) => (
          left.sequence - right.sequence || left.startedAt - right.startedAt
        )),
      });
    }
  }
  return sessions.size > 0
    ? parseSurfaceExecutionExportProjectionV1({ version: 1, sessions: [...sessions.values()] })
    : null;
}

export function collectSurfaceExecutionExportProjection(
  messages: SurfaceExecutionExportMessageLike[],
  sessionMetadata?: Record<string, unknown>,
): SurfaceExecutionExportProjectionV1 | null {
  const calls = new Map<string, NonNullable<SurfaceExecutionExportMessageLike['toolCalls']>[number]>();
  for (const message of messages) {
    for (const call of message.toolCalls || []) calls.set(call.id, call);
  }
  const projections: Array<SurfaceExecutionExportProjectionV1 | null> = [];
  projections.push(projectSurfaceExecutionMetadataForExport(sessionMetadata));
  for (const message of messages) {
    projections.push(projectSurfaceExecutionMetadataForExport(
      isRecord(message.metadata) ? message.metadata : undefined,
      {
      timestamp: message.timestamp,
      },
    ));
    for (const call of message.toolCalls || []) {
      projections.push(projectSurfaceExecutionMetadataForExport(call.result?.metadata, {
        toolName: call.name,
        toolCallId: call.id,
        success: call.result?.success,
        error: call.result?.error,
        timestamp: message.timestamp,
      }));
    }
    for (const result of message.toolResults || []) {
      const call = calls.get(result.toolCallId);
      projections.push(projectSurfaceExecutionMetadataForExport(result.metadata, {
        toolName: call?.name,
        toolCallId: result.toolCallId,
        success: result.success,
        error: result.error,
        timestamp: message.timestamp,
      }));
    }
  }
  return mergeSurfaceExecutionExportProjections(projections);
}

export function projectSurfaceExecutionResultMetadataForExport(
  metadata: Record<string, unknown> | undefined,
  fallback?: SurfaceExecutionExportFallback,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const projection = projectSurfaceExecutionMetadataForExport(metadata, fallback);
  const stripSurfaceAuthority = Boolean(projection)
    || carriesSurfaceExecutionAuthority(metadata)
    || isBrowserComputerToolName(fallback?.toolName);
  const stripped = stripRawSurfaceExecutionExportFields(
    metadata,
    0,
    stripSurfaceAuthority,
  ) as Record<string, unknown>;
  return {
    ...stripped,
    ...(projection ? { surfaceExecutionExportV1: projection } : {}),
  };
}

export function surfaceExecutionArgumentsForExport(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!args) return {};
  const action = safeString(args.action ?? args.operation, 120);
  const domainAllowlist = Array.isArray(args.domainAllowlist)
    ? args.domainAllowlist
        .filter((item): item is string => typeof item === 'string' && /^[a-z0-9.-]+$/i.test(item))
        .slice(0, 100)
    : [];
  return {
    ...(action ? { action } : {}),
    ...(domainAllowlist.length > 0 ? { domainAllowlist } : {}),
  };
}

function markdownText(value: string): string {
  return value.replace(/[\r\n|`]+/g, ' ').trim();
}

export function formatSurfaceExecutionProjectionForMarkdown(
  projection: SurfaceExecutionExportProjectionV1 | null | undefined,
): string {
  if (!projection || projection.sessions.length === 0) return '';
  const lines = ['## Surface Execution', ''];
  for (const session of projection.sessions) {
    const label = session.surface === 'browser' ? 'Browser' : 'Computer';
    const provider = session.provider ? ` · ${markdownText(session.provider)}` : '';
    const state = session.state ? ` · ${session.state}` : '';
    lines.push(`### ${label}${provider}${state}`);
    lines.push('');
    for (const event of session.events) {
      const completedAt = event.completedAt ?? event.startedAt;
      const time = Number.isFinite(completedAt) ? new Date(completedAt).toISOString() : 'time unavailable';
      lines.push(`- ${time} · ${event.phase} · ${event.status} · ${markdownText(event.userSummary)}`);
      if (event.operation) {
        const expected = event.operation.expectedOutcome
          ? ` · expected ${markdownText(event.operation.expectedOutcome)}`
          : '';
        lines.push(`  - Action: ${markdownText(event.operation.action)} · risk ${markdownText(event.operation.risk)}${expected}`);
      }
      if (event.observation) {
        const findings = event.observation.findings.length > 0
          ? ` · ${event.observation.findings.map(markdownText).join('; ')}`
          : '';
        lines.push(`  - Verdict: ${event.observation.verdict}${findings}`);
      }
      for (const evidence of event.evidence) {
        const checks = evidence.checklist.length > 0
          ? ` · checks ${evidence.checklist.map((item) => `${markdownText(item.label)}=${item.status}`).join(', ')}`
          : '';
        lines.push(`  - Evidence: ${markdownText(evidence.title)} · capture=${evidence.captureState} · analysis=${evidence.analysisState} · verification=${evidence.verificationState} · redaction=${evidence.redactionStatus}${checks}`);
      }
      if (event.evidenceRefs.length > 0) {
        lines.push(`  - Evidence refs: ${event.evidenceRefs.map(markdownText).join(', ')}`);
      }
      if (event.actionResult) {
        const result = event.actionResult;
        lines.push(`  - Result: delivery=${result.delivery || 'unknown'} · verification=${result.verification || 'unknown'} · overall=${result.overall || event.status}`);
        if (result.error) {
          const recommendation = result.error.recommendedAction
            ? ` · ${markdownText(result.error.recommendedAction)}`
            : '';
          lines.push(`  - Error: ${markdownText(result.error.code)} · ${markdownText(result.error.message)}${recommendation}`);
        }
      }
      if (event.availableControls.length > 0) {
        lines.push(`  - Controls: ${event.availableControls.join(', ')}`);
      }
      if (event.artifactRefs.length > 0) {
        lines.push(`  - Outputs: ${event.artifactRefs.map(markdownText).join(', ')}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
