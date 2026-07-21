import { createHash } from 'node:crypto';
import type { ToolExecutionResult } from '../../tools/types';
import type {
  SurfaceEvidenceCaptureContextV1,
  SurfaceEvidenceCardV1,
  SurfaceEvidenceInspectionV1,
  SurfaceEvidenceKindV1,
  SurfaceExecutionEventV1,
  SurfaceKind,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import {
  isSurfaceExecutionEventV1,
  isSurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import {
  redactSurfaceExecutionValue,
  sanitizeSurfaceExecutionEventV1,
} from '../../../shared/utils/surfaceExecutionRedaction';
import { sanitizeBrowserComputerToolResult } from '../../../shared/utils/browserComputerRedaction';

type SurfaceProofToolName = 'browser_action' | 'computer_use';
type SurfaceInspectionMethod = NonNullable<SurfaceEvidenceInspectionV1['inspectedBy']>['method'];

export interface SurfaceProofIdentityV1 {
  conversationId?: string;
  runId?: string;
  turnId?: string;
  agentId?: string;
  surfaceSessionId?: string;
  operationId?: string;
}

export interface FinalizeSurfaceProofInput {
  toolName: SurfaceProofToolName;
  action: string;
  result: ToolExecutionResult;
  identity?: SurfaceProofIdentityV1;
  surface?: SurfaceKind;
}

interface ResolvedSurfaceProofScopeV1 {
  version: 1;
  conversationId: string;
  runId: string;
  turnId?: string;
  agentId: string;
  surfaceSessionId: string;
  operationId: string;
  surface: SurfaceKind;
}

interface EvidenceCandidate {
  id: string;
  kind?: SurfaceEvidenceKindV1;
  capturedAt?: number;
  redactionStatus: SurfaceEvidenceCardV1['redactionStatus'];
}

interface SurfaceProofServiceOptions {
  now?: () => number;
}

const CANARY_PATTERN = /surface(?:[_-](?:secret|redaction))?[_-]canary|canary[_-](?:secret|redaction)/i;
const RAW_BINARY_KEYS = new Set([
  'base64',
  'base64Image',
  'data',
  'imageBase64',
  'imageDataUrl',
  'image_base64',
  'screenshotBase64',
  'screenshotData',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value as unknown[] : [];
}

function hasRawBinary(metadata: Record<string, unknown>): boolean {
  return Array.from(RAW_BINARY_KEYS).some((key) => typeof metadata[key] === 'string');
}

function stableRef(prefix: string, values: unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 20);
  return `${prefix}:${digest}`;
}

function safeEvidenceId(
  scope: ResolvedSurfaceProofScopeV1,
  value: string,
): string {
  if (
    value.length <= 512
    && !CANARY_PATTERN.test(value)
    && (/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value) || /^(?:artifact|evidence|screenshot):\/\//.test(value))
  ) {
    return value;
  }
  return stableRef('surface-evidence', [scope.surfaceSessionId, scope.operationId, value]);
}

function containsCanary(value: unknown, depth = 0, visited = new Set<object>()): boolean {
  if (depth > 7) return false;
  if (typeof value === 'string') return CANARY_PATTERN.test(value);
  if (!value || typeof value !== 'object') return false;
  if (visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).some((item) => containsCanary(item, depth + 1, visited));
  }
  return Object.entries(value as Record<string, unknown>).slice(0, 200).some(([key, child]) => (
    !RAW_BINARY_KEYS.has(key) && containsCanary(child, depth + 1, visited)
  ));
}

function mapEvidenceKind(value: unknown): SurfaceEvidenceKindV1 | undefined {
  if (value === 'screenshot') return 'screenshot';
  if (value === 'browser_dom' || value === 'dom') return 'dom';
  if (value === 'browser_a11y' || value === 'a11y') return 'a11y';
  if (value === 'computer_ax' || value === 'ax') return 'ax';
  if (value === 'window') return 'window';
  if (value === 'network') return 'network';
  if (value === 'console') return 'console';
  return undefined;
}

function mapRedactionStatus(value: unknown): SurfaceEvidenceCardV1['redactionStatus'] {
  if (value === 'blocked' || value === 'contains_secret_blocked') return 'blocked';
  if (value === 'redacted') return 'redacted';
  return 'clean';
}

function mergeRedactionStatus(
  values: SurfaceEvidenceCardV1['redactionStatus'][],
): SurfaceEvidenceCardV1['redactionStatus'] {
  if (values.includes('blocked')) return 'blocked';
  if (values.includes('redacted')) return 'redacted';
  return 'clean';
}

function eventsFromMetadata(metadata: Record<string, unknown>): SurfaceExecutionEventV1[] {
  return (Array.isArray(metadata.surfaceExecutionEventsV1)
    ? metadata.surfaceExecutionEventsV1
    : []).filter(isSurfaceExecutionEventV1);
}

function sessionFromMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  return recordValue(metadata.surfaceExecutionSessionV1);
}

