import crypto from 'crypto';
import type { SurfaceTargetRefV1 } from '../../../shared/contract/surfaceExecution';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import { SurfaceSessionManager } from './SurfaceSessionManager';

export type BrowserTabLeaseStateV1 =
  | 'available'
  | 'consent_pending'
  | 'leased'
  | 'returning'
  | 'returned'
  | 'denied'
  | 'expired'
  | 'orphaned'
  | 'recovery_required';

export const BROWSER_TAB_LEASE_TRANSITIONS_V1: Readonly<
  Record<BrowserTabLeaseStateV1, readonly BrowserTabLeaseStateV1[]>
> = {
  available: ['consent_pending', 'orphaned'],
  consent_pending: ['leased', 'denied', 'expired', 'orphaned'],
  leased: ['returning', 'expired', 'orphaned'],
  returning: ['returned', 'orphaned', 'recovery_required'],
  returned: [],
  denied: [],
  expired: ['returning', 'orphaned'],
  orphaned: ['returning', 'recovery_required'],
  recovery_required: ['returning'],
};

export interface BrowserTabLeaseSubjectV1 {
  conversationId: string;
  sessionId: string;
  runId: string;
  agentId: string;
}

export interface BrowserTabOriginalPlacementV1 {
  windowRef: string;
  index: number;
  pinned?: boolean;
}

export type BrowserTabReturnPolicyV1 = 'session_end' | 'session_end_or_expiry';

/**
 * Host-only lease projection. It deliberately excludes URL, title, favIcon,
 * cookie/profile data, native tab/window ids, and extension/debugger ids.
 */
export interface BrowserTabLeaseV1 {
  version: 1;
  leaseId: string;
  subject: BrowserTabLeaseSubjectV1;
  browserInstanceId: string;
  tabRef: string;
  agentWindowRef: string;
  originalPlacement: BrowserTabOriginalPlacementV1;
  state: BrowserTabLeaseStateV1;
  domainScopes: string[];
  actionScopes: string[];
  returnPolicy: BrowserTabReturnPolicyV1;
  createdAt: number;
  updatedAt: number;
  consentRequestedAt?: number;
  consentExpiresAt?: number;
  approvedAt?: number;
  expiresAt?: number;
  deniedAt?: number;
  returningAt?: number;
  returnedAt?: number;
  orphanedAt?: number;
  recoveryRequiredAt?: number;
  recoveryCode?: 'provider_disconnected' | 'extension_restarted' | 'tab_missing' | 'return_failed';
}

interface StoredBrowserTabLease extends BrowserTabLeaseV1 {
  approvalRefHashes: string[];
}

export interface BrowserTabLeaseServiceOptions {
  now?: () => number;
  createId?: () => string;
  maxLeaseTtlMs?: number;
  maxConsentTtlMs?: number;
  relayProvider?: string;
}

const ACTIVE_TAB_STATES = new Set<BrowserTabLeaseStateV1>([
  'available',
  'consent_pending',
  'leased',
  'returning',
  'expired',
  'orphaned',
  'recovery_required',
]);

export class BrowserTabLeaseService {
  private readonly leases = new Map<string, StoredBrowserTabLease>();
  private readonly consumedApprovalRefs = new Set<string>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxLeaseTtlMs: number;
  private readonly maxConsentTtlMs: number;
  private readonly relayProvider: string;

  constructor(
    private readonly sessions: SurfaceSessionManager,
    options: BrowserTabLeaseServiceOptions = {},
  ) {
    this.now = options.now || Date.now;
    this.createId = options.createId || (() => `browser_tab_lease_${crypto.randomUUID()}`);
    this.maxLeaseTtlMs = options.maxLeaseTtlMs || 30 * 60_000;
    this.maxConsentTtlMs = options.maxConsentTtlMs || 5 * 60_000;
    this.relayProvider = options.relayProvider || 'browser-relay';
  }

