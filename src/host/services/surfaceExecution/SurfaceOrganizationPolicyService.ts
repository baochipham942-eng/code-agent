import { createHash, randomUUID } from 'node:crypto';
import type {
  SurfaceExecutionErrorCodeV1,
  SurfaceGrantCapabilityV1,
  SurfaceKind,
} from '../../../shared/contract/surfaceExecution';
import type {
  SurfaceProviderClassV1,
  SurfaceProviderRegistrationV1,
} from './SurfaceProviderRegistry';

export type SurfaceOrganizationPolicyRiskV1 =
  | 'read'
  | 'browser_action'
  | 'desktop_input';

export interface SurfaceOrganizationScopeRulesV1 {
  defaultDecision: 'allow' | 'deny';
  allow: string[];
  deny: string[];
}

export interface SurfaceOrganizationPolicyV1 {
  version: 1;
  organizationId: string;
  domains: SurfaceOrganizationScopeRulesV1;
  apps: SurfaceOrganizationScopeRulesV1;
  profileAccount: {
    allowedProfileRefs: string[];
    allowedAccountRefs: string[];
  };
  highRisk: {
    allowedCapabilities: SurfaceGrantCapabilityV1[];
    allowedOperations: string[];
  };
  approval: {
    requiredCapabilities: SurfaceGrantCapabilityV1[];
  };
  retention: {
    auditTtlMs: number;
  };
}

export interface SurfaceOrganizationTargetContextV1 {
  domain?: string;
  appId?: string;
  profileRef?: string;
  accountRef?: string;
}

export type SurfaceOrganizationPolicyReasonV1 =
  | 'allowed'
  | 'policy_not_configured'
  | 'domain_scope_missing'
  | 'domain_denied'
  | 'app_scope_missing'
  | 'app_denied'
  | 'profile_scope_denied'
  | 'account_scope_denied'
  | 'high_risk_denied'
  | 'approval_required'
  | 'approval_invalid';

export interface SurfaceOrganizationPolicyDecisionV1 {
  decision: 'allow' | 'deny';
  reason: SurfaceOrganizationPolicyReasonV1;
  errorCode?: Extract<
    SurfaceExecutionErrorCodeV1,
    'SURFACE_POLICY_BLOCKED' | 'SURFACE_APPROVAL_REQUIRED' | 'SURFACE_APPROVAL_INVALID'
  >;
  auditId: string;
}

export interface SurfaceOrganizationApprovalV1 {
  approvalRef: string;
  expiresAt: number;
}

export interface SurfaceOrganizationAuditMetadataV1 {
  redactionStatus: 'redacted';
  organizationRef: string;
  providerRef: string;
  domainRef?: string;
  appRef?: string;
  profileRef?: string;
  accountRef?: string;
  approvalRef?: string;
}

export interface SurfaceOrganizationAuditEventV1 {
  version: 1;
  auditId: string;
  event: 'policy_evaluation' | 'approval_issued';
  occurredAt: number;
  expiresAt: number;
  decision: 'allow' | 'deny';
  reason: SurfaceOrganizationPolicyReasonV1 | 'approval_issued';
  errorCode?: SurfaceOrganizationPolicyDecisionV1['errorCode'];
  surface: SurfaceKind;
  providerClass: SurfaceProviderClassV1;
  operation: string;
  capabilities: SurfaceGrantCapabilityV1[];
  metadata: SurfaceOrganizationAuditMetadataV1;
}

export interface SurfaceOrganizationAuditStoreV1 {
  append(event: SurfaceOrganizationAuditEventV1): void;
  list(): SurfaceOrganizationAuditEventV1[];
  deleteExpired(now: number): number;
}

export class InMemorySurfaceOrganizationAuditStore implements SurfaceOrganizationAuditStoreV1 {
  private readonly events = new Map<string, SurfaceOrganizationAuditEventV1>();

  append(event: SurfaceOrganizationAuditEventV1): void {
    this.events.set(event.auditId, structuredClone(event));
  }

  list(): SurfaceOrganizationAuditEventV1[] {
    return Array.from(this.events.values()).map((event) => structuredClone(event));
  }

  deleteExpired(now: number): number {
    let deleted = 0;
    for (const [auditId, event] of this.events) {
      if (event.expiresAt > now) continue;
      this.events.delete(auditId);
      deleted += 1;
    }
    return deleted;
  }
}

