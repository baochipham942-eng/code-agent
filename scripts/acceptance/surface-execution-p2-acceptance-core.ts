import { RunRegistry } from '../../src/host/runtime/runRegistry.ts';
import {
  ExternalSurfaceAgentAdapter,
  type ExternalBrowserHostAuthorityV1,
  type ExternalSurfaceProviderDispatchRequestV1,
} from '../../src/host/services/surfaceExecution/ExternalSurfaceAgentAdapter.ts';
import { SurfaceExecutionRuntime } from '../../src/host/services/surfaceExecution/SurfaceExecutionRuntime.ts';
import {
  SurfaceOrganizationPolicyService,
  type SurfaceOrganizationPolicyDecisionV1,
} from '../../src/host/services/surfaceExecution/SurfaceOrganizationPolicyService.ts';
import {
  SURFACE_PROVIDER_G4_DECISIONS_V1,
  SurfaceProviderRegistry,
  type SurfaceProviderRegistrationV1,
} from '../../src/host/services/surfaceExecution/SurfaceProviderRegistry.ts';
import type { SurfaceTargetRefV1 } from '../../src/shared/contract/surfaceExecution.ts';

export interface SurfaceExecutionP2AcceptanceResultV1 {
  version: 1;
  assertions: {
    externalSurfaceAdapterContractVerified: boolean;
    organizationPolicyAuditRetentionVerified: boolean;
    providerNeutralRegistryContractVerified: boolean;
    providerImplementationDefersExact: boolean;
  };
  details: {
    externalAdapter: {
      sanitizedDispatch: {
        requestKeys: string[];
        argumentKeys: string[];
        authorityKeysPresent: boolean;
      };
      dispatchCount: number;
      delivery: string;
      sessionGrantProjected: boolean;
      staleRefCode: string;
      foreignOwnerCode: string;
      forgedAuthorityCode: string;
      forgedAuthorityReason: string;
      policyAuditDecisions: string[];
    };
    organizationPolicy: {
      domainAllowDecisions: string[];
      profileDeniedReason: string;
      missingProfileDeniedReason: string;
      missingAccountDeniedReason: string;
      foreignAccountDeniedReason: string;
      domainDeniedReason: string;
      appAllowDecision: string;
      appDeniedReason: string;
      auditEventsBeforeRetention: number;
      auditMetadataRedacted: boolean;
      rawScopeAbsent: boolean;
      retentionPurgedAudits: number;
      auditEventsAfterRetention: number;
    };
    providerRegistry: {
      registeredProviderClass: string;
      selectedProviderId: string;
      selectedCapabilities: string[];
      targetAuthority: string;
      cleanupOwner: string;
      capabilityFailureReason: string;
      surfaceFailureReason: string;
      unknownProviderFailureReason: string;
      duplicateRegistrationRejected: boolean;
      productionProviderIds: string[];
      gatedProviderIds: string[];
      gatedProviderFailureReasons: Record<string, string>;
      g4DecisionRows: string[];
      g4DecisionEvidenceComplete: boolean;
    };
  };
  evidenceBackedDefers: {
    externalProductionEntrypoints: SurfaceExecutionP2DeferV1;
    organizationProductionStore: SurfaceExecutionP2DeferV1;
    providerImplementations: SurfaceExecutionP2DeferV1[];
  };
}

export interface SurfaceExecutionP2DeferV1 {
  row: string;
  status: 'evidence-backed-defer';
  gate: 'G4';
  reason: string;
  evidenceObserved: string[];
  evidenceRequired: string[];
}

const PROVIDER_ID_BY_G4_DECISION_ROW = {
  'multi-browser-provider': 'future:multi-browser',
  'remote-managed-browser-pool': 'future:remote-managed',
  'mobile-device-cloud': 'future:mobile',
  'in-app-preview-provider': 'future:in-app-preview',
} as const;

const WINDOWS_LINUX_PROVIDER_ROW = 'windows-linux-profile-and-computer-provider';