  registerAvailable(input: {
    subject: BrowserTabLeaseSubjectV1;
    browserInstanceId: string;
    tabRef: string;
    agentWindowRef: string;
    originalPlacement: BrowserTabOriginalPlacementV1;
    returnPolicy?: BrowserTabReturnPolicyV1;
  }): BrowserTabLeaseV1 {
    const session = this.requireRelaySubject(input.subject);
    this.requireOpaqueRef(input.browserInstanceId, 'browserInstanceId', input.subject, session.provider);
    this.requireOpaqueRef(input.tabRef, 'tabRef', input.subject, session.provider);
    this.requireOpaqueRef(input.agentWindowRef, 'agentWindowRef', input.subject, session.provider);
    this.requireOpaqueRef(input.originalPlacement.windowRef, 'original windowRef', input.subject, session.provider);
    if (input.agentWindowRef === input.originalPlacement.windowRef) {
      throw this.error(input.subject, session.provider, 'SURFACE_POLICY_BLOCKED', 'Borrowed tabs require a Surface-owned Agent Window distinct from the user window.');
    }
    if (!Number.isSafeInteger(input.originalPlacement.index) || input.originalPlacement.index < 0) {
      throw this.error(input.subject, session.provider, 'SURFACE_POLICY_BLOCKED', 'Original tab position must be a non-negative integer.');
    }
    const activeLeases = Array.from(this.leases.values()).filter((lease) => this.holdsTabFence(lease));
    const existing = activeLeases.find((lease) => (
      lease.browserInstanceId === input.browserInstanceId
      && lease.tabRef === input.tabRef
    ));
    if (existing) {
      throw this.error(input.subject, session.provider, 'SURFACE_SESSION_BUSY', 'The selected tab already has an active borrow workflow.');
    }
    const agentWindowOwner = activeLeases.find((lease) => (
      lease.browserInstanceId === input.browserInstanceId
      && lease.agentWindowRef === input.agentWindowRef
      && !this.sameSubject(lease.subject, input.subject)
    ));
    if (agentWindowOwner) {
      throw this.error(input.subject, session.provider, 'SURFACE_SESSION_BUSY', 'The Agent Window belongs to another Surface Session.');
    }
    const ownedWindow = activeLeases.find((lease) => this.sameSubject(lease.subject, input.subject));
    if (ownedWindow && ownedWindow.agentWindowRef !== input.agentWindowRef) {
      throw this.error(input.subject, session.provider, 'SURFACE_POLICY_BLOCKED', 'A Relay Surface Session must use one dedicated Agent Window.');
    }
    const now = this.now();
    const stored: StoredBrowserTabLease = {
      version: 1,
      leaseId: this.createId(),
      subject: { ...input.subject },
      browserInstanceId: input.browserInstanceId,
      tabRef: input.tabRef,
      agentWindowRef: input.agentWindowRef,
      originalPlacement: { ...input.originalPlacement },
      state: 'available',
      domainScopes: [],
      actionScopes: [],
      returnPolicy: input.returnPolicy || 'session_end_or_expiry',
      createdAt: now,
      updatedAt: now,
      approvalRefHashes: [],
    };
    this.leases.set(stored.leaseId, stored);
    return this.project(stored);
  }

  requestConsent(input: {
    leaseId: string;
    subject: BrowserTabLeaseSubjectV1;
    ttlMs?: number;
  }): BrowserTabLeaseV1 {
    const lease = this.requireOwned(input.leaseId, input.subject);
    this.requireState(lease, ['available'], input.subject);
    const ttlMs = this.requireTtl(input.ttlMs ?? this.maxConsentTtlMs, this.maxConsentTtlMs, input.subject);
    const now = this.now();
    lease.consentRequestedAt = now;
    lease.consentExpiresAt = now + ttlMs;
    return this.transition(lease, 'consent_pending');
  }

  approve(input: {
    leaseId: string;
    subject: BrowserTabLeaseSubjectV1;
    approvalRef: string;
    domainScopes: string[];
    actionScopes: string[];
    ttlMs: number;
  }): BrowserTabLeaseV1 {
    const lease = this.requireOwned(input.leaseId, input.subject);
    this.expireIfDue(lease);
    this.requireState(lease, ['consent_pending'], input.subject);
    return this.applyApproval(lease, input);
  }

