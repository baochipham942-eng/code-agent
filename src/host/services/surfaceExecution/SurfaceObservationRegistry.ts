import crypto from 'crypto';
import type {
  SurfaceElementRefV1,
  SurfaceObservationV1,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import { sameSurfaceTargetV1 } from '../../../shared/contract/surfaceExecution';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import { SurfaceSessionManager } from './SurfaceSessionManager';

interface StoredObservation {
  sessionId: string;
  runId: string;
  agentId: string;
  observation: SurfaceObservationV1;
}

interface SurfaceObservationRegistryOptions {
  now?: () => number;
  createId?: () => string;
  defaultTtlMs?: number;
}

export class SurfaceObservationRegistry {
  private readonly observations = new Map<string, StoredObservation>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly defaultTtlMs: number;

  constructor(
    private readonly sessions: SurfaceSessionManager,
    options: SurfaceObservationRegistryOptions = {},
  ) {
    this.now = options.now || Date.now;
    this.createId = options.createId || (() => `surface_state_${crypto.randomUUID()}`);
    this.defaultTtlMs = options.defaultTtlMs || 30_000;
  }

  register(input: {
    subject: SurfaceGrantSubjectV1;
    target: SurfaceTargetRefV1;
    providerGeneration: string;
    /** Preserve a provider's public state id when adapting an existing stateful contract. */
    stateId?: string;
    elementRefs?: SurfaceElementRefV1[];
    evidenceAssetIds?: string[];
    redactionStatus?: SurfaceObservationV1['redactionStatus'];
    ttlMs?: number;
  }): SurfaceObservationV1 {
    const session = this.sessions.requireOwned(input.subject.sessionId, input.subject);
    if (session.surface !== input.target.kind) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_TARGET_REVISION_CHANGED', 'Observation target kind does not match the Surface session.', input.target);
    }
    if (!input.providerGeneration.trim()) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_STATE_STALE', 'Provider generation is required for every observation.', input.target);
    }
    if (input.ttlMs !== undefined && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_STATE_STALE', 'Observation TTL must be a positive finite duration.', input.target);
    }
    if (input.redactionStatus === 'blocked') {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_STATE_STALE', 'Blocked evidence cannot create a fresh observation.', input.target);
    }
    this.assertElementRefsMatchTarget(input.elementRefs || [], input.target, session.provider, input.subject.sessionId);
    const stateId = input.stateId?.trim() || this.createId();
    if (this.observations.has(stateId)) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_STATE_STALE', 'Observation state id already exists.', input.target);
    }
    this.invalidateSession(input.subject, 'superseded');
    const now = this.now();
    const elementRefs = (input.elementRefs || []).map((element) => ({
      ...structuredClone(element),
      stateId,
    }));
    const observation: SurfaceObservationV1 = {
      version: 1,
      stateId,
      target: structuredClone(input.target),
      providerGeneration: input.providerGeneration,
      observedAt: now,
      expiresAt: now + Math.max(1, input.ttlMs || this.defaultTtlMs),
      elementRefs,
      evidenceAssetIds: Array.from(new Set(input.evidenceAssetIds || [])),
      redactionStatus: input.redactionStatus || 'clean',
      lifecycle: 'fresh',
    };
    this.observations.set(stateId, {
      sessionId: input.subject.sessionId,
      runId: input.subject.runId,
      agentId: input.subject.agentId,
      observation,
    });
    this.sessions.setActiveTarget(input.subject.sessionId, input.subject, input.target);
    return structuredClone(observation);
  }

  requireFresh(input: {
    stateId: string;
    subject: SurfaceGrantSubjectV1;
    target: SurfaceTargetRefV1;
    providerGeneration: string;
  }): SurfaceObservationV1 {
    const session = this.sessions.requireOwned(input.subject.sessionId, input.subject);
    const stored = this.observations.get(input.stateId);
    const ownerMismatch = stored?.sessionId !== input.subject.sessionId
      || stored?.runId !== input.subject.runId
      || stored?.agentId !== input.subject.agentId;
    if (ownerMismatch) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_STATE_STALE', 'Observation is missing or owned by another subject.', input.target);
    }
    const observation = (stored as StoredObservation).observation;
    if (observation.lifecycle !== 'fresh' || observation.expiresAt <= this.now()) {
      if (observation.expiresAt <= this.now()) observation.lifecycle = 'expired';
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_STATE_STALE', 'Observation is consumed, superseded, or expired.', input.target);
    }
    if (!sameSurfaceTargetV1(observation.target, input.target)) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_TARGET_REVISION_CHANGED', 'Target revision changed after the observation.', input.target);
    }
    if (!input.providerGeneration.trim() || observation.providerGeneration !== input.providerGeneration) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_STATE_STALE', 'Provider generation changed after the observation.', input.target);
    }
    return structuredClone(observation);
  }

  consume(input: {
    stateId: string;
    subject: SurfaceGrantSubjectV1;
    target: SurfaceTargetRefV1;
    providerGeneration: string;
  }): SurfaceObservationV1 {
    this.requireFresh(input);
    const stored = this.observations.get(input.stateId) as StoredObservation;
    stored.observation.lifecycle = 'consumed';
    stored.observation.consumedAt = this.now();
    return structuredClone(stored.observation);
  }

  invalidateSession(
    subject: SurfaceGrantSubjectV1,
    lifecycle: 'superseded' | 'expired' = 'superseded',
  ): void {
    this.sessions.requireOwned(subject.sessionId, subject);
    for (const stored of this.observations.values()) {
      if (stored.sessionId === subject.sessionId
        && stored.runId === subject.runId
        && stored.agentId === subject.agentId
        && stored.observation.lifecycle === 'fresh') {
        stored.observation.lifecycle = lifecycle;
      }
    }
  }

  getOwned(stateId: string, subject: SurfaceGrantSubjectV1): SurfaceObservationV1 | null {
    this.sessions.requireOwned(subject.sessionId, subject);
    const stored = this.observations.get(stateId);
    return stored?.sessionId === subject.sessionId
      && stored?.runId === subject.runId
      && stored?.agentId === subject.agentId
      ? structuredClone(stored.observation)
      : null;
  }

  private assertElementRefsMatchTarget(
    refs: SurfaceElementRefV1[],
    target: SurfaceTargetRefV1,
    provider: string,
    sessionId: string,
  ): void {
    for (const ref of refs) {
      const matches = target.kind === 'browser' && ref.kind === 'browser-element'
        ? ref.tabRef === target.tabRef && ref.documentRevision === target.documentRevision
        : target.kind === 'computer' && ref.kind === 'computer-element'
          ? ref.windowRef === target.windowRef && ref.windowRevision === target.windowRevision
          : false;
      if (!matches) {
        throw this.error(sessionId, target.kind, provider, 'SURFACE_TARGET_REVISION_CHANGED', 'Element reference does not match the observation target revision.', target);
      }
    }
  }

  private error(
    sessionId: string,
    surface: 'browser' | 'computer',
    provider: string,
    code: 'SURFACE_STATE_STALE' | 'SURFACE_TARGET_REVISION_CHANGED',
    message: string,
    targetRef: SurfaceTargetRefV1,
  ): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code,
      message,
      phase: 'observe',
      retryable: true,
      recommendedAction: 'Capture a fresh observation before the next mutation.',
      surface,
      provider,
      sessionId,
      targetRef,
    });
  }
}