interface SurfaceFailureProjection {
  code: string;
  reason: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function surfaceFailure(error: unknown): SurfaceFailureProjection {
  if (!isRecord(error) || !isRecord(error.surfaceError)) {
    return { code: 'UNKNOWN', reason: error instanceof Error ? error.message : String(error) };
  }
  const details = isRecord(error.surfaceError.detailsSafe) ? error.surfaceError.detailsSafe : {};
  return {
    code: typeof error.surfaceError.code === 'string' ? error.surfaceError.code : 'UNKNOWN',
    reason: typeof details.reason === 'string' ? details.reason : 'unknown',
  };
}

async function rejectedSurfaceFailure(task: () => Promise<unknown>): Promise<SurfaceFailureProjection> {
  try {
    await task();
    return { code: 'UNEXPECTED_SUCCESS', reason: 'operation_did_not_fail_closed' };
  } catch (error) {
    return surfaceFailure(error);
  }
}

function registryFailure(task: () => unknown): string {
  try {
    task();
    return 'unexpected_success';
  } catch (error) {
    return isRecord(error) && typeof error.reason === 'string' ? error.reason : 'unknown';
  }
}

function externalPolicy(service: SurfaceOrganizationPolicyService): void {
  service.setPolicy({
    version: 1,
    organizationId: 'p2-external-organization',
    domains: { defaultDecision: 'deny', allow: ['external.example.test'], deny: [] },
    apps: { defaultDecision: 'deny', allow: ['com.example.editor'], deny: [] },
    profileAccount: { allowedProfileRefs: [], allowedAccountRefs: [] },
    highRisk: { allowedCapabilities: [], allowedOperations: [] },
    approval: { requiredCapabilities: ['input', 'navigate', 'file', 'secret', 'destructive'] },
    retention: { auditTtlMs: 60_000 },
  });
}

async function verifyExternalAdapter(): Promise<{
  verified: boolean;
  details: SurfaceExecutionP2AcceptanceResultV1['details']['externalAdapter'];
}> {
  const runs = new RunRegistry();
  const identity = {
    conversationId: 'p2-external-conversation',
    runId: 'p2-external-run',
    agentId: 'p2-external-agent',
  };
  runs.start({ runId: identity.runId, sessionId: identity.conversationId, workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: runs });
  const providers = new SurfaceProviderRegistry();
  let id = 0;
  const policy = new SurfaceOrganizationPolicyService({
    now: () => 10_000,
    createId: (kind) => `p2-external-${kind}-${++id}`,
  });
  externalPolicy(policy);
  const adapter = new ExternalSurfaceAgentAdapter({
    runtime,
    providers,
    policy,
    createOperationId: () => 'p2-external-operation',
  });
  const prepared = runtime.prepareBrowserSession({ identity });
  const target: Extract<SurfaceTargetRefV1, { kind: 'browser' }> = {
    kind: 'browser',
    browserInstanceId: 'managed:p2-external',
    windowRef: 'window:p2-host-owned',
    tabRef: 'tab:p2-host-owned',
    origin: 'https://external.example.test',
    documentRevision: 'document:p2-host-owned:1',
    title: 'P2 external adapter fixture',
  };
  const observed = runtime.recordBrowserObservation({
    identity,
    surfaceSessionId: prepared.session.sessionId,
    target,
    providerGeneration: 'managed:p2-external:1',
    elements: [{
      kind: 'browser-element',
      ref: 'element:p2-host-issued',
      tabRef: target.tabRef,
      documentRevision: target.documentRevision,
      backendNodeId: 42,
    }],
    evidenceAssetIds: ['evidence:p2-external-before'],
  });
  const provider = providers.describe('system-chrome-cdp');
  assert(provider, 'P2 external adapter could not resolve the Managed provider');
  const approval = policy.issueApproval({
    organizationId: 'p2-external-organization',
    provider,
    operation: 'click',
    capabilities: ['input'],
    target: { domain: 'external.example.test' },
    ttlMs: 30_000,
  });
  let dispatchCount = 0;
  let providerRequest: ExternalSurfaceProviderDispatchRequestV1 | undefined;
  const authority: ExternalBrowserHostAuthorityV1 = {
    surface: 'browser',
    identity,
    providerId: provider.providerId,
    organizationId: 'p2-external-organization',
    policyTarget: { domain: 'external.example.test' },
    approvalRef: approval.approvalRef,
    surfaceSessionId: prepared.session.sessionId,
    predecessorStateId: observed.observation.stateId,
    async dispatch(_signal, subject, request) {
      assert(subject.sessionId === prepared.session.sessionId, 'Provider received a foreign session subject');
      dispatchCount += 1;
      providerRequest = structuredClone(request);
      return {
        providerResult: { clicked: true },
        outcome: {
          delivery: 'confirmed',
          verification: 'not_requested',
          evidenceRefs: ['evidence:p2-external-after'],
        },
      };
    },
  };

  try {
    const delivered = await adapter.invoke(authority, {
      version: 1,
      entrypoint: 'neo browser',
      operation: 'click',
      arguments: { targetRef: 'element:p2-host-issued' },
    });
    assert(providerRequest, 'External adapter did not dispatch a sanitized provider request');
    const requestKeys = Object.keys(providerRequest).sort();
    const argumentKeys = Object.keys(providerRequest.arguments).sort();
    const authorityKeysPresent = [
      'identity',
      'owner',
      'sessionId',
      'providerId',
      'grantId',
      'approvalRef',
      'leaseId',
      'tabId',
      'windowId',
    ].some((key) => key in providerRequest! || key in providerRequest!.arguments);

    const staleApproval = policy.issueApproval({
      organizationId: 'p2-external-organization',
      provider,
      operation: 'click',
      capabilities: ['input'],
      target: { domain: 'external.example.test' },
      ttlMs: 30_000,
    });
    const staleRef = await rejectedSurfaceFailure(() => adapter.invoke({
      ...authority,
      approvalRef: staleApproval.approvalRef,
    }, {
      version: 1,
      entrypoint: 'neo browser',
      operation: 'click',
      arguments: { targetRef: 'element:p2-foreign-or-stale' },
    }));
    const foreignOwner = await rejectedSurfaceFailure(() => adapter.invoke({
      ...authority,
      identity: { ...identity, agentId: 'p2-foreign-agent' },
      approvalRef: undefined,
    }, {
      version: 1,
      entrypoint: 'neo surface',
      operation: 'screenshot',
    }));
    const forgedAuthority = await rejectedSurfaceFailure(() => adapter.invoke(authority, {
      version: 1,
      entrypoint: 'neo browser',
      operation: 'screenshot',
      arguments: { surfaceSessionId: prepared.session.sessionId },
    } as never));
    const policyAudit = policy.listAudit({ organizationId: 'p2-external-organization' });
    const sessionGrantProjected = 'grantId' in (delivered.session as unknown as Record<string, unknown>);
    const verified = delivered.action.delivery === 'confirmed'
      && dispatchCount === 1
      && JSON.stringify(requestKeys) === JSON.stringify([
        'arguments',
        'entrypoint',
        'operation',
        'version',
      ])
      && JSON.stringify(argumentKeys) === JSON.stringify(['action', 'targetRef'])
      && !authorityKeysPresent
      && !sessionGrantProjected
      && staleRef.code === 'SURFACE_ELEMENT_REF_NOT_FOUND'
      && foreignOwner.code === 'SURFACE_TARGET_NOT_OWNED'
      && forgedAuthority.code === 'SURFACE_POLICY_BLOCKED'
      && forgedAuthority.reason === 'external_authority_forbidden'
      && policyAudit.some((event) => event.decision === 'allow');
    assert(verified, 'External Surface adapter P2 behavior did not satisfy its authority boundary');
    return {
      verified,
      details: {
        sanitizedDispatch: { requestKeys, argumentKeys, authorityKeysPresent },
        dispatchCount,
        delivery: delivered.action.delivery,
        sessionGrantProjected,
        staleRefCode: staleRef.code,
        foreignOwnerCode: foreignOwner.code,
        forgedAuthorityCode: forgedAuthority.code,
        forgedAuthorityReason: forgedAuthority.reason,
        policyAuditDecisions: policyAudit.map((event) => event.decision),
      },
    };
  } finally {
    await runtime.endRun(identity).catch(() => undefined);
    runs.clear();
  }
}

function policyDecision(
  service: SurfaceOrganizationPolicyService,
  input: Parameters<SurfaceOrganizationPolicyService['evaluate']>[0],
): SurfaceOrganizationPolicyDecisionV1 {
  return service.evaluate(input);
}

function verifyOrganizationPolicy(): {
  verified: boolean;
  details: SurfaceExecutionP2AcceptanceResultV1['details']['organizationPolicy'];
} {
  let now = 20_000;
  let id = 0;
  const policy = new SurfaceOrganizationPolicyService({
    now: () => now,
    createId: (kind) => `p2-policy-${kind}-${++id}`,
  });
  const registry = new SurfaceProviderRegistry();
  const browser = registry.describe('system-chrome-cdp');
  const computer = registry.describe('cua-driver');
  assert(browser && computer, 'P2 policy acceptance could not resolve current providers');
  policy.setPolicy({
    version: 1,
    organizationId: 'p2-policy-organization',
    domains: {
      defaultDecision: 'deny',
      allow: ['policy.example.test', '*.policy.example.test'],
      deny: ['blocked.policy.example.test'],
    },
    apps: {
      defaultDecision: 'deny',
      allow: ['com.example.editor'],
      deny: ['com.example.unsafe'],
    },
    profileAccount: {
      allowedProfileRefs: ['profile:work', 'profile:reviewer'],
      allowedAccountRefs: ['account:editor', 'account:reviewer'],
    },
    highRisk: { allowedCapabilities: [], allowedOperations: [] },
    approval: { requiredCapabilities: ['input', 'navigate', 'file', 'secret', 'destructive'] },
    retention: { auditTtlMs: 50 },
  });
  const browserInput = (profileRef: string, accountRef: string) => ({
    organizationId: 'p2-policy-organization',
    provider: browser,
    operation: 'screenshot',
    capabilities: ['observe'] as const,
    risk: 'read' as const,
    target: { domain: 'sub.policy.example.test', profileRef, accountRef },
  });
  const profileWork = policyDecision(policy, browserInput('profile:work', 'account:editor'));
  const profileReviewer = policyDecision(policy, browserInput('profile:reviewer', 'account:reviewer'));
  const profileDenied = policyDecision(policy, browserInput('profile:personal', 'account:editor'));
  const missingProfileDenied = policyDecision(policy, browserInput('', 'account:editor'));
  const missingAccountDenied = policyDecision(policy, browserInput('profile:work', ''));
  const foreignAccountDenied = policyDecision(
    policy,
    browserInput('profile:work', 'account:personal'),
  );
  const domainDenied = policyDecision(policy, {
    ...browserInput('profile:work', 'account:editor'),
    target: { domain: 'blocked.policy.example.test', profileRef: 'profile:work' },
  });
  const appAllowed = policyDecision(policy, {
    organizationId: 'p2-policy-organization',
    provider: computer,
    operation: 'observe',
    capabilities: ['observe'],
    risk: 'read',
    target: { appId: 'com.example.editor' },
  });
  const appDenied = policyDecision(policy, {
    organizationId: 'p2-policy-organization',
    provider: computer,
    operation: 'observe',
    capabilities: ['observe'],
    risk: 'read',
    target: { appId: 'com.example.unsafe' },
  });
  const audit = policy.exportRedactedAudit({ organizationId: 'p2-policy-organization' });
  const auditText = JSON.stringify(audit);
  const auditMetadataRedacted = audit.every((event) => (
    event.metadata.redactionStatus === 'redacted'
  ));
  const rawScopeAbsent = [
    'p2-policy-organization',
    'policy.example.test',
    'profile:work',
    'profile:reviewer',
    'account:editor',
    'com.example.editor',
  ].every((raw) => !auditText.includes(raw));
  now += 50;
  const purged = policy.purgeExpired();
  const auditAfterRetention = policy.listAudit({ organizationId: 'p2-policy-organization' });
  const verified = profileWork.decision === 'allow'
    && profileReviewer.decision === 'allow'
    && profileDenied.reason === 'profile_scope_denied'
    && missingProfileDenied.reason === 'profile_scope_denied'
    && missingAccountDenied.reason === 'account_scope_denied'
    && foreignAccountDenied.reason === 'account_scope_denied'
    && domainDenied.reason === 'domain_denied'
    && appAllowed.decision === 'allow'
    && appDenied.reason === 'app_denied'
    && audit.length === 9
    && auditMetadataRedacted
    && rawScopeAbsent
    && purged.audits === audit.length
    && auditAfterRetention.length === 0;
  assert(verified, 'Organization domain/app/profile/audit/retention behavior was not verified');
  return {
    verified,
    details: {
      domainAllowDecisions: [profileWork.decision, profileReviewer.decision],
      profileDeniedReason: profileDenied.reason,
      missingProfileDeniedReason: missingProfileDenied.reason,
      missingAccountDeniedReason: missingAccountDenied.reason,
      foreignAccountDeniedReason: foreignAccountDenied.reason,
      domainDeniedReason: domainDenied.reason,
      appAllowDecision: appAllowed.decision,
      appDeniedReason: appDenied.reason,
      auditEventsBeforeRetention: audit.length,
      auditMetadataRedacted,
      rawScopeAbsent,
      retentionPurgedAudits: purged.audits,
      auditEventsAfterRetention: auditAfterRetention.length,
    },
  };
}

function providerRegistration(): SurfaceProviderRegistrationV1 {
  return {
    version: 1,
    providerId: 'vendor:p2-neutral-browser',
    providerClass: 'multi-browser',
    executionSurface: 'browser',
    availability: 'available',
    capabilities: ['observe'],
    operations: ['screenshot'],
    boundaries: {
      target: {
        kind: 'browser-tab-document',
        authority: 'host-issued',
        revisionRequired: true,
      },
      input: {
        delivery: 'host-mediated',
        rawAuthority: 'forbidden',
        secretTransport: 'reference-only',
        maxPayloadBytes: 1_024,
      },
      cleanup: {
        owner: 'provider',
        obligations: ['close-provider-context'],
        failureCode: 'SURFACE_CLEANUP_FAILED',
      },
    },
  };
}

function verifyProviderRegistry(): {
  verified: boolean;
  details: SurfaceExecutionP2AcceptanceResultV1['details']['providerRegistry'];
} {
  const registry = new SurfaceProviderRegistry([]);
  const registration = providerRegistration();
  registry.register(registration);
  const selected = registry.resolveForExecution({
    providerId: registration.providerId,
    surface: 'browser',
    operation: 'screenshot',
    requiredCapabilities: ['observe'],
    payloadBytes: 128,
  });
  const capabilityFailureReason = registryFailure(() => registry.resolveForExecution({
    providerId: registration.providerId,
    surface: 'browser',
    operation: 'screenshot',
    requiredCapabilities: ['input'],
    payloadBytes: 128,
  }));
  const surfaceFailureReason = registryFailure(() => registry.resolveForExecution({
    providerId: registration.providerId,
    surface: 'computer',
    operation: 'screenshot',
    requiredCapabilities: ['observe'],
    payloadBytes: 128,
  }));
  const unknownProviderFailureReason = registryFailure(() => registry.resolveForExecution({
    providerId: 'vendor:p2-unknown',
    surface: 'browser',
    operation: 'screenshot',
    requiredCapabilities: ['observe'],
    payloadBytes: 128,
  }));
  let duplicateRegistrationRejected = false;
  try {
    registry.register(registration);
  } catch {
    duplicateRegistrationRejected = true;
  }
  const defaultRegistry = new SurfaceProviderRegistry();
  const defaultProviders = defaultRegistry.list();
  const productionProviderIds = defaultProviders
    .filter((provider) => provider.availability === 'available')
    .map((provider) => provider.providerId);
  const gatedProviders = defaultProviders
    .filter((provider) => provider.availability === 'gated');
  const gatedProviderIds = gatedProviders.map((provider) => provider.providerId);
  const gatedProviderFailureReasons = Object.fromEntries(gatedProviders.map((provider) => [
    provider.providerId,
    registryFailure(() => defaultRegistry.resolveForExecution({
      providerId: provider.providerId,
      surface: provider.executionSurface,
      operation: provider.operations[0],
      requiredCapabilities: provider.capabilities.slice(0, 1),
      payloadBytes: 1,
    })),
  ]));
  const g4DecisionRows = SURFACE_PROVIDER_G4_DECISIONS_V1.map((decision) => decision.row);
  const g4DecisionEvidenceComplete = SURFACE_PROVIDER_G4_DECISIONS_V1.every((decision) => (
    decision.status === 'evidence-backed-defer'
    && decision.gate === 'G4'
    && decision.reason.trim().length > 0
    && decision.evidenceRequired.length > 0
    && decision.evidenceRequired.every((item) => item.trim().length > 0)
  ));
  const verified = registry.list().length === 1
    && selected.providerClass === 'multi-browser'
    && selected.boundaries.target.authority === 'host-issued'
    && selected.boundaries.input.delivery === 'host-mediated'
    && selected.boundaries.input.rawAuthority === 'forbidden'
    && selected.boundaries.cleanup.owner === 'provider'
    && selected.boundaries.cleanup.obligations.includes('close-provider-context')
    && capabilityFailureReason === 'capability_unsupported'
    && surfaceFailureReason === 'surface_mismatch'
    && unknownProviderFailureReason === 'provider_not_registered'
    && duplicateRegistrationRejected
    && JSON.stringify(productionProviderIds) === JSON.stringify([
      'browser-relay',
      'cua-driver',
      'system-chrome-cdp',
    ])
    && JSON.stringify(gatedProviderIds) === JSON.stringify([
      'future:in-app-preview',
      'future:mobile',
      'future:multi-browser',
      'future:remote-managed',
    ])
    && Object.values(gatedProviderFailureReasons).every((reason) => (
      reason === 'provider_gate_pending'
    ))
    && gatedProviders.every((provider) => (
      provider.decisionGate === 'G4' && Boolean(provider.deferReason?.trim())
    ))
    && g4DecisionRows.length === 5
    && g4DecisionEvidenceComplete;
  assert(verified, 'Provider-neutral registry behavior did not satisfy capability and ownership fences');
  return {
    verified,
    details: {
      registeredProviderClass: selected.providerClass,
      selectedProviderId: selected.providerId,
      selectedCapabilities: selected.capabilities,
      targetAuthority: selected.boundaries.target.authority,
      cleanupOwner: selected.boundaries.cleanup.owner,
      capabilityFailureReason,
      surfaceFailureReason,
      unknownProviderFailureReason,
      duplicateRegistrationRejected,
      productionProviderIds,
      gatedProviderIds,
      gatedProviderFailureReasons,
      g4DecisionRows,
      g4DecisionEvidenceComplete,
    },
  };
}

function providerEvidenceObserved(row: string): string[] {
  const providerId = PROVIDER_ID_BY_G4_DECISION_ROW[
    row as keyof typeof PROVIDER_ID_BY_G4_DECISION_ROW
  ];
  if (providerId) {
    return [
      `provider-registry:${providerId}:api-boundary-declared`,
      `provider-registry:${providerId}:gate-pending-enforced`,
      `p2-acceptance:details.providerRegistry.gatedProviderFailureReasons.${providerId}`,
    ];
  }
  assert(
    row === WINDOWS_LINUX_PROVIDER_ROW,
    `P2 acceptance has no truthful evidence source for provider decision row ${row}`,
  );
  return [
    'repository:no-approved-windows-linux-provider-or-helper',
    `runtime:current-acceptance-host-${process.platform}`,
    'truth-source:G4-cross-platform-provider-decision',
  ];
}

function providerImplementationDefers(): SurfaceExecutionP2DeferV1[] {
  return SURFACE_PROVIDER_G4_DECISIONS_V1.map((decision) => ({
    ...decision,
    evidenceObserved: providerEvidenceObserved(decision.row),
  }));
}

function providerImplementationDefersAreExact(
  defers: readonly SurfaceExecutionP2DeferV1[],
  registry: SurfaceExecutionP2AcceptanceResultV1['details']['providerRegistry'],
): boolean {
  if (defers.length !== SURFACE_PROVIDER_G4_DECISIONS_V1.length) return false;
  return SURFACE_PROVIDER_G4_DECISIONS_V1.every((decision, index) => {
    const defer = defers[index];
    if (!defer
      || defer.row !== decision.row
      || defer.status !== decision.status
      || defer.gate !== decision.gate
      || defer.reason !== decision.reason
      || JSON.stringify(defer.evidenceRequired) !== JSON.stringify(decision.evidenceRequired)
      || JSON.stringify(defer.evidenceObserved) !== JSON.stringify(
        providerEvidenceObserved(decision.row),
      )) {
      return false;
    }
    const providerId = PROVIDER_ID_BY_G4_DECISION_ROW[
      decision.row as keyof typeof PROVIDER_ID_BY_G4_DECISION_ROW
    ];
    return providerId
      ? registry.gatedProviderIds.includes(providerId)
        && registry.gatedProviderFailureReasons[providerId] === 'provider_gate_pending'
      : decision.row === WINDOWS_LINUX_PROVIDER_ROW
        && !registry.gatedProviderIds.some((id) => id.includes('windows') || id.includes('linux'));
  });
}

function p2Defers(): SurfaceExecutionP2AcceptanceResultV1['evidenceBackedDefers'] {
  return {
    externalProductionEntrypoints: {
      row: 'external-agent-production-entrypoints',
      status: 'evidence-backed-defer',
      gate: 'G4',
      reason: 'The Host authority fence is implemented, but no authenticated transport, Host bootstrap, or public CLI contract exists for callable neo surface / neo browser entrypoints.',
      evidenceObserved: [
        'external-authority-fence-contract-verified',
        'production-entrypoint-registration-absent',
        'provider-runtime-must-remain-single-owner',
      ],
      evidenceRequired: [
        'approved-external-consumer-and-authentication-contract',
        'host-owned-run-session-provider-bootstrap',
        'real-provider-entrypoint-e2e-with-cleanup-and-redaction',
      ],
    },
    organizationProductionStore: {
      row: 'organization-policy-production-store',
      status: 'evidence-backed-defer',
      gate: 'G4',
      reason: 'The deny-by-default policy engine, approvals, redacted audit, and TTL are verified through ExternalSurfaceAgentAdapter and the P2 acceptance seam only; Managed, Relay, and Computer production bootstrap/enforcement are not wired, and the default audit store remains process-local.',
      evidenceObserved: [
        'external-surface-agent-adapter-policy-enforcement-verified',
        'p2-acceptance-policy-seam-verified',
        'managed-relay-computer-production-policy-bootstrap-and-enforcement-absent',
        'redacted-audit-retention-verified',
        'default-audit-store-is-process-local',
      ],
      evidenceRequired: [
        'host-owned-organization-identity-and-policy-bootstrap-for-managed-relay-computer',
        'real-managed-relay-computer-provider-policy-enforcement-e2e',
        'organization-admin-contract',
        'persistent-audit-store-and-migration',
        'retention-access-control-and-deletion-e2e',
      ],
    },
    providerImplementations: providerImplementationDefers(),
  };
}

export async function runSurfaceExecutionP2Acceptance(): Promise<SurfaceExecutionP2AcceptanceResultV1> {
  const externalAdapter = await verifyExternalAdapter();
  const organizationPolicy = verifyOrganizationPolicy();
  const providerRegistry = verifyProviderRegistry();
  const evidenceBackedDefers = p2Defers();
  const providerImplementationDefersExact = providerImplementationDefersAreExact(
    evidenceBackedDefers.providerImplementations,
    providerRegistry.details,
  );
  assert(
    providerImplementationDefersExact,
    'Provider implementation defers do not exactly match the five G4 decisions and evidence sources',
  );
  return {
    version: 1,
    assertions: {
      externalSurfaceAdapterContractVerified: externalAdapter.verified,
      organizationPolicyAuditRetentionVerified: organizationPolicy.verified,
      providerNeutralRegistryContractVerified: providerRegistry.verified,
      providerImplementationDefersExact,
    },
    details: {
      externalAdapter: externalAdapter.details,
      organizationPolicy: organizationPolicy.details,
      providerRegistry: providerRegistry.details,
    },
    evidenceBackedDefers,
  };
}