  deny(input: {
    leaseId: string;
    subject: BrowserTabLeaseSubjectV1;
  }): BrowserTabLeaseV1 {
    const lease = this.requireOwned(input.leaseId, input.subject);
    this.expireIfDue(lease);
    this.requireState(lease, ['consent_pending'], input.subject);
    lease.deniedAt = this.now();
    return this.transition(lease, 'denied');
  }

  renew(input: {
    leaseId: string;
    subject: BrowserTabLeaseSubjectV1;
    approvalRef: string;
    domainScopes: string[];
    actionScopes: string[];
    ttlMs: number;
  }): BrowserTabLeaseV1 {
    const lease = this.requireOwned(input.leaseId, input.subject);
    this.expireIfDue(lease);
    this.requireState(lease, ['leased'], input.subject);
    return this.applyApproval(lease, input);
  }

  authorize(input: {
    leaseId: string;
    subject: BrowserTabLeaseSubjectV1;
    target: SurfaceTargetRefV1;
    action: string;
  }): BrowserTabLeaseV1 {
    const lease = this.requireOwned(input.leaseId, input.subject);
    this.expireIfDue(lease);
    this.requireState(lease, ['leased'], input.subject, true);
    if (input.target.kind !== 'browser'
      || input.target.browserInstanceId !== lease.browserInstanceId
      || input.target.tabRef !== lease.tabRef
      || input.target.windowRef !== lease.agentWindowRef) {
      throw this.error(input.subject, this.relayProvider, 'SURFACE_TARGET_NOT_OWNED', 'The Relay lease does not cover this tab or Agent Window.', input.target);
    }
    if (!input.target.origin || !this.domainAllowed(lease.domainScopes, input.target.origin)) {
      throw this.error(input.subject, this.relayProvider, 'SURFACE_APPROVAL_INVALID', 'The Relay lease does not cover this target domain.', input.target);
    }
    if (!lease.actionScopes.includes(input.action)) {
      throw this.error(input.subject, this.relayProvider, 'SURFACE_APPROVAL_INVALID', 'The Relay lease does not cover this action.', input.target);
    }
    return this.project(lease);
  }

  expireOwned(subject: BrowserTabLeaseSubjectV1): BrowserTabLeaseV1[] {
    this.requireRelaySubject(subject);
    const expired: BrowserTabLeaseV1[] = [];
    for (const lease of this.leases.values()) {
      if (!this.sameSubject(lease.subject, subject)) continue;
      const before = lease.state;
      this.expireIfDue(lease);
      if (before !== 'expired' && lease.state === 'expired') expired.push(this.project(lease));
    }
    return expired;
  }

  markOrphaned(input: {
    leaseId: string;
    subject: BrowserTabLeaseSubjectV1;
    code: Exclude<NonNullable<BrowserTabLeaseV1['recoveryCode']>, 'return_failed'>;
  }): BrowserTabLeaseV1 {
    const lease = this.requireOwned(input.leaseId, input.subject);
    this.requireState(lease, ['available', 'consent_pending', 'leased', 'returning', 'expired'], input.subject);
    lease.orphanedAt = this.now();
    lease.recoveryCode = input.code;
    return this.transition(lease, 'orphaned');
  }

  markRecoveryRequired(input: {
    leaseId: string;
    subject: BrowserTabLeaseSubjectV1;
    code?: NonNullable<BrowserTabLeaseV1['recoveryCode']>;
  }): BrowserTabLeaseV1 {
    const lease = this.requireOwned(input.leaseId, input.subject);
    this.requireState(lease, ['returning', 'orphaned'], input.subject);
    lease.recoveryCode = input.code || 'return_failed';
    lease.recoveryRequiredAt = this.now();
    return this.transition(lease, 'recovery_required');
  }

