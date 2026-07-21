import { describe, expect, it } from 'vitest';
import {
  SurfaceOrganizationPolicyService,
  createDefaultDenySurfaceOrganizationPolicy,
  type SurfaceOrganizationPolicyV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceOrganizationPolicyService';
import { SurfaceProviderRegistry } from '../../../../src/host/services/surfaceExecution/SurfaceProviderRegistry';

function organizationPolicy(
  overrides: Partial<SurfaceOrganizationPolicyV1> = {},
): SurfaceOrganizationPolicyV1 {
  return {
    version: 1,
    organizationId: 'organization-1',
    domains: {
      defaultDecision: 'deny',
      allow: ['example.test', '*.example.test'],
      deny: ['blocked.example.test'],
    },
    apps: {
      defaultDecision: 'deny',
      allow: ['com.example.editor'],
      deny: ['com.example.unsafe'],
    },
    profileAccount: {
      allowedProfileRefs: ['profile:work'],
      allowedAccountRefs: ['account:editor'],
    },
    highRisk: {
      allowedCapabilities: [],
      allowedOperations: [],
    },
    approval: {
      requiredCapabilities: ['input', 'navigate', 'file', 'secret', 'destructive'],
    },
    retention: { auditTtlMs: 60_000 },
    ...overrides,
  };
}

describe('SurfaceOrganizationPolicyService', () => {
  const providers = new SurfaceProviderRegistry();
  const browser = providers.describe('system-chrome-cdp')!;
  const computer = providers.describe('cua-driver')!;

  it('defaults to deny and enforces organization domain, app, profile, and account scopes', () => {
    const service = new SurfaceOrganizationPolicyService();
    const noPolicy = service.evaluate({
      organizationId: 'organization-1',
      provider: browser,
      operation: 'screenshot',
      capabilities: ['observe'],
      risk: 'read',
      target: { domain: 'example.test' },
    });
    expect(noPolicy).toMatchObject({
      decision: 'deny',
      reason: 'policy_not_configured',
      errorCode: 'SURFACE_POLICY_BLOCKED',
    });

    service.setPolicy(organizationPolicy());
    expect(service.evaluate({
      organizationId: 'organization-1',
      provider: browser,
      operation: 'screenshot',
      capabilities: ['observe'],
      risk: 'read',
      target: {
        domain: 'https://sub.example.test/page',
        profileRef: 'profile:work',
        accountRef: 'account:editor',
      },
    })).toMatchObject({ decision: 'allow', reason: 'allowed' });
    expect(service.evaluate({
      organizationId: 'organization-1',
      provider: computer,
      operation: 'observe',
      capabilities: ['observe'],
      risk: 'read',
      target: { appId: 'com.example.editor' },
    })).toMatchObject({ decision: 'allow' });

    expect(service.evaluate({
      organizationId: 'organization-1',
      provider: browser,
      operation: 'screenshot',
      capabilities: ['observe'],
      risk: 'read',
      target: { domain: 'example.test' },
    })).toMatchObject({
      decision: 'deny',
      reason: 'profile_scope_denied',
      errorCode: 'SURFACE_POLICY_BLOCKED',
    });
    expect(service.evaluate({
      organizationId: 'organization-1',
      provider: browser,
      operation: 'screenshot',
      capabilities: ['observe'],
      risk: 'read',
      target: { domain: 'example.test', profileRef: 'profile:work' },
    })).toMatchObject({
      decision: 'deny',
      reason: 'account_scope_denied',
      errorCode: 'SURFACE_POLICY_BLOCKED',
    });
    expect(service.evaluate({
      organizationId: 'organization-1',
      provider: browser,
      operation: 'screenshot',
      capabilities: ['observe'],
      risk: 'read',
      target: {
        domain: 'example.test',
        profileRef: 'profile:work',
        accountRef: 'account:outside',
      },
    })).toMatchObject({
      decision: 'deny',
      reason: 'account_scope_denied',
      errorCode: 'SURFACE_POLICY_BLOCKED',
    });
    expect(service.evaluate({
      organizationId: 'organization-1',
      provider: browser,
      operation: 'screenshot',
      capabilities: ['observe'],
      risk: 'read',
      target: { domain: 'blocked.example.test' },
    })).toMatchObject({ decision: 'deny', reason: 'domain_denied' });
    expect(service.evaluate({
      organizationId: 'organization-1',
      provider: browser,
      operation: 'screenshot',
      capabilities: ['observe'],
      risk: 'read',
      target: { domain: 'example.test', profileRef: 'profile:personal' },
    })).toMatchObject({ decision: 'deny', reason: 'profile_scope_denied' });
    expect(service.evaluate({
      organizationId: 'organization-1',
      provider: computer,
      operation: 'observe',
      capabilities: ['observe'],
      risk: 'read',
      target: { appId: 'com.example.unsafe' },
    })).toMatchObject({ decision: 'deny', reason: 'app_denied' });
  });

  it('denies high-risk capability by default and requires an exact Host approval when enabled', () => {
    let id = 0;
    const service = new SurfaceOrganizationPolicyService({
      now: () => 10_000,
      createId: (kind) => `${kind}-${++id}`,
    });
    service.setPolicy(organizationPolicy());
    expect(service.evaluate({
      organizationId: 'organization-1',
      provider: browser,
      operation: 'import_profile_cookies',
      capabilities: ['input', 'file', 'secret'],
      risk: 'browser_action',
      target: {
        domain: 'example.test',
        profileRef: 'profile:work',
        accountRef: 'account:editor',
      },
    })).toMatchObject({
      decision: 'deny',
      reason: 'high_risk_denied',
      errorCode: 'SURFACE_POLICY_BLOCKED',
    });

    service.setPolicy(organizationPolicy({
      highRisk: {
        allowedCapabilities: ['file', 'secret'],
        allowedOperations: ['import_profile_cookies'],
      },
    }));
    const request = {
      organizationId: 'organization-1',
      provider: browser,
      operation: 'import_profile_cookies',
      capabilities: ['input', 'file', 'secret'] as const,
      risk: 'browser_action' as const,
      target: {
        domain: 'example.test',
        profileRef: 'profile:work',
        accountRef: 'account:editor',
      },
    };
    expect(service.evaluate(request)).toMatchObject({
      decision: 'deny',
      reason: 'approval_required',
      errorCode: 'SURFACE_APPROVAL_REQUIRED',
    });
    const approval = service.issueApproval({
      ...request,
      capabilities: [...request.capabilities],
      ttlMs: 5_000,
    });
    expect(service.evaluate({ ...request, approvalRef: approval.approvalRef }))
      .toMatchObject({ decision: 'allow', reason: 'allowed' });
    expect(service.evaluate({ ...request, approvalRef: approval.approvalRef }))
      .toMatchObject({ decision: 'deny', reason: 'approval_invalid' });
  });

  it('keeps approval audit and diagnostic/export projection metadata redacted', () => {
    let id = 0;
    const service = new SurfaceOrganizationPolicyService({
      now: () => 20_000,
      createId: (kind) => `${kind}-${++id}`,
    });
    const canary = 'surface-secret-canary-enterprise';
    service.setPolicy(organizationPolicy({
      organizationId: `${canary}-organization`,
      domains: {
        defaultDecision: 'deny',
        allow: [`${canary}.example.test`],
        deny: [],
      },
      profileAccount: {
        allowedProfileRefs: [`${canary}-profile`],
        allowedAccountRefs: [`${canary}-account`],
      },
    }));
    const target = {
      domain: `${canary}.example.test`,
      profileRef: `${canary}-profile`,
      accountRef: `${canary}-account`,
    };
    const approval = service.issueApproval({
      organizationId: `${canary}-organization`,
      provider: browser,
      operation: 'click',
      capabilities: ['input'],
      target,
      ttlMs: 5_000,
    });
    service.evaluate({
      organizationId: `${canary}-organization`,
      provider: browser,
      operation: 'click',
      capabilities: ['input'],
      risk: 'browser_action',
      target,
      approvalRef: approval.approvalRef,
    });

    const audit = service.exportRedactedAudit({ organizationId: `${canary}-organization` });
    expect(audit.map((event) => event.event)).toEqual(['approval_issued', 'policy_evaluation']);
    expect(audit.every((event) => event.metadata.redactionStatus === 'redacted')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(canary);
    expect(JSON.stringify(audit)).not.toContain(approval.approvalRef);
    expect(JSON.stringify(audit)).not.toContain('example.test');
  });

  it('expires audit and approval records according to the configured retention boundary', () => {
    let now = 1_000;
    let id = 0;
    const service = new SurfaceOrganizationPolicyService({
      now: () => now,
      createId: (kind) => `${kind}-${++id}`,
    });
    service.setPolicy(organizationPolicy({ retention: { auditTtlMs: 10 } }));
    service.evaluate({
      organizationId: 'organization-1',
      provider: browser,
      operation: 'screenshot',
      capabilities: ['observe'],
      risk: 'read',
      target: { domain: 'example.test' },
    });
    expect(service.listAudit()).toHaveLength(1);

    now = 1_010;
    expect(service.purgeExpired()).toEqual({ audits: 1, approvals: 0 });
    expect(service.listAudit()).toEqual([]);
  });

  it('provides a reusable default-deny policy template', () => {
    expect(createDefaultDenySurfaceOrganizationPolicy('organization-1')).toMatchObject({
      organizationId: 'organization-1',
      domains: { defaultDecision: 'deny', allow: [] },
      apps: { defaultDecision: 'deny', allow: [] },
      highRisk: { allowedCapabilities: [], allowedOperations: [] },
      approval: {
        requiredCapabilities: expect.arrayContaining(['input', 'secret', 'destructive']),
      },
    });
  });
});