function resolveScope(
  input: FinalizeSurfaceProofInput,
  metadata: Record<string, unknown>,
): ResolvedSurfaceProofScopeV1 | null {
  const session = sessionFromMetadata(metadata);
  const events = eventsFromMetadata(metadata);
  const lastEvent = events.at(-1);
  const surface = input.surface
    ?? (input.toolName === 'browser_action' ? 'browser' : 'computer');
  const conversationId = stringValue(input.identity?.conversationId);
  const runId = stringValue(input.identity?.runId);
  const agentId = stringValue(input.identity?.agentId);
  const surfaceSessionId = stringValue(input.identity?.surfaceSessionId)
    ?? stringValue(metadata.surfaceSessionId)
    ?? stringValue(session?.sessionId)
    ?? stringValue(lastEvent?.sessionId);
  const operationId = stringValue(input.identity?.operationId)
    ?? stringValue(recordValue(metadata.surfaceExecutionActionResultV1)?.operationId);
  if (!conversationId || !runId || !agentId || !surfaceSessionId || !operationId) return null;
  return {
    version: 1,
    conversationId,
    runId,
    ...(stringValue(input.identity?.turnId) ? { turnId: stringValue(input.identity?.turnId) } : {}),
    agentId,
    surfaceSessionId,
    operationId,
    surface,
  };
}

function scopeMismatch(
  scope: ResolvedSurfaceProofScopeV1,
  metadata: Record<string, unknown>,
): string | null {
  const session = sessionFromMetadata(metadata);
  const checks: Array<[unknown, string, string]> = [
    [session?.sessionId, scope.surfaceSessionId, 'session.sessionId'],
    [session?.conversationId, scope.conversationId, 'session.conversationId'],
    [session?.runId, scope.runId, 'session.runId'],
    [session?.agentId, scope.agentId, 'session.agentId'],
    [session?.surface, scope.surface, 'session.surface'],
  ];
  for (const [actual, expected, field] of checks) {
    if (stringValue(actual) && actual !== expected) return field;
  }
  if (scope.turnId && stringValue(session?.turnId) && session?.turnId !== scope.turnId) {
    return 'session.turnId';
  }
  for (const event of eventsFromMetadata(metadata)) {
    if (event.sessionId !== scope.surfaceSessionId) return 'event.sessionId';
    if (event.conversationId && event.conversationId !== scope.conversationId) return 'event.conversationId';
    if (event.runId !== scope.runId) return 'event.runId';
    if (event.agentId !== scope.agentId) return 'event.agentId';
    if (scope.turnId && event.turnId && event.turnId !== scope.turnId) return 'event.turnId';
    if (event.surface !== scope.surface) return 'event.surface';
  }
  return null;
}

function actionResultFromMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  return recordValue(metadata.surfaceExecutionActionResultV1)
    ?? recordValue(metadata.surfaceActionResultV1)
    ?? recordValue(metadata.computerUseActionResultV1);
}

function candidateFromLegacy(value: unknown): EvidenceCandidate | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  if (!id) return null;
  const freshness = recordValue(value.freshness);
  return {
    id,
    ...(mapEvidenceKind(value.kind) ? { kind: mapEvidenceKind(value.kind) } : {}),
    ...(numberValue(freshness?.capturedAtMs) !== undefined
      ? { capturedAt: numberValue(freshness?.capturedAtMs) }
      : {}),
    redactionStatus: mapRedactionStatus(value.redactionStatus),
  };
}