  async returnLease(input: {
    leaseId: string;
    subject: BrowserTabLeaseSubjectV1;
    restore: (placement: Readonly<BrowserTabOriginalPlacementV1>) => void | Promise<void>;
  }): Promise<BrowserTabLeaseV1> {
    const lease = this.requireOwned(input.leaseId, input.subject);
    this.expireIfDue(lease);
    this.requireState(lease, ['leased', 'expired', 'orphaned', 'recovery_required'], input.subject);
    if (lease.approvedAt === undefined) {
      throw this.error(input.subject, this.relayProvider, 'SURFACE_POLICY_BLOCKED', 'The tab was never borrowed and has no return operation to perform.');
    }
    lease.returningAt = this.now();
    this.transition(lease, 'returning');
    try {
      await input.restore(Object.freeze({ ...lease.originalPlacement }));
      lease.returnedAt = this.now();
      lease.recoveryCode = undefined;
      return this.transition(lease, 'returned');
    } catch {
      lease.recoveryCode = 'return_failed';
      lease.recoveryRequiredAt = this.now();
      this.transition(lease, 'recovery_required');
      throw this.error(
        input.subject,
        this.relayProvider,
        'SURFACE_CLEANUP_FAILED',
        'The borrowed tab could not be restored to its original placement.',
        undefined,
        'Retry tab recovery while preserving the current browser state.',
      );
    }
  }

  getOwned(leaseId: string, subject: BrowserTabLeaseSubjectV1): BrowserTabLeaseV1 | null {
    this.requireRelaySubject(subject);
    const lease = this.leases.get(leaseId);
    if (!lease) return null;
    if (!this.sameSubject(lease.subject, subject)) {
      throw this.error(subject, this.relayProvider, 'SURFACE_TARGET_NOT_OWNED', 'The Relay lease belongs to another Surface owner.');
    }
    this.expireIfDue(lease);
    return this.project(lease);
  }

  listOwned(subject: BrowserTabLeaseSubjectV1): BrowserTabLeaseV1[] {
    this.requireRelaySubject(subject);
    return Array.from(this.leases.values())
      .filter((lease) => this.sameSubject(lease.subject, subject))
      .map((lease) => {
        this.expireIfDue(lease);
        return this.project(lease);
      });
  }

  listReturnRequired(subject: BrowserTabLeaseSubjectV1): BrowserTabLeaseV1[] {
    return this.listOwned(subject).filter((lease) => (
      lease.approvedAt !== undefined
      && (lease.state === 'leased'
        || lease.state === 'returning'
        || lease.state === 'expired'
        || lease.state === 'orphaned'
        || lease.state === 'recovery_required')
    ));
  }

  private applyApproval(
    lease: StoredBrowserTabLease,
    input: {
      subject: BrowserTabLeaseSubjectV1;
      approvalRef: string;
      domainScopes: string[];
      actionScopes: string[];
      ttlMs: number;
    },
  ): BrowserTabLeaseV1 {
    const approvalHash = this.hashApprovalRef(input.approvalRef, input.subject);
    if (this.consumedApprovalRefs.has(approvalHash)) {
      throw this.error(input.subject, this.relayProvider, 'SURFACE_APPROVAL_INVALID', 'Relay approval proof has already been consumed.');
    }
    const domainScopes = this.normalizeDomainScopes(input.domainScopes, input.subject);
    const actionScopes = this.normalizeActionScopes(input.actionScopes, input.subject);
    const ttlMs = this.requireTtl(input.ttlMs, this.maxLeaseTtlMs, input.subject);
    const now = this.now();
    this.consumedApprovalRefs.add(approvalHash);
    lease.approvalRefHashes.push(approvalHash);
    lease.domainScopes = domainScopes;
    lease.actionScopes = actionScopes;
    lease.approvedAt = now;
    lease.expiresAt = now + ttlMs;
    lease.consentExpiresAt = undefined;
    if (lease.state === 'leased') {
      lease.updatedAt = now;
      return this.project(lease);
    }
    return this.transition(lease, 'leased');
  }