interface StoredOrganizationPolicyV1 extends Omit<SurfaceOrganizationPolicyV1, 'profileAccount'> {
  profileAccount: {
    allowedProfileRefs: string[];
    allowedAccountRefs: string[];
  };
}

interface ApprovalRecordV1 {
  approvalRef: string;
  organizationRef: string;
  providerRef: string;
  surface: SurfaceKind;
  operation: string;
  capabilities: SurfaceGrantCapabilityV1[];
  targetRefs: Omit<SurfaceOrganizationAuditMetadataV1, 'redactionStatus' | 'organizationRef' | 'providerRef' | 'approvalRef'>;
  expiresAt: number;
  singleUse: boolean;
  consumedAt?: number;
}

interface SurfaceOrganizationPolicyServiceOptions {
  now?: () => number;
  createId?: (kind: 'audit' | 'approval') => string;
  auditStore?: SurfaceOrganizationAuditStoreV1;
}

const DEFAULT_AUDIT_TTL_MS = 24 * 60 * 60_000;
const MAX_AUDIT_TTL_MS = 365 * 24 * 60 * 60_000;
const MAX_APPROVAL_TTL_MS = 60 * 60_000;
const HIGH_RISK_CAPABILITIES: readonly SurfaceGrantCapabilityV1[] = [
  'file',
  'secret',
  'destructive',
];

function stableFingerprint(kind: string, value: string): string {
  return createHash('sha256')
    .update(`surface-organization-policy-v1:${kind}:${value.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 24);
}

function normalizedStrings(values: readonly string[], lowerCase = false): string[] {
  return Array.from(new Set(values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => lowerCase ? value.toLowerCase() : value))).sort();
}

function normalizeDomain(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    const parsed = candidate.includes('://') ? new URL(candidate) : new URL(`https://${candidate}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

function scopeMatches(value: string, pattern: string, domain: boolean): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern) return false;
  if (normalizedPattern === '*') return true;
  if (domain && normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return value === suffix || value.endsWith(`.${suffix}`);
  }
  return value === normalizedPattern;
}

