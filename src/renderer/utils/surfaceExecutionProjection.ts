import type { ToolResult } from '@shared/contract/tool';
import type {
  SurfaceCapabilityManifestV1,
  SurfaceConversationSnapshotV1,
  SurfaceEvidenceCardV1,
  SurfaceEvidenceKindV1,
  SurfaceExecutionControlV1,
  SurfaceExecutionEventV1,
  SurfaceGrantSummaryV1,
  SurfaceOutputRefV1,
  SurfaceSessionProjectionV1,
  SurfaceSessionStateV1,
  SurfaceSessionViewV1,
  SurfaceTargetRefV1,
} from '@shared/contract/surfaceExecution';
import {
  isSurfaceEvidenceCardV1,
  isSurfaceExecutionEventV1,
} from '@shared/contract/surfaceExecution';
import { sanitizeSurfaceExecutionEventV1 } from '@shared/utils/surfaceExecutionRedaction';

export interface SurfaceExecutionScopeV1 {
  conversationId: string;
  runId: string;
  agentId: string;
  surfaceSessionId: string;
}

export interface RendererSurfaceSessionProjectionV1 extends SurfaceSessionProjectionV1 {
  scope: SurfaceExecutionScopeV1;
}

/**
 * The identity on this envelope comes from the containing Agent/IPC event, not
 * from ToolResult metadata. Optional legacy fields are accepted only for
 * persisted messages that predate the outer run/agent/surface identity.
 */
export interface SurfaceExecutionCompatibilityEnvelopeV1 {
  conversationId: string;
  runId?: string;
  agentId?: string;
  surfaceSessionId?: string;
  toolResults: readonly ToolResult[];
}

export interface BuildSurfaceExecutionProjectionInputV1 {
  conversationId: string;
  nativeSnapshot?: unknown;
  compatibility?: readonly SurfaceExecutionCompatibilityEnvelopeV1[];
}

export interface RendererSurfaceConversationProjectionV1 {
  version: 1;
  conversationId: string;
  sessions: RendererSurfaceSessionProjectionV1[];
  mode: 'native' | 'compatibility' | 'empty';
  updatedAt: number;
}

const SURFACE_STATES: readonly SurfaceSessionStateV1[] = [
  'preparing',
  'waiting_permission',
  'running',
  'waiting_human',
  'paused',
  'stopping',
  'completed',
  'failed',
];

const SURFACE_CONTROLS: readonly SurfaceExecutionControlV1[] = [
  'pause',
  'resume',
  'continue',
  'takeover',
  'skip',
  'stop',
  'end_session',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalString(value: unknown): string | undefined {
  return nonEmptyString(value) ? value : undefined;
}

export function surfaceExecutionScopeKeyV1(scope: SurfaceExecutionScopeV1): string {
  return JSON.stringify([
    scope.conversationId,
    scope.runId,
    scope.agentId,
    scope.surfaceSessionId,
  ]);
}

function eventOrder(event: SurfaceExecutionEventV1): readonly number[] {
  return [
    event.sequence,
    event.completedAt ?? Number.NEGATIVE_INFINITY,
    event.heartbeatAt ?? Number.NEGATIVE_INFINITY,
    event.startedAt,
  ];
}

function compareNumberTuple(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Keep the newest representation of an event and then restore semantic order. */
export function sortAndDedupeSurfaceEventsV1(
  events: readonly SurfaceExecutionEventV1[],
): SurfaceExecutionEventV1[] {
  const byId = new Map<string, SurfaceExecutionEventV1>();
  for (const event of events) {
    const existing = byId.get(event.eventId);
    if (!existing || compareNumberTuple(eventOrder(event), eventOrder(existing)) >= 0) {
      byId.set(event.eventId, event);
    }
  }
  return Array.from(byId.values()).sort((left, right) => (
    left.sequence - right.sequence
    || left.startedAt - right.startedAt
    || left.eventId.localeCompare(right.eventId)
  ));
}

function normalizeTarget(value: unknown): SurfaceTargetRefV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.kind === 'browser'
    && nonEmptyString(value.browserInstanceId)
    && nonEmptyString(value.windowRef)
    && nonEmptyString(value.tabRef)
    && nonEmptyString(value.documentRevision)
  ) {
    return {
      kind: 'browser',
      browserInstanceId: value.browserInstanceId,
      windowRef: value.windowRef,
      tabRef: value.tabRef,
      ...(optionalString(value.frameRef) ? { frameRef: optionalString(value.frameRef) } : {}),
      ...(optionalString(value.origin) ? { origin: optionalString(value.origin) } : {}),
      documentRevision: value.documentRevision,
      ...(optionalString(value.title) ? { title: optionalString(value.title) } : {}),
    };
  }
  if (
    value.kind === 'computer'
    && nonEmptyString(value.deviceId)
    && nonEmptyString(value.appName)
    && finiteNumber(value.pid)
    && nonEmptyString(value.windowRef)
    && nonEmptyString(value.windowRevision)
  ) {
    return {
      kind: 'computer',
      deviceId: value.deviceId,
      appName: value.appName,
      ...(optionalString(value.bundleId) ? { bundleId: optionalString(value.bundleId) } : {}),
      pid: value.pid,
      windowRef: value.windowRef,
      ...(optionalString(value.spaceId) ? { spaceId: optionalString(value.spaceId) } : {}),
      windowRevision: value.windowRevision,
      ...(optionalString(value.title) ? { title: optionalString(value.title) } : {}),
    };
  }
  return undefined;
}