  private expireIfDue(lease: StoredBrowserTabLease): void {
    const now = this.now();
    if (lease.state === 'consent_pending' && lease.consentExpiresAt !== undefined && lease.consentExpiresAt <= now) {
      this.transition(lease, 'expired');
    } else if (lease.state === 'leased' && lease.expiresAt !== undefined && lease.expiresAt <= now) {
      this.transition(lease, 'expired');
    }
  }

  private transition(lease: StoredBrowserTabLease, next: BrowserTabLeaseStateV1): BrowserTabLeaseV1 {
    if (!BROWSER_TAB_LEASE_TRANSITIONS_V1[lease.state].includes(next)) {
      throw this.error(lease.subject, this.relayProvider, 'SURFACE_POLICY_BLOCKED', `Invalid Browser tab lease transition: ${lease.state} -> ${next}.`);
    }
    lease.state = next;
    lease.updatedAt = this.now();
    return this.project(lease);
  }

  private requireOwned(leaseId: string, subject: BrowserTabLeaseSubjectV1): StoredBrowserTabLease {
    this.requireRelaySubject(subject);
    const lease = this.leases.get(leaseId);
    if (!lease) {
      throw this.error(subject, this.relayProvider, 'BROWSER_TAB_BORROW_REQUIRED', 'A valid Relay tab lease is required.');
    }
    if (!this.sameSubject(lease.subject, subject)) {
      throw this.error(subject, this.relayProvider, 'SURFACE_TARGET_NOT_OWNED', 'The Relay lease belongs to another Surface owner.');
    }
    return lease;
  }

  private holdsTabFence(lease: StoredBrowserTabLease): boolean {
    if (!ACTIVE_TAB_STATES.has(lease.state)) return false;
    if (lease.state === 'expired' || lease.state === 'orphaned' || lease.state === 'recovery_required') {
      return lease.approvedAt !== undefined;
    }
    return true;
  }

  private requireRelaySubject(subject: BrowserTabLeaseSubjectV1) {
    const session = this.sessions.requireOwned(subject.sessionId, subject);
    if (session.conversationId !== subject.conversationId
      || session.surface !== 'browser'
      || session.provider !== this.relayProvider) {
      throw this.error(subject, session.provider, 'SURFACE_TARGET_NOT_OWNED', 'Relay tab lease subject does not match the Browser Surface session.');
    }
    return session;
  }

  private requireState(
    lease: StoredBrowserTabLease,
    states: BrowserTabLeaseStateV1[],
    subject: BrowserTabLeaseSubjectV1,
    deniedIsBorrowError = false,
  ): void {
    if (states.includes(lease.state)) return;
    const code = lease.state === 'denied'
      ? 'BROWSER_TAB_BORROW_DENIED'
      : deniedIsBorrowError ? 'BROWSER_TAB_BORROW_REQUIRED' : 'SURFACE_POLICY_BLOCKED';
    throw this.error(subject, this.relayProvider, code, `Relay tab lease is ${lease.state}; expected ${states.join(' or ')}.`);
  }

