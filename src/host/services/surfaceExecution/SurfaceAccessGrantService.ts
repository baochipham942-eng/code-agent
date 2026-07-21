import crypto from 'crypto';
import type {
  SurfaceAccessGrantV1,
  SurfaceGrantCapabilityV1,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import { sameSurfaceTargetV1 } from '../../../shared/contract/surfaceExecution';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import type { SurfaceSessionOwnerV1 } from './SurfaceSessionManager';
import { SurfaceSessionManager } from './SurfaceSessionManager';

export interface SurfaceGrantSubjectV1 extends SurfaceSessionOwnerV1 {
  sessionId: string;
}

interface SurfaceAccessGrantServiceOptions {
  now?: () => number;
  createId?: () => string;
  maxTtlMs?: number;
}

export class SurfaceAccessGrantService {
  private readonly grants = new Map<string, SurfaceAccessGrantV1>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxTtlMs: number;

  constructor(
    private readonly sessions: SurfaceSessionManager,
    options: SurfaceAccessGrantServiceOptions = {},
  ) {
    this.now = options.now || Date.now;
    this.createId = options.createId || (() => `surface_grant_${crypto.randomUUID()}`);
    this.maxTtlMs = options.maxTtlMs || 30 * 60_000;
  }

  issue(input: {
    subject: SurfaceGrantSubjectV1;
    target: SurfaceTargetRefV1;
    capabilities: SurfaceGrantCapabilityV1[];
    dataScopes: string[];
    actionClasses: string[];
    ttlMs: number;
    singleUse?: boolean;
  }): SurfaceAccessGrantV1 {
    const session = this.sessions.requireOwned(input.subject.sessionId, input.subject);
    if (session.surface !== input.target.kind) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_APPROVAL_INVALID', 'Grant target kind does not match the Surface session.', input.target);
    }
    if (input.capabilities.length === 0 || input.actionClasses.length === 0) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_APPROVAL_INVALID', 'Grant requires at least one capability and action class.', input.target);
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_APPROVAL_INVALID', 'Grant TTL must be a positive finite duration.', input.target);
    }
    const now = this.now();
    const ttlMs = Math.min(Math.max(input.ttlMs, 1), this.maxTtlMs);
    const grant: SurfaceAccessGrantV1 = {
      version: 1,
      grantId: this.createId(),
      subject: {
        sessionId: input.subject.sessionId,
        runId: input.subject.runId,
        agentId: input.subject.agentId,
      },
      target: structuredClone(input.target),
      capabilities: Array.from(new Set(input.capabilities)),
      dataScopes: Array.from(new Set(input.dataScopes)),
      actionClasses: Array.from(new Set(input.actionClasses)),
      issuedAt: now,
      expiresAt: now + ttlMs,
      ...(input.singleUse ? { singleUse: true } : {}),
    };
    this.grants.set(grant.grantId, grant);
    this.sessions.setActiveTarget(input.subject.sessionId, input.subject, input.target);
    this.sessions.attachGrant(input.subject.sessionId, input.subject, grant.grantId);
    return structuredClone(grant);
  }

  getOwned(grantId: string, subject: SurfaceGrantSubjectV1): SurfaceAccessGrantV1 | null {
    this.sessions.requireOwned(subject.sessionId, subject);
    const grant = this.grants.get(grantId);
    return grant?.subject.sessionId === subject.sessionId
      && grant?.subject.runId === subject.runId
      && grant?.subject.agentId === subject.agentId
      ? structuredClone(grant)
      : null;
  }

  /** Host-only read used for renderer-safe projection after conversation ownership is checked. */
  get(grantId: string): SurfaceAccessGrantV1 | null {
    const grant = this.grants.get(grantId);
    return grant ? structuredClone(grant) : null;
  }

  validate(input: {
    grantId: string;
    subject: SurfaceGrantSubjectV1;
    target: SurfaceTargetRefV1;
    requiredCapabilities: readonly SurfaceGrantCapabilityV1[];
    actionClass: string;
    consume?: boolean;
  }): SurfaceAccessGrantV1 {
    const session = this.sessions.requireOwned(input.subject.sessionId, input.subject);
    const grant = this.grants.get(input.grantId);
    if (!grant) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_APPROVAL_REQUIRED', 'Surface grant was not found.', input.target);
    }
    const ownerMismatch = grant.subject.sessionId !== input.subject.sessionId
      || grant.subject.runId !== input.subject.runId
      || grant.subject.agentId !== input.subject.agentId;
    if (ownerMismatch
      || grant.revokedAt !== undefined
      || grant.expiresAt <= this.now()
      || (grant.singleUse && grant.consumedAt !== undefined)) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_APPROVAL_INVALID', 'Surface grant is expired, revoked, consumed, or owned by another subject.', input.target);
    }
    if (!sameSurfaceTargetV1(grant.target, input.target)) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_TARGET_NOT_OWNED', 'Surface grant does not cover this target revision.', input.target);
    }
    const missing = input.requiredCapabilities.filter((capability) => !grant.capabilities.includes(capability));
    const actionAllowed = grant.actionClasses.includes('*') || grant.actionClasses.includes(input.actionClass);
    if (missing.length > 0 || !actionAllowed || !this.dataScopeAllows(grant, input.target)) {
      throw this.error(input.subject.sessionId, session.surface, session.provider, 'SURFACE_APPROVAL_INVALID', 'Surface grant does not cover this capability, action, or data scope.', input.target);
    }
    if (input.consume) grant.consumedAt = this.now();
    return structuredClone(grant);
  }

  revoke(grantId: string, subject: SurfaceGrantSubjectV1): SurfaceAccessGrantV1 {
    const session = this.sessions.requireOwned(subject.sessionId, subject);
    const grant = this.grants.get(grantId);
    if (grant?.subject.sessionId !== subject.sessionId
      || grant?.subject.runId !== subject.runId || grant?.subject.agentId !== subject.agentId) {
      throw this.error(subject.sessionId, session.surface, session.provider, 'SURFACE_APPROVAL_INVALID', 'Only the owning subject can revoke this grant.');
    }
    grant.revokedAt = this.now();
    return structuredClone(grant);
  }

  revokeForSession(subject: SurfaceGrantSubjectV1): void {
    this.sessions.requireOwned(subject.sessionId, subject);
    for (const grant of this.grants.values()) {
      if (grant.subject.sessionId === subject.sessionId
        && grant.subject.runId === subject.runId
        && grant.subject.agentId === subject.agentId
        && grant.revokedAt === undefined) {
        grant.revokedAt = this.now();
      }
    }
  }

  private dataScopeAllows(grant: SurfaceAccessGrantV1, target: SurfaceTargetRefV1): boolean {
    if (grant.dataScopes.includes('*')) return true;
    if (target.kind === 'browser') {
      if (grant.dataScopes.includes(`tab:${target.tabRef}`)) return true;
      if (target.origin && grant.dataScopes.includes(`origin:${target.origin}`)) return true;
      return false;
    }
    return grant.dataScopes.includes(`window:${target.windowRef}`)
      || grant.dataScopes.includes(`app:${target.bundleId || target.appName}`);
  }

  private error(
    sessionId: string,
    surface: 'browser' | 'computer',
    provider: string,
    code: 'SURFACE_APPROVAL_REQUIRED' | 'SURFACE_APPROVAL_INVALID' | 'SURFACE_TARGET_NOT_OWNED',
    message: string,
    targetRef?: SurfaceTargetRefV1,
  ): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code,
      message,
      phase: 'prepare',
      recommendedAction: 'Request a new scoped Surface grant.',
      surface,
      provider,
      sessionId,
      ...(targetRef ? { targetRef } : {}),
      userActionRequired: code !== 'SURFACE_TARGET_NOT_OWNED',
    });
  }
}