function emptyCapabilityManifest(
  surface: SurfaceSessionViewV1['surface'],
  provider: string,
): SurfaceCapabilityManifestV1 {
  return {
    version: 1,
    surface,
    provider,
    protocolVersion: 'compatibility-v1',
    operations: [],
    observationKinds: [],
    supports: {
      cancel: false,
      pause: false,
      takeover: false,
      cleanup: false,
      successorObservation: false,
    },
  };
}

function normalizeCapabilities(
  value: unknown,
  surface: SurfaceSessionViewV1['surface'],
  provider: string,
): SurfaceCapabilityManifestV1 {
  if (!isRecord(value)) return emptyCapabilityManifest(surface, provider);
  const supports = isRecord(value.supports) ? value.supports : {};
  const observationKinds = Array.isArray(value.observationKinds)
    ? value.observationKinds.filter((kind): kind is SurfaceCapabilityManifestV1['observationKinds'][number] => (
      typeof kind === 'string'
      && ['dom', 'a11y', 'ax', 'screenshot', 'window', 'network', 'console'].includes(kind)
    ))
    : [];
  return {
    version: 1,
    surface,
    provider,
    protocolVersion: optionalString(value.protocolVersion) ?? 'compatibility-v1',
    operations: Array.isArray(value.operations)
      ? value.operations.filter((operation): operation is string => typeof operation === 'string')
      : [],
    observationKinds,
    supports: {
      cancel: supports.cancel === true,
      pause: supports.pause === true,
      takeover: supports.takeover === true,
      cleanup: supports.cleanup === true,
      successorObservation: supports.successorObservation === true,
    },
  };
}