  private requireTtl(ttlMs: number, maximum: number, subject: BrowserTabLeaseSubjectV1): number {
    if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > maximum) {
      throw this.error(subject, this.relayProvider, 'SURFACE_APPROVAL_INVALID', `Relay approval TTL must be between 1 and ${maximum} milliseconds.`);
    }
    return Math.floor(ttlMs);
  }

  private normalizeDomainScopes(scopes: string[], subject: BrowserTabLeaseSubjectV1): string[] {
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw this.error(subject, this.relayProvider, 'SURFACE_APPROVAL_INVALID', 'Relay approval requires at least one domain scope.');
    }
    const normalized = scopes.map((scope) => this.normalizeDomainScope(scope, subject));
    return Array.from(new Set(normalized));
  }

  private normalizeDomainScope(scope: string, subject: BrowserTabLeaseSubjectV1): string {
    const value = typeof scope === 'string' ? scope.trim().toLowerCase() : '';
    if (!value || value.includes('*') || value.includes('/') && !value.includes('://')) {
      throw this.error(subject, this.relayProvider, 'SURFACE_APPROVAL_INVALID', 'Relay domain scope must be an exact HTTP(S) origin or hostname.');
    }
    try {
      if (value.includes('://')) {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('unsupported origin');
        return `origin:${parsed.origin.toLowerCase()}`;
      }
      const parsed = new URL(`https://${value}`);
      if (parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname) throw new Error('invalid host');
      return `host:${parsed.hostname.toLowerCase()}`;
    } catch {
      throw this.error(subject, this.relayProvider, 'SURFACE_APPROVAL_INVALID', 'Relay domain scope must be an exact HTTP(S) origin or hostname.');
    }
  }

  private normalizeActionScopes(scopes: string[], subject: BrowserTabLeaseSubjectV1): string[] {
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw this.error(subject, this.relayProvider, 'SURFACE_APPROVAL_INVALID', 'Relay approval requires at least one action scope.');
    }
    const normalized = scopes.map((scope) => typeof scope === 'string' ? scope.trim() : '');
    if (normalized.some((scope) => !scope || scope === '*' || scope.includes('*'))) {
      throw this.error(subject, this.relayProvider, 'SURFACE_APPROVAL_INVALID', 'Relay action scopes must be explicit actions without wildcards.');
    }
    return Array.from(new Set(normalized));
  }

  private domainAllowed(scopes: string[], origin: string): boolean {
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
      const normalizedOrigin = parsed.origin.toLowerCase();
      const host = parsed.hostname.toLowerCase();
      return scopes.includes(`origin:${normalizedOrigin}`) || scopes.includes(`host:${host}`);
    } catch {
      return false;
    }
  }

  private hashApprovalRef(value: string, subject: BrowserTabLeaseSubjectV1): string {
    if (typeof value !== 'string' || value.trim().length < 8) {
      throw this.error(subject, this.relayProvider, 'SURFACE_APPROVAL_INVALID', 'Relay approval proof is missing or invalid.');
    }
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  private requireOpaqueRef(
    value: string,
    label: string,
    subject: BrowserTabLeaseSubjectV1,
    provider: string,
  ): void {
    if (typeof value !== 'string' || value.trim().length < 3 || /^\d+$/.test(value.trim())) {
      throw this.error(subject, provider, 'SURFACE_POLICY_BLOCKED', `${label} must be an opaque Host-issued reference.`);
    }
  }

  private sameSubject(a: BrowserTabLeaseSubjectV1, b: BrowserTabLeaseSubjectV1): boolean {
    return a.conversationId === b.conversationId
      && a.sessionId === b.sessionId
      && a.runId === b.runId
      && a.agentId === b.agentId;
  }

  private project(lease: StoredBrowserTabLease): BrowserTabLeaseV1 {
    const { approvalRefHashes: _approvalRefHashes, ...publicLease } = lease;
    return structuredClone(publicLease);
  }

  private error(
    subject: BrowserTabLeaseSubjectV1,
    provider: string,
    code: 'SURFACE_SESSION_BUSY'
      | 'SURFACE_TARGET_NOT_OWNED'
      | 'SURFACE_POLICY_BLOCKED'
      | 'SURFACE_APPROVAL_INVALID'
      | 'BROWSER_TAB_BORROW_REQUIRED'
      | 'BROWSER_TAB_BORROW_DENIED'
      | 'SURFACE_CLEANUP_FAILED',
    message: string,
    targetRef?: SurfaceTargetRefV1,
    recommendedAction = 'Request a new explicit Relay tab approval.',
  ): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code,
      message,
      phase: code === 'SURFACE_CLEANUP_FAILED' ? 'cleanup' : 'prepare',
      retryable: code === 'SURFACE_CLEANUP_FAILED',
      userActionRequired: code !== 'SURFACE_TARGET_NOT_OWNED' && code !== 'SURFACE_SESSION_BUSY',
      recommendedAction,
      surface: 'browser',
      provider,
      sessionId: subject.sessionId,
      ...(targetRef ? { targetRef } : {}),
    });
  }
}