function scopeAllows(
  value: string,
  rules: SurfaceOrganizationScopeRulesV1,
  domain: boolean,
): boolean {
  if (rules.deny.some((pattern) => scopeMatches(value, pattern, domain))) return false;
  if (rules.allow.some((pattern) => scopeMatches(value, pattern, domain))) return true;
  return rules.defaultDecision === 'allow';
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = normalizedStrings(left);
  const normalizedRight = normalizedStrings(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function safeOperation(operation: string): string {
  return /^[a-z][a-z0-9_:-]{0,127}$/.test(operation) ? operation : 'invalid-operation';
}

export function createDefaultDenySurfaceOrganizationPolicy(
  organizationId: string,
): SurfaceOrganizationPolicyV1 {
  return {
    version: 1,
    organizationId,
    domains: { defaultDecision: 'deny', allow: [], deny: [] },
    apps: { defaultDecision: 'deny', allow: [], deny: [] },
    profileAccount: { allowedProfileRefs: [], allowedAccountRefs: [] },
    highRisk: { allowedCapabilities: [], allowedOperations: [] },
    approval: { requiredCapabilities: ['input', 'navigate', 'file', 'secret', 'destructive'] },
    retention: { auditTtlMs: DEFAULT_AUDIT_TTL_MS },
  };
}

export class SurfaceOrganizationPolicyService {
  private readonly policies = new Map<string, StoredOrganizationPolicyV1>();
  private readonly approvals = new Map<string, ApprovalRecordV1>();
  private readonly now: () => number;
  private readonly createId: NonNullable<SurfaceOrganizationPolicyServiceOptions['createId']>;
  private readonly auditStore: SurfaceOrganizationAuditStoreV1;

  constructor(options: SurfaceOrganizationPolicyServiceOptions = {}) {
    this.now = options.now || Date.now;
    this.createId = options.createId || ((kind) => `surface_org_${kind}_${randomUUID()}`);
    this.auditStore = options.auditStore || new InMemorySurfaceOrganizationAuditStore();
  }

  setPolicy(input: SurfaceOrganizationPolicyV1): void {
    const organizationId = input.organizationId.trim();
    if (!organizationId) throw new Error('Surface organization policy requires an organization id.');
    const auditTtlMs = Math.min(Math.max(Math.floor(input.retention.auditTtlMs), 1), MAX_AUDIT_TTL_MS);
    this.policies.set(organizationId, {
      version: 1,
      organizationId,
      domains: {
        defaultDecision: input.domains.defaultDecision,
        allow: normalizedStrings(input.domains.allow, true),
        deny: normalizedStrings(input.domains.deny, true),
      },
      apps: {
        defaultDecision: input.apps.defaultDecision,
        allow: normalizedStrings(input.apps.allow, true),
        deny: normalizedStrings(input.apps.deny, true),
      },
      profileAccount: {
        allowedProfileRefs: normalizedStrings(input.profileAccount.allowedProfileRefs)
          .map((value) => stableFingerprint('profile', value)),
        allowedAccountRefs: normalizedStrings(input.profileAccount.allowedAccountRefs)
          .map((value) => stableFingerprint('account', value)),
      },
      highRisk: {
        allowedCapabilities: Array.from(new Set(input.highRisk.allowedCapabilities)),
        allowedOperations: normalizedStrings(input.highRisk.allowedOperations),
      },
      approval: {
        requiredCapabilities: Array.from(new Set(input.approval.requiredCapabilities)),
      },
      retention: { auditTtlMs },
    });
  }

  issueApproval(input: {
    organizationId: string;
    provider: Pick<SurfaceProviderRegistrationV1, 'providerId' | 'providerClass' | 'executionSurface'>;
    operation: string;
    capabilities: readonly SurfaceGrantCapabilityV1[];
    target: SurfaceOrganizationTargetContextV1;
    ttlMs: number;
    singleUse?: boolean;
  }): SurfaceOrganizationApprovalV1 {
    const policy = this.policies.get(input.organizationId);
    if (!policy) throw new Error('Cannot issue approval without an organization policy.');
    const now = this.now();
    const approvalRef = this.createId('approval');
    const expiresAt = now + Math.min(Math.max(Math.floor(input.ttlMs), 1), MAX_APPROVAL_TTL_MS);
    const metadata = this.auditMetadata(
      input.organizationId,
      input.provider.providerId,
      input.target,
      approvalRef,
    );
    this.approvals.set(approvalRef, {
      approvalRef,
      organizationRef: metadata.organizationRef,
      providerRef: metadata.providerRef,
      surface: input.provider.executionSurface,
      operation: safeOperation(input.operation),
      capabilities: Array.from(new Set(input.capabilities)),
      targetRefs: {
        ...(metadata.domainRef ? { domainRef: metadata.domainRef } : {}),
        ...(metadata.appRef ? { appRef: metadata.appRef } : {}),
        ...(metadata.profileRef ? { profileRef: metadata.profileRef } : {}),
        ...(metadata.accountRef ? { accountRef: metadata.accountRef } : {}),
      },
      expiresAt,
      singleUse: input.singleUse ?? true,
    });
    this.appendAudit({
      event: 'approval_issued',
      organizationId: input.organizationId,
      providerId: input.provider.providerId,
      providerClass: input.provider.providerClass,
      surface: input.provider.executionSurface,
      operation: input.operation,
      capabilities: input.capabilities,
      target: input.target,
      approvalRef,
      decision: 'allow',
      reason: 'approval_issued',
      retentionMs: policy.retention.auditTtlMs,
      now,
    });
    return { approvalRef, expiresAt };
  }

  evaluate(input: {
    organizationId: string;
    provider: Pick<
      SurfaceProviderRegistrationV1,
      'providerId' | 'providerClass' | 'executionSurface'
    >;
    operation: string;
    capabilities: readonly SurfaceGrantCapabilityV1[];
    risk: SurfaceOrganizationPolicyRiskV1;
    target: SurfaceOrganizationTargetContextV1;
    approvalRef?: string;
  }): SurfaceOrganizationPolicyDecisionV1 {
    const now = this.now();
    this.purgeExpired(now);
    const policy = this.policies.get(input.organizationId);
    if (!policy) {
      return this.deny(input, 'policy_not_configured', 'SURFACE_POLICY_BLOCKED', DEFAULT_AUDIT_TTL_MS, now);
    }

    if (input.provider.executionSurface === 'browser') {
      const domain = normalizeDomain(input.target.domain);
      if (!domain) {
        return this.deny(input, 'domain_scope_missing', 'SURFACE_POLICY_BLOCKED', policy.retention.auditTtlMs, now);
      }
      if (!scopeAllows(domain, policy.domains, true)) {
        return this.deny(input, 'domain_denied', 'SURFACE_POLICY_BLOCKED', policy.retention.auditTtlMs, now);
      }
    } else {
      const appId = input.target.appId?.trim().toLowerCase();
      if (!appId) {
        return this.deny(input, 'app_scope_missing', 'SURFACE_POLICY_BLOCKED', policy.retention.auditTtlMs, now);
      }
      if (!scopeAllows(appId, policy.apps, false)) {
        return this.deny(input, 'app_denied', 'SURFACE_POLICY_BLOCKED', policy.retention.auditTtlMs, now);
      }
    }

    const profileRef = input.target.profileRef?.trim();
    const accountRef = input.target.accountRef?.trim();
    const browserProfileRequired = input.provider.executionSurface === 'browser'
      && policy.profileAccount.allowedProfileRefs.length > 0;
    const browserAccountRequired = input.provider.executionSurface === 'browser'
      && policy.profileAccount.allowedAccountRefs.length > 0;
    if ((browserProfileRequired && !profileRef)
      || (profileRef
        && !policy.profileAccount.allowedProfileRefs.includes(stableFingerprint('profile', profileRef)))) {
      return this.deny(input, 'profile_scope_denied', 'SURFACE_POLICY_BLOCKED', policy.retention.auditTtlMs, now);
    }
    if ((browserAccountRequired && !accountRef)
      || (accountRef
        && !policy.profileAccount.allowedAccountRefs.includes(stableFingerprint('account', accountRef)))) {
      return this.deny(input, 'account_scope_denied', 'SURFACE_POLICY_BLOCKED', policy.retention.auditTtlMs, now);
    }

    const highRiskCapabilities = input.capabilities
      .filter((capability) => HIGH_RISK_CAPABILITIES.includes(capability));
    const highRisk = highRiskCapabilities.length > 0 || input.risk === 'desktop_input';
    const highRiskAllowed = highRiskCapabilities.every((capability) => (
      policy.highRisk.allowedCapabilities.includes(capability)
    )) && (input.risk !== 'desktop_input'
      || policy.highRisk.allowedOperations.includes(input.operation));
    if (highRisk && !highRiskAllowed) {
      return this.deny(input, 'high_risk_denied', 'SURFACE_POLICY_BLOCKED', policy.retention.auditTtlMs, now);
    }

    const approvalRequired = highRisk || input.capabilities.some((capability) => (
      policy.approval.requiredCapabilities.includes(capability)
    ));
    if (approvalRequired && !input.approvalRef) {
      return this.deny(input, 'approval_required', 'SURFACE_APPROVAL_REQUIRED', policy.retention.auditTtlMs, now);
    }
    if (approvalRequired && !this.consumeApproval(input, now)) {
      return this.deny(input, 'approval_invalid', 'SURFACE_APPROVAL_INVALID', policy.retention.auditTtlMs, now);
    }

    const audit = this.appendAudit({
      event: 'policy_evaluation',
      organizationId: input.organizationId,
      providerId: input.provider.providerId,
      providerClass: input.provider.providerClass,
      surface: input.provider.executionSurface,
      operation: input.operation,
      capabilities: input.capabilities,
      target: input.target,
      ...(input.approvalRef ? { approvalRef: input.approvalRef } : {}),
      decision: 'allow',
      reason: 'allowed',
      retentionMs: policy.retention.auditTtlMs,
      now,
    });
    return { decision: 'allow', reason: 'allowed', auditId: audit.auditId };
  }

  listAudit(input: { organizationId?: string; now?: number } = {}): SurfaceOrganizationAuditEventV1[] {
    this.purgeExpired(input.now ?? this.now());
    const organizationRef = input.organizationId
      ? stableFingerprint('organization', input.organizationId)
      : null;
    return this.auditStore.list()
      .filter((event) => !organizationRef || event.metadata.organizationRef === organizationRef)
      .sort((left, right) => left.occurredAt - right.occurredAt || left.auditId.localeCompare(right.auditId));
  }

  /** Safe for session export and diagnostics: entries contain fingerprints and allowlisted metadata only. */
  exportRedactedAudit(input: { organizationId?: string; now?: number } = {}): SurfaceOrganizationAuditEventV1[] {
    return this.listAudit(input);
  }

  purgeExpired(now = this.now()): { audits: number; approvals: number } {
    const audits = this.auditStore.deleteExpired(now);
    let approvals = 0;
    for (const [approvalRef, approval] of this.approvals) {
      if (approval.expiresAt > now) continue;
      this.approvals.delete(approvalRef);
      approvals += 1;
    }
    return { audits, approvals };
  }

  private consumeApproval(
    input: Parameters<SurfaceOrganizationPolicyService['evaluate']>[0],
    now: number,
  ): boolean {
    const approval = input.approvalRef ? this.approvals.get(input.approvalRef) : undefined;
    if (!approval || approval.expiresAt <= now || approval.consumedAt !== undefined) return false;
    const metadata = this.auditMetadata(
      input.organizationId,
      input.provider.providerId,
      input.target,
      input.approvalRef,
    );
    const targetRefs = {
      ...(metadata.domainRef ? { domainRef: metadata.domainRef } : {}),
      ...(metadata.appRef ? { appRef: metadata.appRef } : {}),
      ...(metadata.profileRef ? { profileRef: metadata.profileRef } : {}),
      ...(metadata.accountRef ? { accountRef: metadata.accountRef } : {}),
    };
    const targetMatches = JSON.stringify(approval.targetRefs) === JSON.stringify(targetRefs);
    const matches = approval.organizationRef === metadata.organizationRef
      && approval.providerRef === metadata.providerRef
      && approval.surface === input.provider.executionSurface
      && approval.operation === safeOperation(input.operation)
      && sameStringSet(approval.capabilities, input.capabilities)
      && targetMatches;
    if (!matches) return false;
    if (approval.singleUse) approval.consumedAt = now;
    return true;
  }

  private deny(
    input: Parameters<SurfaceOrganizationPolicyService['evaluate']>[0],
    reason: Exclude<SurfaceOrganizationPolicyReasonV1, 'allowed'>,
    errorCode: NonNullable<SurfaceOrganizationPolicyDecisionV1['errorCode']>,
    retentionMs: number,
    now: number,
  ): SurfaceOrganizationPolicyDecisionV1 {
    const audit = this.appendAudit({
      event: 'policy_evaluation',
      organizationId: input.organizationId,
      providerId: input.provider.providerId,
      providerClass: input.provider.providerClass,
      surface: input.provider.executionSurface,
      operation: input.operation,
      capabilities: input.capabilities,
      target: input.target,
      ...(input.approvalRef ? { approvalRef: input.approvalRef } : {}),
      decision: 'deny',
      reason,
      errorCode,
      retentionMs,
      now,
    });
    return { decision: 'deny', reason, errorCode, auditId: audit.auditId };
  }

  private appendAudit(input: {
    event: SurfaceOrganizationAuditEventV1['event'];
    organizationId: string;
    providerId: string;
    providerClass: SurfaceProviderClassV1;
    surface: SurfaceKind;
    operation: string;
    capabilities: readonly SurfaceGrantCapabilityV1[];
    target: SurfaceOrganizationTargetContextV1;
    approvalRef?: string;
    decision: SurfaceOrganizationAuditEventV1['decision'];
    reason: SurfaceOrganizationAuditEventV1['reason'];
    errorCode?: SurfaceOrganizationAuditEventV1['errorCode'];
    retentionMs: number;
    now: number;
  }): SurfaceOrganizationAuditEventV1 {
    const event: SurfaceOrganizationAuditEventV1 = {
      version: 1,
      auditId: this.createId('audit'),
      event: input.event,
      occurredAt: input.now,
      expiresAt: input.now + input.retentionMs,
      decision: input.decision,
      reason: input.reason,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      surface: input.surface,
      providerClass: input.providerClass,
      operation: safeOperation(input.operation),
      capabilities: Array.from(new Set(input.capabilities)).sort(),
      metadata: this.auditMetadata(
        input.organizationId,
        input.providerId,
        input.target,
        input.approvalRef,
      ),
    };
    this.auditStore.append(event);
    return structuredClone(event);
  }

  private auditMetadata(
    organizationId: string,
    providerId: string,
    target: SurfaceOrganizationTargetContextV1,
    approvalRef?: string,
  ): SurfaceOrganizationAuditMetadataV1 {
    const domain = normalizeDomain(target.domain);
    const appId = target.appId?.trim();
    return {
      redactionStatus: 'redacted',
      organizationRef: stableFingerprint('organization', organizationId),
      providerRef: stableFingerprint('provider', providerId),
      ...(domain ? { domainRef: stableFingerprint('domain', domain) } : {}),
      ...(appId ? { appRef: stableFingerprint('app', appId) } : {}),
      ...(target.profileRef ? { profileRef: stableFingerprint('profile', target.profileRef) } : {}),
      ...(target.accountRef ? { accountRef: stableFingerprint('account', target.accountRef) } : {}),
      ...(approvalRef ? { approvalRef: stableFingerprint('approval', approvalRef) } : {}),
    };
  }
}