function normalizeGrant(value: unknown): SurfaceGrantSummaryV1 {
  if (!isRecord(value)) {
    return { state: 'none', capabilities: [], actionClasses: [], dataScopes: [] };
  }
  const states: SurfaceGrantSummaryV1['state'][] = ['active', 'consumed', 'revoked', 'expired', 'none'];
  const capabilities: SurfaceGrantSummaryV1['capabilities'][number][] = [
    'observe',
    'input',
    'navigate',
    'file',
    'secret',
    'destructive',
  ];
  return {
    state: states.includes(value.state as SurfaceGrantSummaryV1['state'])
      ? value.state as SurfaceGrantSummaryV1['state']
      : 'none',
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.filter((item): item is SurfaceGrantSummaryV1['capabilities'][number] => (
        capabilities.includes(item as SurfaceGrantSummaryV1['capabilities'][number])
      ))
      : [],
    actionClasses: Array.isArray(value.actionClasses)
      ? value.actionClasses.filter((item): item is string => typeof item === 'string')
      : [],
    dataScopes: Array.isArray(value.dataScopes)
      ? value.dataScopes.filter((item): item is string => typeof item === 'string')
      : [],
    ...(finiteNumber(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
  };
}

function normalizeOutput(value: unknown): SurfaceOutputRefV1 | null {
  if (!isRecord(value) || !nonEmptyString(value.ref) || !nonEmptyString(value.label)) return null;
  if (!['artifact', 'file', 'download', 'trace'].includes(String(value.kind))) return null;
  return {
    ref: value.ref,
    kind: value.kind as SurfaceOutputRefV1['kind'],
    label: value.label,
    ...(finiteNumber(value.createdAt) ? { createdAt: value.createdAt } : {}),
  };
}

function mergeOutputs(
  outputs: readonly SurfaceOutputRefV1[],
  events: readonly SurfaceExecutionEventV1[],
): SurfaceOutputRefV1[] {
  const byRef = new Map<string, SurfaceOutputRefV1>();
  for (const output of outputs) byRef.set(output.ref, output);
  for (const event of events) {
    for (const ref of event.artifactRefs) {
      if (!byRef.has(ref)) {
        const label = ref.split(/[\\/]/).filter(Boolean).at(-1) || 'Surface output';
        byRef.set(ref, {
          ref,
          kind: 'artifact',
          label,
          createdAt: event.completedAt ?? event.startedAt,
        });
      }
    }
  }
  return Array.from(byRef.values()).sort((left, right) => (
    (left.createdAt ?? 0) - (right.createdAt ?? 0) || left.ref.localeCompare(right.ref)
  ));
}

function mergeEvidenceCards(cards: readonly SurfaceEvidenceCardV1[]): SurfaceEvidenceCardV1[] {
  const byId = new Map<string, SurfaceEvidenceCardV1>();
  for (const card of cards) {
    const existing = byId.get(card.evidenceId);
    const existingAt = existing?.inspection.inspectedAt ?? existing?.capturedAt ?? Number.NEGATIVE_INFINITY;
    const candidateAt = card.inspection.inspectedAt ?? card.capturedAt;
    if (!existing || candidateAt >= existingAt) byId.set(card.evidenceId, card);
  }
  return Array.from(byId.values()).sort((left, right) => (
    left.capturedAt - right.capturedAt || left.evidenceId.localeCompare(right.evidenceId)
  ));
}

function scopeMatchesEvent(
  event: SurfaceExecutionEventV1,
  scope: SurfaceExecutionScopeV1,
): boolean {
  return event.sessionId === scope.surfaceSessionId
    && event.runId === scope.runId
    && event.agentId === scope.agentId
    && (event.conversationId === undefined || event.conversationId === scope.conversationId);
}

function normalizeEvent(
  value: unknown,
  scope: SurfaceExecutionScopeV1,
  writable: boolean,
): SurfaceExecutionEventV1 | null {
  if (!isSurfaceExecutionEventV1(value) || !scopeMatchesEvent(value, scope)) return null;
  const safe = sanitizeSurfaceExecutionEventV1(value);
  return {
    ...safe,
    conversationId: scope.conversationId,
    availableControls: writable
      ? safe.availableControls.filter((control) => SURFACE_CONTROLS.includes(control))
      : [],
  };
}

function normalizeNativeSession(
  value: unknown,
  conversationId: string,
): RendererSurfaceSessionProjectionV1 | null {
  if (!isRecord(value) || !isRecord(value.session)) return null;
  const rawSession = value.session;
  if (
    rawSession.version !== 1
    || rawSession.conversationId !== conversationId
    || !nonEmptyString(rawSession.sessionId)
    || !nonEmptyString(rawSession.runId)
    || !nonEmptyString(rawSession.agentId)
    || (rawSession.surface !== 'browser' && rawSession.surface !== 'computer')
    || !nonEmptyString(rawSession.provider)
    || !SURFACE_STATES.includes(rawSession.state as SurfaceSessionStateV1)
    || !finiteNumber(rawSession.startedAt)
    || !finiteNumber(rawSession.heartbeatAt)
  ) return null;

  const scope: SurfaceExecutionScopeV1 = {
    conversationId,
    runId: rawSession.runId,
    agentId: rawSession.agentId,
    surfaceSessionId: rawSession.sessionId,
  };
  const source: SurfaceSessionProjectionV1['source'] = (
    value.source === 'live' || value.source === 'persisted' || value.source === 'compat'
  ) ? value.source : 'persisted';
  const writable = source === 'live' && value.writable === true;
  const events = sortAndDedupeSurfaceEventsV1(
    (Array.isArray(value.events) ? value.events : [])
      .map((event) => normalizeEvent(event, scope, writable))
      .filter((event): event is SurfaceExecutionEventV1 => Boolean(event)),
  );
  const evidence = mergeEvidenceCards([
    ...(Array.isArray(value.evidence) ? value.evidence.filter(isSurfaceEvidenceCardV1) : []),
    ...events.flatMap((event) => event.evidence ?? []),
  ]);
  const outputs = mergeOutputs(
    (Array.isArray(value.outputs) ? value.outputs : [])
      .map(normalizeOutput)
      .filter((output): output is SurfaceOutputRefV1 => Boolean(output)),
    events,
  );
  const provider = rawSession.provider;
  const session: SurfaceSessionViewV1 = {
    version: 1,
    sessionId: rawSession.sessionId,
    runId: rawSession.runId,
    ...(optionalString(rawSession.taskId) ? { taskId: optionalString(rawSession.taskId) } : {}),
    ...(optionalString(rawSession.turnId) ? { turnId: optionalString(rawSession.turnId) } : {}),
    conversationId,
    agentId: rawSession.agentId,
    surface: rawSession.surface,
    provider,
    capabilities: normalizeCapabilities(rawSession.capabilities, rawSession.surface, provider),
    state: rawSession.state as SurfaceSessionStateV1,
    ...(normalizeTarget(rawSession.activeTarget) ? { activeTarget: normalizeTarget(rawSession.activeTarget) } : {}),
    ...(optionalString(rawSession.parentSessionId)
      ? { parentSessionId: optionalString(rawSession.parentSessionId) }
      : {}),
    startedAt: rawSession.startedAt,
    heartbeatAt: rawSession.heartbeatAt,
    ...(finiteNumber(rawSession.expiresAt) ? { expiresAt: rawSession.expiresAt } : {}),
  };
  const controls = Array.isArray(value.availableControls)
    ? value.availableControls.filter((control): control is SurfaceExecutionControlV1 => (
      SURFACE_CONTROLS.includes(control as SurfaceExecutionControlV1)
      && (writable || (source === 'persisted' && control === 'continue'))
    ))
    : [];
  return {
    version: 1,
    scope,
    session,
    grant: normalizeGrant(value.grant),
    events,
    evidence,
    outputs,
    availableControls: Array.from(new Set(controls)),
    source,
    writable,
    updatedAt: finiteNumber(value.updatedAt)
      ? value.updatedAt
      : Math.max(session.heartbeatAt, ...events.map((event) => event.completedAt ?? event.startedAt)),
  };
}

function normalizeNativeSnapshot(
  value: unknown,
  conversationId: string,
): RendererSurfaceSessionProjectionV1[] | null {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.conversationId !== conversationId
    || !Array.isArray(value.sessions)
  ) return null;
  const byScope = new Map<string, RendererSurfaceSessionProjectionV1>();
  for (const candidate of value.sessions) {
    const session = normalizeNativeSession(candidate, conversationId);
    if (!session) continue;
    const key = surfaceExecutionScopeKeyV1(session.scope);
    const existing = byScope.get(key);
    if (!existing || session.updatedAt >= existing.updatedAt) byScope.set(key, session);
  }
  return sortSessions(Array.from(byScope.values()));
}

function sessionStateFromEvents(events: readonly SurfaceExecutionEventV1[]): SurfaceSessionStateV1 {
  const latest = events.at(-1);
  if (!latest) return 'preparing';
  if (latest.sessionState && SURFACE_STATES.includes(latest.sessionState)) return latest.sessionState;
  if (latest.status === 'waiting') return 'waiting_human';
  if (latest.status === 'failed' || latest.status === 'cancelled') return 'failed';
  if (latest.phase === 'cleanup' && latest.status === 'succeeded') return 'completed';
  return 'running';
}

function compatibilitySessionView(
  value: unknown,
  scope: SurfaceExecutionScopeV1,
  events: readonly SurfaceExecutionEventV1[],
): SurfaceSessionViewV1 {
  const latest = events.at(-1);
  const candidate = isRecord(value) ? value : {};
  const surface = candidate.surface === 'browser' || candidate.surface === 'computer'
    ? candidate.surface
    : latest?.surface ?? 'browser';
  const provider = optionalString(candidate.provider) ?? latest?.provider ?? 'compatibility';
  const explicitState = SURFACE_STATES.includes(candidate.state as SurfaceSessionStateV1)
    ? candidate.state as SurfaceSessionStateV1
    : undefined;
  const startedAt = finiteNumber(candidate.startedAt)
    ? candidate.startedAt
    : Math.min(...events.map((event) => event.startedAt));
  const heartbeatAt = finiteNumber(candidate.heartbeatAt)
    ? candidate.heartbeatAt
    : Math.max(...events.map((event) => event.heartbeatAt ?? event.completedAt ?? event.startedAt));
  const target = normalizeTarget(candidate.activeTarget) ?? latest?.target;
  return {
    version: 1,
    sessionId: scope.surfaceSessionId,
    runId: scope.runId,
    ...(optionalString(candidate.taskId) ? { taskId: optionalString(candidate.taskId) } : {}),
    ...(optionalString(candidate.turnId) ? { turnId: optionalString(candidate.turnId) } : {}),
    conversationId: scope.conversationId,
    agentId: scope.agentId,
    surface,
    provider,
    capabilities: normalizeCapabilities(candidate.capabilities, surface, provider),
    state: explicitState ?? sessionStateFromEvents(events),
    ...(target ? { activeTarget: target } : {}),
    ...(optionalString(candidate.parentSessionId)
      ? { parentSessionId: optionalString(candidate.parentSessionId) }
      : {}),
    startedAt,
    heartbeatAt,
    ...(finiteNumber(candidate.expiresAt) ? { expiresAt: candidate.expiresAt } : {}),
  };
}

function evidenceKindFromLegacy(value: unknown): SurfaceEvidenceKindV1 | null {
  const kinds: Record<string, SurfaceEvidenceKindV1> = {
    screenshot: 'screenshot',
    browser_dom: 'dom',
    browser_a11y: 'a11y',
    computer_ax: 'ax',
  };
  return typeof value === 'string' ? kinds[value] ?? null : null;
}

function legacyEvidenceCards(result: ToolResult): SurfaceEvidenceCardV1[] {
  const metadata = isRecord(result.metadata) ? result.metadata : {};
  const proof = isRecord(metadata.browserComputerProof) ? metadata.browserComputerProof : {};
  const legacyCard = isRecord(metadata.browserComputerEvidenceCard)
    ? metadata.browserComputerEvidenceCard
    : {};
  const observation = isRecord(proof.visualObservation) ? proof.visualObservation : {};
  const observed = observation.observed === true;
  const methodBySource: Record<string, 'vision' | 'dom' | 'a11y' | 'ax'> = {
    analysis: 'vision',
    dom: 'dom',
    a11y: 'a11y',
    ax: 'ax',
  };
  const inspectionMethod = typeof observation.source === 'string'
    ? methodBySource[observation.source]
    : undefined;
  const refs = Array.isArray(proof.evidenceRefs) ? proof.evidenceRefs : [];
  return refs.flatMap((value) => {
    if (!isRecord(value) || !nonEmptyString(value.id)) return [];
    const kind = evidenceKindFromLegacy(value.kind);
    if (!kind) return [];
    const freshness = isRecord(value.freshness) ? value.freshness : {};
    const capturedAt = finiteNumber(freshness.capturedAtMs) ? freshness.capturedAtMs : 0;
    const redactionStatus: SurfaceEvidenceCardV1['redactionStatus'] = value.redactionStatus === 'contains_secret_blocked'
      ? 'blocked'
      : value.redactionStatus === 'redacted' ? 'redacted' : 'clean';
    return [{
      version: 1 as const,
      evidenceId: value.id,
      kind,
      source: 'compat' as const,
      title: optionalString(legacyCard.title) ?? 'Browser/Computer evidence',
      ...(optionalString(legacyCard.summary) ? { summary: optionalString(legacyCard.summary) } : {}),
      capturedAt,
      redactionStatus,
      inspection: {
        captureState: 'captured' as const,
        analysisState: observed && inspectionMethod ? 'analyzed' as const : 'not_requested' as const,
        // Legacy success/observed is evidence consumption, never a business verification signal.
        verificationState: 'not_requested' as const,
        ...(observed && inspectionMethod
          ? {
              inspectedBy: {
                kind: 'service' as const,
                id: 'legacy-browser-computer-proof',
                method: inspectionMethod,
              },
              inspectedAt: capturedAt,
            }
          : {}),
        supportsStepIds: [],
        checklist: [],
      },
    }];
  });
}

interface CompatibilityBucket {
  scope: SurfaceExecutionScopeV1;
  events: SurfaceExecutionEventV1[];
  evidence: SurfaceEvidenceCardV1[];
  sessionCandidate?: unknown;
}

function metadataSurfaceEvents(metadata: Record<string, unknown>): unknown[] {
  const events: unknown[] = [];
  if (Array.isArray(metadata.surfaceExecutionEventsV1)) {
    for (const event of metadata.surfaceExecutionEventsV1 as unknown[]) events.push(event);
  }
  if (metadata.surfaceExecutionEventV1 !== undefined) events.push(metadata.surfaceExecutionEventV1);
  return events;
}

function compatibilitySessions(
  conversationId: string,
  envelopes: readonly SurfaceExecutionCompatibilityEnvelopeV1[],
): RendererSurfaceSessionProjectionV1[] {
  const buckets = new Map<string, CompatibilityBucket>();
  for (const envelope of envelopes) {
    if (envelope.conversationId !== conversationId) continue;
    for (const result of envelope.toolResults) {
      const metadata = isRecord(result.metadata) ? result.metadata : {};
      if (nonEmptyString(metadata.conversationId) && metadata.conversationId !== conversationId) continue;
      for (const rawEvent of metadataSurfaceEvents(metadata)) {
        if (!isSurfaceExecutionEventV1(rawEvent)) continue;
        const scope: SurfaceExecutionScopeV1 = {
          conversationId,
          runId: envelope.runId ?? rawEvent.runId,
          agentId: envelope.agentId ?? rawEvent.agentId,
          surfaceSessionId: envelope.surfaceSessionId ?? rawEvent.sessionId,
        };
        if (!scopeMatchesEvent(rawEvent, scope)) continue;
        const event = normalizeEvent(rawEvent, scope, false);
        if (!event) continue;
        const key = surfaceExecutionScopeKeyV1(scope);
        const bucket = buckets.get(key) ?? { scope, events: [], evidence: [] };
        bucket.events.push(event);
        bucket.evidence.push(...legacyEvidenceCards(result), ...(event.evidence ?? []));
        const sessionCandidate = isRecord(metadata.surfaceExecutionSessionV1)
          ? metadata.surfaceExecutionSessionV1
          : undefined;
        if (
          sessionCandidate?.sessionId === scope.surfaceSessionId
          && sessionCandidate.runId === scope.runId
          && sessionCandidate.agentId === scope.agentId
          && sessionCandidate.conversationId === scope.conversationId
        ) bucket.sessionCandidate = sessionCandidate;
        buckets.set(key, bucket);
      }
    }
  }

  const sessions: RendererSurfaceSessionProjectionV1[] = [];
  for (const bucket of buckets.values()) {
    const events = sortAndDedupeSurfaceEventsV1(bucket.events);
    if (events.length === 0) continue;
    const session = compatibilitySessionView(bucket.sessionCandidate, bucket.scope, events);
    sessions.push({
      version: 1,
      scope: bucket.scope,
      session,
      grant: { state: 'none', capabilities: [], actionClasses: [], dataScopes: [] },
      events,
      evidence: mergeEvidenceCards(bucket.evidence),
      outputs: mergeOutputs([], events),
      // Compatibility projections are historical evidence. They never regain authority.
      availableControls: [],
      source: 'compat',
      writable: false,
      updatedAt: Math.max(session.heartbeatAt, ...events.map((event) => event.completedAt ?? event.startedAt)),
    });
  }
  return sortSessions(sessions);
}

function sortSessions(
  sessions: readonly RendererSurfaceSessionProjectionV1[],
): RendererSurfaceSessionProjectionV1[] {
  return [...sessions].sort((left, right) => (
    left.session.startedAt - right.session.startedAt
    || left.scope.runId.localeCompare(right.scope.runId)
    || left.scope.agentId.localeCompare(right.scope.agentId)
    || left.scope.surfaceSessionId.localeCompare(right.scope.surfaceSessionId)
  ));
}

/**
 * Native Host snapshots are authoritative for the whole conversation. Tool
 * metadata is used only when no valid native snapshot is available.
 */
export function buildSurfaceExecutionProjectionV1(
  input: BuildSurfaceExecutionProjectionInputV1,
): RendererSurfaceConversationProjectionV1 {
  const conversationId = input.conversationId.trim();
  const nativeSessions = conversationId
    ? normalizeNativeSnapshot(input.nativeSnapshot, conversationId)
    : null;
  if (nativeSessions) {
    const nativeRecord = input.nativeSnapshot as SurfaceConversationSnapshotV1;
    return {
      version: 1,
      conversationId,
      sessions: nativeSessions,
      mode: 'native',
      updatedAt: finiteNumber(nativeRecord.updatedAt)
        ? nativeRecord.updatedAt
        : Math.max(0, ...nativeSessions.map((session) => session.updatedAt)),
    };
  }

  const sessions = conversationId
    ? compatibilitySessions(conversationId, input.compatibility ?? [])
    : [];
  return {
    version: 1,
    conversationId,
    sessions,
    mode: sessions.length > 0 ? 'compatibility' : 'empty',
    updatedAt: Math.max(0, ...sessions.map((session) => session.updatedAt)),
  };
}
