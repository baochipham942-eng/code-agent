import type { Message, ToolResult } from '../../../shared/contract';
import type {
  SurfaceConversationSnapshotV1,
  SurfaceExecutionEventV1,
  SurfaceEvidenceCardV1,
  SurfaceFramePayloadV1,
  SurfaceFrameRequestV1,
  SurfaceOutputPayloadV1,
  SurfaceOutputRefV1,
  SurfaceOutputRequestV1,
  SurfaceSessionControlRequestV1,
  SurfaceSessionControlResultV1,
  SurfaceSessionProjectionV1,
  SurfaceSessionViewV1,
} from '../../../shared/contract/surfaceExecution';
import {
  isSurfaceConversationSnapshotV1,
  isSurfaceExecutionEventV1,
  isSurfaceSessionViewV1,
} from '../../../shared/contract/surfaceExecution';
import {
  parseSurfaceExecutionExportProjectionV1,
  type SurfaceExecutionExportEvidenceV1,
  type SurfaceExecutionExportEventV1,
  type SurfaceExecutionExportSessionV1,
} from '../../../shared/utils/surfaceExecutionExportProjection';
import { redactSurfaceExecutionValue, sanitizeSurfaceExecutionEventV1 } from '../../../shared/utils/surfaceExecutionRedaction';
import { getSessionManager, type SessionWithMessages } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import {
  getSurfaceExecutionRuntime,
  type SurfaceExecutionRuntime,
} from './SurfaceExecutionRuntime';
import {
  getSurfaceContinuationService,
  type SurfaceContinuationService,
} from './SurfaceContinuationService';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';

export const SURFACE_EXECUTION_LEDGER_METADATA_KEY = 'surfaceExecutionLedgerV1';

const MAX_PERSISTED_SESSIONS = 50;
const MAX_PERSISTED_EVENTS_PER_SESSION = 500;

const logger = createLogger('SurfaceConversationProjection');

interface SurfaceProjectionSessionStore {
  getSession(
    conversationId: string,
    messageLimit?: number,
  ): Promise<SessionWithMessages | null>;
  patchSessionMetadata(
    conversationId: string,
    patch: Record<string, unknown>,
    options?: { updatedAt?: number },
  ): Promise<boolean>;
}

interface SurfaceProjectionRuntime {
  snapshotConversation(conversationId: string): SurfaceConversationSnapshotV1;
  frames: {
    resolve(request: SurfaceFrameRequestV1): Promise<SurfaceFramePayloadV1>;
  };
  outputs?: {
    resolve(request: SurfaceOutputRequestV1): Promise<SurfaceOutputPayloadV1>;
  };
  controlConversation(input: {
    conversationId: string;
    surfaceSessionId: string;
    action: SurfaceSessionControlRequestV1['action'];
    reason?: string;
  }): Promise<SurfaceSessionControlResultV1>;
  subscribeEvents(observer: (event: SurfaceExecutionEventV1) => void): () => void;
}

export interface SurfaceConversationProjectionServiceOptions {
  runtime?: SurfaceProjectionRuntime;
  sessionStore?: SurfaceProjectionSessionStore;
  continuations?: SurfaceContinuationService;
  now?: () => number;
  persistEvents?: boolean;
}