function collectCandidates(
  metadata: Record<string, unknown>,
  scope: ResolvedSurfaceProofScopeV1,
): EvidenceCandidate[] {
  const proof = recordValue(metadata.browserComputerProof);
  const legacy = (Array.isArray(proof?.evidenceRefs) ? proof.evidenceRefs : [])
    .map(candidateFromLegacy)
    .filter((candidate): candidate is EvidenceCandidate => Boolean(candidate));
  const actionResult = actionResultFromMetadata(metadata);
  const successor = recordValue(actionResult?.successorState);
  const observation = recordValue(metadata.surfaceObservationV1);
  const state = recordValue(metadata.computerUseStateV1);
  const artifacts = [
    metadata.artifact,
    metadata.browserArtifact,
    metadata.outputArtifact,
    ...arrayValue(metadata.artifacts),
  ].flatMap((value) => {
    const artifact = recordValue(value);
    const id = stringValue(artifact?.artifactId ?? artifact?.id ?? artifact?.ref);
    if (!id) return [];
    const kind = stringValue(artifact?.kind);
    const mimeType = stringValue(artifact?.mimeType);
    return [{
      id: safeEvidenceId(scope, id),
      ...(kind === 'image' || mimeType?.startsWith('image/') ? { kind: 'screenshot' as const } : {}),
      redactionStatus: 'clean' as const,
    }];
  });
  const assetValues = [
    ...arrayValue(actionResult?.evidenceRefs),
    ...arrayValue(successor?.evidenceAssetIds),
    ...arrayValue(observation?.evidenceAssetIds),
    actionResult?.evidenceRef,
    state?.screenshotId,
    metadata.imagePath,
    metadata.outputPath,
    metadata.path,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const generated = assetValues.map((value) => ({
    id: safeEvidenceId(scope, value),
    kind: /screenshot|image|\.png|\.jpe?g|\.webp/i.test(value)
      ? 'screenshot' as const
      : undefined,
    redactionStatus: 'clean' as const,
  }));
  return Array.from(new Map(
    [...artifacts, ...legacy, ...generated].map((candidate) => [candidate.id, candidate]),
  ).values());
}

function elementKinds(value: unknown): string[] {
  const record = recordValue(value);
  return (Array.isArray(record?.elementRefs) ? record.elementRefs : [])
    .flatMap((item) => stringValue(recordValue(item)?.kind) ?? []);
}

function inspectionMethod(
  metadata: Record<string, unknown>,
  surface: SurfaceKind,
): SurfaceInspectionMethod | undefined {
  if (metadata.analyzed === true) return 'vision';
  if (metadata.domSnapshot) return 'dom';
  if (metadata.accessibilitySnapshot) return 'a11y';
  const actionResult = actionResultFromMetadata(metadata);
  const kinds = [
    ...elementKinds(metadata.surfaceObservationV1),
    ...elementKinds(recordValue(actionResult?.successorState)),
  ];
  const state = recordValue(metadata.computerUseStateV1);
  if (surface === 'computer' && (Array.isArray(state?.elements) || kinds.includes('computer-element'))) {
    return 'ax';
  }
  if (surface === 'browser' && kinds.includes('browser-element')) return 'dom';
  const proof = recordValue(metadata.browserComputerProof);
  const visual = recordValue(proof?.visualObservation);
  const source = stringValue(visual?.source);
  if (visual?.observed === true && source === 'analysis') return 'vision';
  if (visual?.observed === true && source === 'dom') return 'dom';
  if (visual?.observed === true && source === 'a11y') return 'a11y';
  if (visual?.observed === true && source === 'ax') return 'ax';
  return undefined;
}

function verificationState(
  result: ToolExecutionResult,
  actionResult: Record<string, unknown> | undefined,
): SurfaceEvidenceInspectionV1['verificationState'] {
  const verification = actionResult?.verification;
  if (verification === 'satisfied' || verification === 'preexisting') return 'verified';
  if (verification === 'unsatisfied') return 'rejected';
  if (verification === 'inconclusive') return 'inconclusive';
  if (actionResult?.overall === 'ambiguous') return 'inconclusive';
  if (actionResult?.overall === 'failed' || result.success === false) return 'rejected';
  return 'not_requested';
}

function checklist(
  actionResult: Record<string, unknown> | undefined,
  redactionStatus: SurfaceEvidenceCardV1['redactionStatus'],
): SurfaceEvidenceInspectionV1['checklist'] {
  const delivery = actionResult?.delivery;
  const verification = actionResult?.verification;
  const deliveryStatus = delivery === 'confirmed'
    ? 'passed'
    : delivery === 'rejected' || delivery === 'not_attempted'
      ? 'failed'
      : delivery === 'unknown' ? 'inconclusive' : 'not_checked';
  const verificationStatus = verification === 'satisfied' || verification === 'preexisting'
    ? 'passed'
    : verification === 'unsatisfied'
      ? 'failed'
      : verification === 'inconclusive'
        ? 'inconclusive'
        : 'not_checked';
  return [{
    id: 'delivery',
    label: 'Action delivery',
    status: deliveryStatus,
  }, {
    id: 'verification',
    label: 'Expected outcome',
    status: verificationStatus,
    ...(verificationStatus === 'failed'
      ? { finding: 'Re-observe the target and run this check again before retrying.' }
      : {}),
  }, {
    id: 'redaction',
    label: 'Evidence redaction',
    status: redactionStatus === 'blocked' ? 'failed' : 'passed',
  }];
}

function summaryFor(
  captureState: SurfaceEvidenceInspectionV1['captureState'],
  analysisState: SurfaceEvidenceInspectionV1['analysisState'],
  verification: SurfaceEvidenceInspectionV1['verificationState'],
): string {
  if (captureState === 'blocked') return 'Evidence was blocked by redaction policy; capture a clean replacement before verification.';
  if (verification === 'verified') return 'Outcome verified from the successor observation.';
  if (verification === 'rejected') return 'Verification failed. Re-observe the target and run the checklist again before retrying.';
  if (verification === 'inconclusive') return 'Verification is inconclusive. Inspect the successor state before retrying; do not replay the mutation automatically.';
  if (analysisState === 'analyzed') return 'Evidence inspected; no outcome expectation was requested.';
  if (captureState === 'captured') return 'Evidence captured; inspect it before claiming the outcome.';
  return 'No usable evidence was captured; observe the target before claiming the outcome.';
}

function stateReference(
  scope: ResolvedSurfaceProofScopeV1,
  stateId: unknown,
): string | undefined {
  const value = stringValue(stateId);
  return value ? stableRef('surface-state', [scope.surfaceSessionId, value]) : undefined;
}

function captureViewport(metadata: Record<string, unknown>): SurfaceEvidenceCaptureContextV1['viewport'] {
  const candidates = [
    metadata.viewport,
    recordValue(metadata.browserState)?.viewport,
    recordValue(metadata.browserDiagnostics)?.viewport,
  ];
  for (const candidate of candidates) {
    const value = recordValue(candidate);
    const width = numberValue(value?.width);
    const height = numberValue(value?.height);
    const deviceScaleFactor = numberValue(value?.deviceScaleFactor);
    if (width && width > 0 && height && height > 0) {
      return {
        width,
        height,
        ...(deviceScaleFactor && deviceScaleFactor > 0 ? { deviceScaleFactor } : {}),
      };
    }
  }
  return undefined;
}

function captureTarget(
  metadata: Record<string, unknown>,
  actionResult: Record<string, unknown> | undefined,
  surface: SurfaceKind,
): SurfaceTargetRefV1 | undefined {
  const session = sessionFromMetadata(metadata);
  const observation = recordValue(metadata.surfaceObservationV1);
  const successor = recordValue(actionResult?.successorState);
  const events = eventsFromMetadata(metadata);
  const candidates = [successor?.target, observation?.target, session?.activeTarget, events.at(-1)?.target];
  return candidates.find((candidate): candidate is SurfaceTargetRefV1 => (
    isSurfaceTargetRefV1(candidate) && candidate.kind === surface
  ));
}

function buildCard(
  input: FinalizeSurfaceProofInput,
  scope: ResolvedSurfaceProofScopeV1,
  metadata: Record<string, unknown>,
  now: number,
): SurfaceEvidenceCardV1 {
  const actionResult = actionResultFromMetadata(metadata);
  const successor = recordValue(actionResult?.successorState);
  const observation = recordValue(metadata.surfaceObservationV1);
  const candidates = collectCandidates(metadata, scope);
  const redactionStatus = containsCanary([input.result.output, input.result.error, metadata])
    ? 'blocked'
    : mergeRedactionStatus([
        mapRedactionStatus(recordValue(metadata.surfaceEvidenceCardV1)?.redactionStatus),
        ...candidates.map((candidate) => candidate.redactionStatus),
        mapRedactionStatus(successor?.redactionStatus),
        mapRedactionStatus(observation?.redactionStatus),
        metadata.imageEvidenceStatus === 'blocked' ? 'blocked' : 'clean',
        hasRawBinary(metadata) ? 'redacted' : 'clean',
      ]);
  const method = inspectionMethod(metadata, scope.surface);
  const analysisState = metadata.analysisRequested === true && metadata.analyzed !== true && !method
    ? 'failed'
    : method ? 'analyzed' : 'not_requested';
  const verification = verificationState(input.result, actionResult);
  const captureState = redactionStatus === 'blocked'
    ? 'blocked'
    : candidates.length > 0 || observation || successor ? 'captured' : 'unavailable';
  const primary = candidates.find((candidate) => candidate.kind === 'screenshot') ?? candidates[0];
  const beforeEvidenceRef = stateReference(scope, actionResult?.predecessorStateId);
  const afterEvidenceRef = primary?.id
    ?? stateReference(scope, successor?.stateId ?? observation?.stateId);
  const timestamps = [
    numberValue(observation?.observedAt) ?? 0,
    numberValue(successor?.observedAt) ?? 0,
    ...candidates.map((candidate) => candidate.capturedAt ?? 0),
    numberValue(recordValue(metadata.surfaceEvidenceCardV1)?.capturedAt) ?? 0,
  ].filter((value) => value > 0);
  const capturedAt = timestamps.length > 0 ? Math.max(...timestamps) : now;
  const target = captureTarget(metadata, actionResult, scope.surface);
  const viewport = captureViewport(metadata);
  const captureContext = target ? {
    target,
    ...(target.kind === 'browser' && target.origin ? { sourceUrl: target.origin } : {}),
    ...(viewport ? { viewport } : {}),
  } satisfies SurfaceEvidenceCaptureContextV1 : undefined;
  const card: SurfaceEvidenceCardV1 = {
    version: 1,
    evidenceId: stableRef('surface-proof', [
      scope.conversationId,
      scope.runId,
      scope.turnId || '',
      scope.agentId,
      scope.surfaceSessionId,
      scope.operationId,
    ]),
    kind: primary?.kind ?? (scope.surface === 'browser' ? 'dom' : 'ax'),
    source: scope.surface,
    title: `${scope.surface === 'browser' ? 'Browser' : 'Computer'} ${input.action} proof`,
    summary: summaryFor(captureState, analysisState, verification),
    capturedAt,
    ...(captureContext ? { captureContext } : {}),
    ...(primary && redactionStatus !== 'blocked' ? { assetRef: primary.id } : {}),
    ...(stringValue(successor?.stateId ?? observation?.stateId)
      ? { observationStateId: stringValue(successor?.stateId ?? observation?.stateId) }
      : {}),
    redactionStatus,
    inspection: {
      captureState,
      analysisState,
      verificationState: verification,
      ...(method
        ? {
            inspectedBy: {
              kind: 'service',
              id: `surface-proof-${scope.surface}`,
              method,
            },
            inspectedAt: capturedAt,
          }
        : {}),
      supportsStepIds: [scope.operationId],
      checklist: checklist(actionResult, redactionStatus),
      ...(beforeEvidenceRef ? { beforeEvidenceRef } : {}),
      ...(afterEvidenceRef ? { afterEvidenceRef } : {}),
    },
  };
  return redactSurfaceExecutionValue(card) as SurfaceEvidenceCardV1;
}

function cardVerdict(card: SurfaceEvidenceCardV1): NonNullable<SurfaceExecutionEventV1['observation']>['verdict'] {
  if (card.inspection.verificationState === 'verified') return 'pass';
  if (card.inspection.verificationState === 'rejected') return 'fail';
  if (card.inspection.verificationState === 'inconclusive') return 'inconclusive';
  return 'not_requested';
}

function attachCardToEvents(
  metadata: Record<string, unknown>,
  scope: ResolvedSurfaceProofScopeV1,
  card: SurfaceEvidenceCardV1,
): Record<string, unknown> {
  const events = eventsFromMetadata(metadata);
  const index = events.findLastIndex((event) => (
    event.sessionId === scope.surfaceSessionId
      && event.runId === scope.runId
      && event.agentId === scope.agentId
      && (!event.conversationId || event.conversationId === scope.conversationId)
      && event.surface === scope.surface
  ));
  if (index < 0) return metadata;
  const existing = events[index];
  const evidence = Array.from(new Map([
    ...(existing.evidence || []),
    card,
  ].map((item) => [item.evidenceId, item])).values());
  const nextVerdict = cardVerdict(card);
  const currentObservation = existing.observation;
  const event = sanitizeSurfaceExecutionEventV1({
    ...existing,
    evidenceRefs: Array.from(new Set([...existing.evidenceRefs, card.evidenceId])),
    evidence,
    observation: {
      verdict: nextVerdict === 'not_requested'
        ? currentObservation?.verdict ?? 'not_requested'
        : nextVerdict,
      findings: currentObservation?.findings || [],
      ...(currentObservation?.confidence !== undefined
        ? { confidence: currentObservation.confidence }
        : {}),
    },
  });
  const nextEvents = [...events];
  nextEvents[index] = event;
  return {
    ...metadata,
    surfaceExecutionEventsV1: nextEvents,
    ...(isRecord(metadata.surfaceExecutionEventV1)
      && metadata.surfaceExecutionEventV1.eventId === existing.eventId
      ? { surfaceExecutionEventV1: event }
      : {}),
  };
}

export class SurfaceProofService {
  private readonly now: () => number;

  constructor(options: SurfaceProofServiceOptions = {}) {
    this.now = options.now || Date.now;
  }

  finalizeToolResult(input: FinalizeSurfaceProofInput): ToolExecutionResult {
    const metadata = input.result.metadata || {};
    const canaryDetected = containsCanary([
      input.result.output,
      input.result.error,
      metadata,
    ]);
    const scope = resolveScope(input, metadata);
    if (!scope) {
      return canaryDetected
        ? sanitizeBrowserComputerToolResult(input.toolName, {}, input.result)
        : input.result;
    }
    const mismatch = scopeMismatch(scope, metadata);
    if (mismatch) {
      const next = { ...metadata };
      const rejectedEvidenceId = stringValue(recordValue(next.surfaceEvidenceCardV1)?.evidenceId);
      delete next.surfaceEvidenceCardV1;
      delete next.surfaceProofScopeV1;
      delete next.surfaceProofReverifyV1;
      if (rejectedEvidenceId) {
        const strippedEvents = eventsFromMetadata(next).map((event) => sanitizeSurfaceExecutionEventV1({
          ...event,
          evidenceRefs: event.evidenceRefs.filter((ref) => ref !== rejectedEvidenceId),
          ...(event.evidence
            ? { evidence: event.evidence.filter((card) => card.evidenceId !== rejectedEvidenceId) }
            : {}),
        }));
        next.surfaceExecutionEventsV1 = strippedEvents;
        if (isRecord(next.surfaceExecutionEventV1)) {
          const projectedEventId = stringValue(next.surfaceExecutionEventV1.eventId);
          const terminal = strippedEvents.find((event) => event.eventId === projectedEventId);
          if (terminal) next.surfaceExecutionEventV1 = terminal;
        }
      }
      const rejectedResult = {
        ...input.result,
        metadata: {
          ...next,
          surfaceProofRejectedV1: {
            version: 1,
            code: 'scope_identity_mismatch',
            field: mismatch,
          },
        },
      };
      return canaryDetected
        ? sanitizeBrowserComputerToolResult(input.toolName, {}, rejectedResult)
        : rejectedResult;
    }
    const card = buildCard(input, scope, metadata, this.now());
    const verification = card.inspection.verificationState;
    const withCard = attachCardToEvents({
      ...metadata,
      surfaceEvidenceCardV1: card,
      surfaceProofScopeV1: scope,
      ...(verification === 'rejected' || verification === 'inconclusive'
        ? {
            surfaceProofReverifyV1: {
              version: 1,
              required: true,
              operationId: scope.operationId,
              reason: verification,
              recommendedAction: verification === 'rejected'
                ? 'Re-observe the target and run the failed checklist again before retrying.'
                : 'Inspect a fresh successor observation before deciding whether to retry.',
            },
          }
        : {}),
    }, scope, card);
    const finalizedResult = { ...input.result, metadata: withCard };
    return canaryDetected
      ? sanitizeBrowserComputerToolResult(input.toolName, {}, finalizedResult)
      : finalizedResult;
  }

  attachEvidenceToProjectedEvents(result: ToolExecutionResult): ToolExecutionResult {
    const metadata = result.metadata || {};
    const card = recordValue(metadata.surfaceEvidenceCardV1) as SurfaceEvidenceCardV1 | undefined;
    const scope = recordValue(metadata.surfaceProofScopeV1) as ResolvedSurfaceProofScopeV1 | undefined;
    if (!card || !scope) return result;
    return { ...result, metadata: attachCardToEvents(metadata, scope, card) };
  }
}

export const surfaceProofService = new SurfaceProofService();
