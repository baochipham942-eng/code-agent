import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runSurfaceExecutionP2Acceptance,
} from '../../../scripts/acceptance/surface-execution-p2-acceptance-core.ts';

describe('Surface Execution P2 durable acceptance', () => {
  it('verifies external dispatch, organization policy, and provider registry through real APIs', async () => {
    const result = await runSurfaceExecutionP2Acceptance();

    expect(result.assertions).toEqual({
      externalSurfaceAdapterContractVerified: true,
      organizationPolicyAuditRetentionVerified: true,
      providerNeutralRegistryContractVerified: true,
      providerImplementationDefersExact: true,
    });
    expect(result.details.externalAdapter).toMatchObject({
      sanitizedDispatch: {
        requestKeys: ['arguments', 'entrypoint', 'operation', 'version'],
        argumentKeys: ['action', 'targetRef'],
        authorityKeysPresent: false,
      },
      dispatchCount: 1,
      delivery: 'confirmed',
      sessionGrantProjected: false,
      staleRefCode: 'SURFACE_ELEMENT_REF_NOT_FOUND',
      foreignOwnerCode: 'SURFACE_TARGET_NOT_OWNED',
      forgedAuthorityCode: 'SURFACE_POLICY_BLOCKED',
      forgedAuthorityReason: 'external_authority_forbidden',
    });
    expect(result.details.organizationPolicy).toMatchObject({
      domainAllowDecisions: ['allow', 'allow'],
      profileDeniedReason: 'profile_scope_denied',
      missingProfileDeniedReason: 'profile_scope_denied',
      missingAccountDeniedReason: 'account_scope_denied',
      foreignAccountDeniedReason: 'account_scope_denied',
      domainDeniedReason: 'domain_denied',
      appAllowDecision: 'allow',
      appDeniedReason: 'app_denied',
      auditEventsBeforeRetention: 9,
      auditMetadataRedacted: true,
      rawScopeAbsent: true,
      retentionPurgedAudits: 9,
      auditEventsAfterRetention: 0,
    });
    expect(result.details.providerRegistry).toMatchObject({
      registeredProviderClass: 'multi-browser',
      selectedProviderId: 'vendor:p2-neutral-browser',
      selectedCapabilities: ['observe'],
      targetAuthority: 'host-issued',
      cleanupOwner: 'provider',
      capabilityFailureReason: 'capability_unsupported',
      surfaceFailureReason: 'surface_mismatch',
      unknownProviderFailureReason: 'provider_not_registered',
      duplicateRegistrationRejected: true,
      productionProviderIds: ['browser-relay', 'cua-driver', 'system-chrome-cdp'],
      gatedProviderIds: [
        'future:in-app-preview',
        'future:mobile',
        'future:multi-browser',
        'future:remote-managed',
      ],
      gatedProviderFailureReasons: {
        'future:in-app-preview': 'provider_gate_pending',
        'future:mobile': 'provider_gate_pending',
        'future:multi-browser': 'provider_gate_pending',
        'future:remote-managed': 'provider_gate_pending',
      },
      g4DecisionRows: [
        'multi-browser-provider',
        'remote-managed-browser-pool',
        'mobile-device-cloud',
        'windows-linux-profile-and-computer-provider',
        'in-app-preview-provider',
      ],
      g4DecisionEvidenceComplete: true,
    });
    expect(result.evidenceBackedDefers).toMatchObject({
      externalProductionEntrypoints: {
        row: 'external-agent-production-entrypoints',
        status: 'evidence-backed-defer',
        gate: 'G4',
        evidenceObserved: expect.arrayContaining([
          'external-authority-fence-contract-verified',
          'production-entrypoint-registration-absent',
        ]),
      },
      organizationProductionStore: {
        row: 'organization-policy-production-store',
        status: 'evidence-backed-defer',
        gate: 'G4',
        evidenceObserved: expect.arrayContaining([
          'external-surface-agent-adapter-policy-enforcement-verified',
          'p2-acceptance-policy-seam-verified',
          'managed-relay-computer-production-policy-bootstrap-and-enforcement-absent',
          'default-audit-store-is-process-local',
        ]),
        evidenceRequired: expect.arrayContaining([
          'host-owned-organization-identity-and-policy-bootstrap-for-managed-relay-computer',
          'real-managed-relay-computer-provider-policy-enforcement-e2e',
        ]),
      },
    });
    expect(result.evidenceBackedDefers.providerImplementations).toHaveLength(5);
    expect(result.evidenceBackedDefers.providerImplementations.every((defer) => (
      defer.status === 'evidence-backed-defer'
      && defer.gate === 'G4'
      && defer.row.length > 0
      && defer.reason.length > 0
      && defer.evidenceObserved.length > 0
      && defer.evidenceRequired.length > 0
    ))).toBe(true);
    expect(result.evidenceBackedDefers.providerImplementations.map((defer) => (
      [defer.row, defer.evidenceObserved]
    ))).toEqual([
      ['multi-browser-provider', [
        'provider-registry:future:multi-browser:api-boundary-declared',
        'provider-registry:future:multi-browser:gate-pending-enforced',
        'p2-acceptance:details.providerRegistry.gatedProviderFailureReasons.future:multi-browser',
      ]],
      ['remote-managed-browser-pool', [
        'provider-registry:future:remote-managed:api-boundary-declared',
        'provider-registry:future:remote-managed:gate-pending-enforced',
        'p2-acceptance:details.providerRegistry.gatedProviderFailureReasons.future:remote-managed',
      ]],
      ['mobile-device-cloud', [
        'provider-registry:future:mobile:api-boundary-declared',
        'provider-registry:future:mobile:gate-pending-enforced',
        'p2-acceptance:details.providerRegistry.gatedProviderFailureReasons.future:mobile',
      ]],
      ['windows-linux-profile-and-computer-provider', [
        'repository:no-approved-windows-linux-provider-or-helper',
        `runtime:current-acceptance-host-${process.platform}`,
        'truth-source:G4-cross-platform-provider-decision',
      ]],
      ['in-app-preview-provider', [
        'provider-registry:future:in-app-preview:api-boundary-declared',
        'provider-registry:future:in-app-preview:gate-pending-enforced',
        'p2-acceptance:details.providerRegistry.gatedProviderFailureReasons.future:in-app-preview',
      ]],
    ]);
    const serialized = JSON.stringify(result.details.organizationPolicy);
    expect(serialized).not.toContain('p2-policy-organization');
    expect(serialized).not.toContain('profile:work');
    expect(serialized).not.toContain('policy.example.test');
  });

  it('projects API-derived P2 assertions and evidence into the durable recover phase', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'scripts/acceptance/surface-execution-durable-restart-smoke.ts',
    ), 'utf8');
    const recoverPhase = source.slice(
      source.indexOf('async function recoverPhase'),
      source.indexOf('function runChildPhase'),
    );

    expect(recoverPhase).toContain('await runSurfaceExecutionP2Acceptance()');
    expect(recoverPhase).toContain('Object.values(p2Acceptance.assertions).every(Boolean)');
    expect(recoverPhase).toContain('...p2Acceptance.assertions');
    expect(recoverPhase).toContain('p2Acceptance,');
    expect(source).toContain('p2Acceptance: recoverDetails.p2Acceptance');
  });
});