interface ExtractedProjectionGroup {
  mode: 'persisted' | 'compat';
  session?: SurfaceSessionViewV1;
  events: SurfaceExecutionEventV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueBy<T>(values: readonly T[], keyFor: (value: T) => string): T[] {
  const deduped = new Map<string, T>();
  for (const value of values) deduped.set(keyFor(value), value);
  return Array.from(deduped.values());
}

function compareEvents(left: SurfaceExecutionEventV1, right: SurfaceExecutionEventV1): number {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  if (left.startedAt !== right.startedAt) return left.startedAt - right.startedAt;
  return left.eventId.localeCompare(right.eventId);
}

function mergeEvents(
  ...eventSets: ReadonlyArray<readonly SurfaceExecutionEventV1[]>
): SurfaceExecutionEventV1[] {
  return uniqueBy(eventSets.flat(), (event) => event.eventId).sort(compareEvents);
}

function safeSessionView(
  value: unknown,
  conversationId: string,
): SurfaceSessionViewV1 | null {
  if (!isRecord(value)) return null;
  const { grantId: _grantId, ...withoutGrant } = value;
  void _grantId;
  const sanitized = redactSurfaceExecutionValue(withoutGrant);
  return isSurfaceSessionViewV1(sanitized)
    && sanitized.conversationId === conversationId
    ? structuredClone(sanitized)
    : null;
}

function safeEvent(
  value: unknown,
  conversationId: string,
): SurfaceExecutionEventV1 | null {
  if (!isSurfaceExecutionEventV1(value)) return null;
  if (value.conversationId && value.conversationId !== conversationId) return null;
  return sanitizeSurfaceExecutionEventV1({
    ...value,
    conversationId,
  });
}

function archiveEvidenceFromExport(
  evidence: SurfaceExecutionExportEvidenceV1,
): SurfaceEvidenceCardV1 {
  return {
    version: 1,
    evidenceId: evidence.evidenceId,
    kind: evidence.kind,
    source: evidence.source,
    title: evidence.title,
    ...(evidence.summary ? { summary: evidence.summary } : {}),
    capturedAt: evidence.capturedAt,
    ...(evidence.captureContext
      ? { captureContext: structuredClone(evidence.captureContext) }
      : {}),
    redactionStatus: evidence.redactionStatus,
    inspection: {
      captureState: evidence.captureState,
      analysisState: evidence.analysisState,
      verificationState: evidence.verificationState,
      ...(evidence.inspectedBy ? { inspectedBy: { ...evidence.inspectedBy } } : {}),
      ...(evidence.inspectedAt !== undefined ? { inspectedAt: evidence.inspectedAt } : {}),
      supportsStepIds: [...evidence.supportsStepIds],
      checklist: evidence.checklist.map((item) => ({ ...item })),
      ...(evidence.beforeEvidenceRef
        ? { beforeEvidenceRef: evidence.beforeEvidenceRef }
        : {}),
      ...(evidence.afterEvidenceRef
        ? { afterEvidenceRef: evidence.afterEvidenceRef }
        : {}),
    },
  };
}

function archiveEventFromExport(input: {
  conversationId: string;
  archiveSessionId: string;
  archiveRunId: string;
  session: SurfaceExecutionExportSessionV1;
  event: SurfaceExecutionExportEventV1;
}): SurfaceExecutionEventV1 {
  return {
    version: 1,
    eventId: `${input.archiveSessionId}:${input.event.eventId}`,
    sequence: input.event.sequence,
    sessionId: input.archiveSessionId,
    conversationId: input.conversationId,
    runId: input.archiveRunId,
    ...(input.event.turnId ? { turnId: input.event.turnId } : {}),
    agentId: 'surface-archive-import',
    surface: input.session.surface,
    ...(input.event.provider || input.session.provider
      ? { provider: input.event.provider || input.session.provider }
      : {}),
    ...(input.event.sessionState ? { sessionState: input.event.sessionState } : {}),
    phase: input.event.phase,
    status: input.event.status,
    userSummary: input.event.userSummary,
    ...(input.event.operation ? { operation: { ...input.event.operation } } : {}),
    ...(input.event.observation
      ? {
          observation: {
            ...input.event.observation,
            findings: [...input.event.observation.findings],
          },
        }
      : {}),
    evidenceRefs: [...input.event.evidenceRefs],
    evidence: input.event.evidence.map(archiveEvidenceFromExport),
    artifactRefs: [...input.event.artifactRefs],
    availableControls: [],
    startedAt: input.event.startedAt,
    ...(input.event.completedAt !== undefined ? { completedAt: input.event.completedAt } : {}),
  };
}

function archiveProjectionsFromExport(
  value: unknown,
  conversationId: string,
  now: number,
): SurfaceSessionProjectionV1[] {
  const projection = parseSurfaceExecutionExportProjectionV1(value);
  if (!projection) return [];
  return projection.sessions.slice(0, MAX_PERSISTED_SESSIONS).map((session, index) => {
    const archiveSessionId = `surface-archive-${index + 1}:${session.sessionId}`.slice(0, 240);
    const archiveRunId = `surface-archive-run:${conversationId}`.slice(0, 240);
    const events = session.events.map((event) => archiveEventFromExport({
      conversationId,
      archiveSessionId,
      archiveRunId,
      session,
      event,
    }));
    const evidence = evidenceFromEvents(events);
    const outputs = outputsFromEvents(events);
    const firstTimestamp = events[0]?.startedAt;
    const lastTimestamp = events.at(-1)?.completedAt || events.at(-1)?.startedAt;
    const startedAt = session.startedAt ?? firstTimestamp ?? now;
    const heartbeatAt = Math.max(session.heartbeatAt ?? 0, lastTimestamp ?? 0, startedAt);
    const provider = session.provider || 'surface-archive';
    return {
      version: 1,
      session: {
        version: 1,
        sessionId: archiveSessionId,
        runId: archiveRunId,
        conversationId,
        agentId: 'surface-archive-import',
        surface: session.surface,
        provider,
        capabilities: {
          version: 1,
          surface: session.surface,
          provider,
          protocolVersion: 'surface-execution-v1+archive-export',
          operations: uniqueBy(
            events.flatMap((event) => event.operation?.action ? [event.operation.action] : []),
            (operation) => operation,
          ),
          observationKinds: [],
          supports: {
            cancel: false,
            pause: false,
            takeover: false,
            cleanup: false,
            successorObservation: false,
          },
        },
        state: session.state === 'failed' ? 'failed' : 'completed',
        startedAt,
        heartbeatAt,
      },
      grant: { state: 'none', capabilities: [], actionClasses: [], dataScopes: [] },
      events,
      evidence,
      outputs,
      availableControls: [],
      source: 'compat',
      writable: false,
      updatedAt: heartbeatAt,
    };
  });
}

function stateFromEvents(events: readonly SurfaceExecutionEventV1[]): SurfaceSessionViewV1['state'] {
  const last = events.at(-1);
  if (last?.sessionState) return last.sessionState;
  if (last?.status === 'failed') return 'failed';
  if (last?.phase === 'cleanup' && (last.status === 'succeeded' || last.status === 'cancelled')) {
    return 'completed';
  }
  if (last?.status === 'waiting') return last.phase === 'human' ? 'waiting_human' : 'waiting_permission';
  return 'running';
}

function synthesizeSession(
  conversationId: string,
  events: readonly SurfaceExecutionEventV1[],
): SurfaceSessionViewV1 {
  const first = events[0];
  const last = events.at(-1) as SurfaceExecutionEventV1;
  const provider = last.provider || first.provider || 'legacy';
  const evidenceKinds = uniqueBy(
    events.flatMap((event) => event.evidence || []).map((evidence) => evidence.kind),
    (kind) => kind,
  );
  const observationKinds = evidenceKinds.filter((kind) => [
    'dom',
    'a11y',
    'ax',
    'screenshot',
    'window',
    'network',
    'console',
  ].includes(kind)) as SurfaceSessionViewV1['capabilities']['observationKinds'];
  return {
    version: 1,
    sessionId: first.sessionId,
    runId: first.runId,
    ...(first.turnId ? { turnId: first.turnId } : {}),
    conversationId,
    agentId: first.agentId,
    surface: first.surface,
    provider,
    capabilities: {
      version: 1,
      surface: first.surface,
      provider,
      protocolVersion: 'surface-execution-v1+compatibility',
      operations: uniqueBy(
        events.flatMap((event) => event.operation?.action ? [event.operation.action] : []),
        (operation) => operation,
      ),
      observationKinds,
      supports: {
        cancel: false,
        pause: false,
        takeover: false,
        cleanup: false,
        successorObservation: false,
      },
    },
    state: stateFromEvents(events),
    ...(last.target ? { activeTarget: last.target } : {}),
    startedAt: Math.min(...events.map((event) => event.startedAt)),
    heartbeatAt: Math.max(...events.map((event) => event.heartbeatAt || event.completedAt || event.startedAt)),
  };
}

function outputsFromEvents(events: readonly SurfaceExecutionEventV1[]): SurfaceOutputRefV1[] {
  const refs = uniqueBy(events.flatMap((event) => event.artifactRefs), (ref) => ref);
  return refs.map((ref, index) => ({
    ref,
    kind: 'artifact',
    label: `Output ${index + 1}`,
  }));
}

function evidenceFromEvents(events: readonly SurfaceExecutionEventV1[]): SurfaceEvidenceCardV1[] {
  return uniqueBy(
    events.flatMap((event) => event.evidence || []),
    (evidence) => evidence.evidenceId,
  ).sort((left, right) => left.capturedAt - right.capturedAt);
}

function projectionFromGroup(
  conversationId: string,
  group: ExtractedProjectionGroup,
): SurfaceSessionProjectionV1 | null {
  const events = mergeEvents(group.events);
  if (events.length === 0 && !group.session) return null;
  const session = group.session || synthesizeSession(conversationId, events);
  const updatedAt = Math.max(
    session.heartbeatAt,
    ...events.map((event) => event.completedAt || event.startedAt),
  );
  return {
    version: 1,
    session,
    grant: { state: 'none', capabilities: [], actionClasses: [], dataScopes: [] },
    events,
    evidence: evidenceFromEvents(events),
    outputs: outputsFromEvents(events),
    availableControls: group.mode === 'persisted' ? ['continue'] : [],
    source: group.mode,
    writable: false,
    updatedAt,
  };
}

function projectionRank(source: SurfaceSessionProjectionV1['source']): number {
  if (source === 'live') return 3;
  if (source === 'persisted') return 2;
  return 1;
}

function sanitizedConversationSnapshot(
  value: unknown,
  conversationId: string,
): SurfaceConversationSnapshotV1 | null {
  if (!isSurfaceConversationSnapshotV1(value)
    || value.conversationId !== conversationId) return null;
  const sessions = value.sessions
    .slice(0, MAX_PERSISTED_SESSIONS)
    .map((projection) => redactSurfaceExecutionValue(projection))
    .filter((projection): projection is SurfaceSessionProjectionV1 => (
      Boolean(projection)
      && typeof projection === 'object'
      && isSurfaceConversationSnapshotV1({
        version: 1,
        conversationId,
        sessions: [projection],
        updatedAt: value.updatedAt,
      })
    ));
  if (sessions.length !== Math.min(value.sessions.length, MAX_PERSISTED_SESSIONS)) return null;
  return {
    version: 1,
    conversationId,
    sessions,
    updatedAt: value.updatedAt,
  };
}

function mergeProjection(
  current: SurfaceSessionProjectionV1 | undefined,
  incoming: SurfaceSessionProjectionV1,
): SurfaceSessionProjectionV1 {
  if (!current) return structuredClone(incoming);
  const incomingWins = projectionRank(incoming.source) >= projectionRank(current.source);
  const authoritative = incomingWins ? incoming : current;
  const events = mergeEvents(current.events, incoming.events);
  const evidence = uniqueBy(
    [...current.evidence, ...incoming.evidence, ...evidenceFromEvents(events)],
    (item) => item.evidenceId,
  ).sort((left, right) => left.capturedAt - right.capturedAt);
  const secondary = authoritative === incoming ? current : incoming;
  const outputs = uniqueBy(
    [...outputsFromEvents(events), ...secondary.outputs, ...authoritative.outputs],
    (item) => item.ref,
  );
  return {
    ...structuredClone(authoritative),
    events,
    evidence,
    outputs,
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
  };
}

function normalizePersistedSnapshot(
  value: unknown,
  conversationId: string,
): SurfaceConversationSnapshotV1 | null {
  const sanitized = sanitizedConversationSnapshot(value, conversationId);
  if (!sanitized) return null;
  return {
    ...structuredClone(sanitized),
    sessions: sanitized.sessions.map((projection) => ({
      ...projection,
      grant: projection.grant.state === 'active'
        ? { ...projection.grant, state: 'revoked' }
        : projection.grant,
      source: projection.source === 'compat' ? 'compat' : 'persisted',
      writable: false,
      availableControls: projection.source === 'compat' ? [] : ['continue'],
    })),
  };
}

function normalizeLiveSnapshot(
  value: unknown,
  conversationId: string,
): SurfaceConversationSnapshotV1 | null {
  const sanitized = sanitizedConversationSnapshot(value, conversationId);
  return sanitized ? structuredClone(sanitized) : null;
}

function resultCandidates(message: Message): ToolResult[] {
  return [
    ...(message.toolResults || []),
    ...(message.toolCalls || []).flatMap((toolCall) => toolCall.result ? [toolCall.result] : []),
  ];
}

function projectionsFromMessages(
  conversationId: string,
  messages: readonly Message[],
): SurfaceSessionProjectionV1[] {
  const groups = new Map<string, ExtractedProjectionGroup>();
  for (const message of messages) {
    if (message.visibility === 'rewound') continue;
    for (const result of resultCandidates(message)) {
      const metadata = isRecord(result.metadata) ? result.metadata : null;
      if (!metadata) continue;
      const mode: ExtractedProjectionGroup['mode'] = metadata.surfaceProjectionMode === 'compatibility'
        ? 'compat'
        : 'persisted';
      const session = safeSessionView(metadata.surfaceExecutionSessionV1, conversationId);
      if (session) {
        const existing = groups.get(session.sessionId) || { mode, events: [] };
        groups.set(session.sessionId, {
          ...existing,
          mode: existing.mode === 'persisted' || mode === 'persisted' ? 'persisted' : 'compat',
          session,
        });
      }
      const candidates: unknown[] = [];
      if (Array.isArray(metadata.surfaceExecutionEventsV1)) {
        for (const candidate of metadata.surfaceExecutionEventsV1) candidates.push(candidate);
      }
      candidates.push(metadata.surfaceExecutionEventV1);
      for (const candidate of candidates) {
        const event = safeEvent(candidate, conversationId);
        if (!event) continue;
        const existing = groups.get(event.sessionId) || { mode, events: [] };
        groups.set(event.sessionId, {
          ...existing,
          mode: existing.mode === 'persisted' || mode === 'persisted' ? 'persisted' : 'compat',
          events: mergeEvents(existing.events, [event]),
        });
      }
    }
  }
  return Array.from(groups.values())
    .map((group) => projectionFromGroup(conversationId, group))
    .filter((projection): projection is SurfaceSessionProjectionV1 => Boolean(projection));
}

function rewoundTurnIds(messages: readonly Message[]): ReadonlySet<string> {
  return new Set(
    messages
      .filter((message) => message.visibility === 'rewound')
      .map((message) => message.id),
  );
}

function mergeConversationSnapshot(input: {
  conversationId: string;
  persisted?: SurfaceConversationSnapshotV1 | null;
  messageProjections?: readonly SurfaceSessionProjectionV1[];
  live?: SurfaceConversationSnapshotV1 | null;
  rewoundTurns?: ReadonlySet<string>;
  now: number;
}): SurfaceConversationSnapshotV1 {
  const projections = new Map<string, SurfaceSessionProjectionV1>();
  const add = (projection: SurfaceSessionProjectionV1): void => {
    if (projection.session.conversationId !== input.conversationId) return;
    if (projection.session.turnId && input.rewoundTurns?.has(projection.session.turnId)) return;
    projections.set(
      projection.session.sessionId,
      mergeProjection(projections.get(projection.session.sessionId), projection),
    );
  };
  input.persisted?.sessions.forEach(add);
  input.messageProjections?.forEach(add);
  input.live?.sessions.forEach(add);
  const sessions = Array.from(projections.values())
    .sort((left, right) => left.session.startedAt - right.session.startedAt);
  return {
    version: 1,
    conversationId: input.conversationId,
    sessions,
    updatedAt: sessions.length > 0
      ? Math.max(...sessions.map((session) => session.updatedAt))
      : input.now,
  };
}

function persistedCopy(
  snapshot: SurfaceConversationSnapshotV1,
  now: number,
): SurfaceConversationSnapshotV1 {
  const sessions = snapshot.sessions
    .map((projection): SurfaceSessionProjectionV1 => ({
      ...structuredClone(projection),
      grant: projection.grant.state === 'active'
        ? {
            ...projection.grant,
            state: projection.grant.expiresAt !== undefined && projection.grant.expiresAt <= now
              ? 'expired'
              : 'revoked',
          }
        : structuredClone(projection.grant),
      events: projection.events.slice(-MAX_PERSISTED_EVENTS_PER_SESSION),
      source: projection.source === 'compat' ? 'compat' : 'persisted',
      writable: false,
      availableControls: projection.source === 'compat' ? [] : ['continue'],
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_PERSISTED_SESSIONS)
    .sort((left, right) => left.session.startedAt - right.session.startedAt);
  return {
    version: 1,
    conversationId: snapshot.conversationId,
    sessions,
    updatedAt: snapshot.updatedAt,
  };
}

export class SurfaceConversationProjectionService {
  private readonly runtime: SurfaceProjectionRuntime;
  private readonly sessionStore: SurfaceProjectionSessionStore;
  private readonly continuations: SurfaceContinuationService;
  private readonly now: () => number;
  private readonly persistenceQueues = new Map<string, Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(options: SurfaceConversationProjectionServiceOptions = {}) {
    this.runtime = options.runtime || getSurfaceExecutionRuntime();
    this.sessionStore = options.sessionStore || getSessionManager();
    this.continuations = options.continuations || getSurfaceContinuationService();
    this.now = options.now || Date.now;
    this.unsubscribe = options.persistEvents === false
      ? () => undefined
      : this.runtime.subscribeEvents((event) => this.enqueuePersistence(event));
  }

  async getSnapshot(conversationId: string): Promise<SurfaceConversationSnapshotV1> {
    const session = await this.requireOwnedConversation(conversationId);
    const persisted = normalizePersistedSnapshot(
      session.metadata?.[SURFACE_EXECUTION_LEDGER_METADATA_KEY],
      conversationId,
    );
    const messageProjections = projectionsFromMessages(conversationId, session.messages);
    const archiveProjections = archiveProjectionsFromExport(
      session.metadata?.surfaceExecutionExportV1,
      conversationId,
      this.now(),
    );
    const live = normalizeLiveSnapshot(
      this.runtime.snapshotConversation(conversationId),
      conversationId,
    );
    const snapshot = mergeConversationSnapshot({
      conversationId,
      persisted,
      messageProjections: [...messageProjections, ...archiveProjections],
      live,
      rewoundTurns: rewoundTurnIds(session.messages),
      now: this.now(),
    });
    return {
      ...snapshot,
      sessions: snapshot.sessions.map((projection) => {
        const pending = this.continuations.peek(
          projection.session.conversationId,
          projection.session.agentId,
        );
        if (pending?.parentSessionId !== projection.session.sessionId) return projection;
        return { ...projection, availableControls: [] };
      }),
    };
  }

  async control(
    input: SurfaceSessionControlRequestV1,
  ): Promise<SurfaceSessionControlResultV1> {
    await this.requireOwnedConversation(input.conversationId);
    if (input.action === 'continue') {
      const snapshot = await this.getSnapshot(input.conversationId);
      const projection = snapshot.sessions.find((candidate) => (
        candidate.session.sessionId === input.surfaceSessionId
      ));
      if (projection?.source !== 'persisted'
        || projection.writable
        || !projection.availableControls.includes('continue')) {
        throw this.controlError(input, projection);
      }
      const intent = this.continuations.prepare({
        conversationId: input.conversationId,
        parentSessionId: projection.session.sessionId,
        agentId: projection.session.agentId,
      });
      return {
        version: 1,
        requestId: intent.requestId,
        snapshot: await this.getSnapshot(input.conversationId),
      };
    }
    const controlled = await this.runtime.controlConversation(input);
    return {
      version: 1,
      ...(controlled.requestId ? { requestId: controlled.requestId } : {}),
      snapshot: await this.getSnapshot(input.conversationId),
    };
  }

  async getFrame(input: SurfaceFrameRequestV1): Promise<SurfaceFramePayloadV1> {
    await this.requireOwnedConversation(input.conversationId);
    const live = normalizeLiveSnapshot(
      this.runtime.snapshotConversation(input.conversationId),
      input.conversationId,
    );
    const projection = live?.sessions.find((candidate) => (
      candidate.session.sessionId === input.surfaceSessionId
    ));
    const authorized = projection?.source === 'live'
      && projection.evidence.some((evidence) => (
        evidence.kind === 'screenshot'
        && evidence.assetRef === input.assetRef
        && evidence.redactionStatus === 'clean'
        && evidence.inspection.captureState === 'captured'
      ));
    if (!authorized) {
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_TARGET_NOT_OWNED',
        message: 'Surface frame is unavailable for this conversation session.',
        phase: 'observe',
        recommendedAction: 'Refresh the live Surface snapshot before requesting the frame.',
        surface: projection?.session.surface || 'browser',
        provider: projection?.session.provider || 'surface-runtime',
        sessionId: input.surfaceSessionId,
      });
    }
    return this.runtime.frames.resolve(input);
  }

  async getOutput(input: SurfaceOutputRequestV1): Promise<SurfaceOutputPayloadV1> {
    await this.requireOwnedConversation(input.conversationId);
    const live = normalizeLiveSnapshot(
      this.runtime.snapshotConversation(input.conversationId),
      input.conversationId,
    );
    const projection = live?.sessions.find((candidate) => (
      candidate.session.sessionId === input.surfaceSessionId
    ));
    const authorized = projection?.source === 'live'
      && projection.outputs.some((output) => output.ref === input.outputRef);
    if (!authorized || !this.runtime.outputs) {
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_TARGET_NOT_OWNED',
        message: 'Surface output is unavailable for this conversation session.',
        phase: 'artifact',
        recommendedAction: 'Refresh the live Surface snapshot before requesting the output.',
        surface: projection?.session.surface || 'browser',
        provider: projection?.session.provider || 'surface-runtime',
        sessionId: input.surfaceSessionId,
      });
    }
    return this.runtime.outputs.resolve(input);
  }

  async flushPersistence(conversationId?: string): Promise<void> {
    if (conversationId) {
      await this.persistenceQueues.get(conversationId);
      return;
    }
    await Promise.all(this.persistenceQueues.values());
  }

  dispose(): void {
    this.unsubscribe();
  }

  private async requireOwnedConversation(conversationId: string): Promise<SessionWithMessages> {
    if (!conversationId.trim()) throw this.ownerError(conversationId);
    const session = await this.sessionStore.getSession(conversationId, Number.MAX_SAFE_INTEGER);
    if (!session) throw this.ownerError(conversationId);
    return session;
  }

  private ownerError(conversationId: string): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code: 'SURFACE_TARGET_NOT_OWNED',
      message: 'Surface execution is unavailable for this conversation.',
      phase: 'human',
      recommendedAction: 'Refresh the accessible conversation list.',
      surface: 'browser',
      provider: 'unknown',
      sessionId: conversationId || 'unknown',
    });
  }

  private controlError(
    input: SurfaceSessionControlRequestV1,
    projection?: SurfaceSessionProjectionV1,
  ): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code: 'SURFACE_POLICY_BLOCKED',
      message: 'Surface continuation is unavailable for the current checkpoint.',
      phase: 'recover',
      recommendedAction: 'Refresh the conversation and choose a read-only persisted Surface session.',
      surface: projection?.session.surface || 'browser',
      provider: projection?.session.provider || 'unknown',
      sessionId: input.surfaceSessionId,
    });
  }

  private enqueuePersistence(event: SurfaceExecutionEventV1): void {
    const conversationId = event.conversationId?.trim();
    if (!conversationId) return;
    const previous = this.persistenceQueues.get(conversationId) || Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => this.persistConversation(conversationId))
      .catch((error) => {
        logger.warn('Failed to persist Surface conversation projection', {
          conversationId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    this.persistenceQueues.set(conversationId, queued);
    void queued.finally(() => {
      if (this.persistenceQueues.get(conversationId) === queued) {
        this.persistenceQueues.delete(conversationId);
      }
    });
  }

  private async persistConversation(conversationId: string): Promise<void> {
    const session = await this.requireOwnedConversation(conversationId);
    const existing = normalizePersistedSnapshot(
      session.metadata?.[SURFACE_EXECUTION_LEDGER_METADATA_KEY],
      conversationId,
    );
    const merged = mergeConversationSnapshot({
      conversationId,
      persisted: existing,
      messageProjections: [
        ...projectionsFromMessages(conversationId, session.messages),
        ...archiveProjectionsFromExport(
          session.metadata?.surfaceExecutionExportV1,
          conversationId,
          this.now(),
        ),
      ],
      live: normalizeLiveSnapshot(
        this.runtime.snapshotConversation(conversationId),
        conversationId,
      ),
      rewoundTurns: rewoundTurnIds(session.messages),
      now: this.now(),
    });
    const durable = persistedCopy(merged, this.now());
    await this.sessionStore.patchSessionMetadata(
      conversationId,
      { [SURFACE_EXECUTION_LEDGER_METADATA_KEY]: durable },
      { updatedAt: durable.updatedAt },
    );
  }
}

let surfaceConversationProjectionService: SurfaceConversationProjectionService | null = null;

export function getSurfaceConversationProjectionService(): SurfaceConversationProjectionService {
  surfaceConversationProjectionService ??= new SurfaceConversationProjectionService({
    runtime: getSurfaceExecutionRuntime() as SurfaceExecutionRuntime,
  });
  return surfaceConversationProjectionService;
}

export function resetSurfaceConversationProjectionServiceForTests(): void {
  surfaceConversationProjectionService?.dispose();
  surfaceConversationProjectionService = null;
}
