import { describe, expect, it } from 'vitest';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import {
  ExternalSurfaceAgentAdapter,
  type ExternalBrowserHostAuthorityV1,
} from '../../../../src/host/services/surfaceExecution/ExternalSurfaceAgentAdapter';
import { SurfaceExecutionRuntime } from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { SurfaceOrganizationPolicyService } from '../../../../src/host/services/surfaceExecution/SurfaceOrganizationPolicyService';
import { SurfaceProviderRegistry } from '../../../../src/host/services/surfaceExecution/SurfaceProviderRegistry';
import type { SurfaceTargetRefV1 } from '../../../../src/shared/contract/surfaceExecution';

const browserTarget: Extract<SurfaceTargetRefV1, { kind: 'browser' }> = {
  kind: 'browser',
  browserInstanceId: 'managed:external-agent',
  windowRef: 'window:host-owned',
  tabRef: 'tab:host-owned',
  origin: 'https://example.test',
  documentRevision: 'document:host-owned:1',
  title: 'External adapter fixture',
};

function createHarness() {
  const runs = new RunRegistry();
  runs.start({
    runId: 'run-1',
    sessionId: 'conversation-1',
    workspace: process.cwd(),
  });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: runs });
  const providers = new SurfaceProviderRegistry();
  const policy = new SurfaceOrganizationPolicyService({
    createId: (() => {
      let id = 0;
      return (kind: 'audit' | 'approval') => `${kind}-${++id}`;
    })(),
  });
  policy.setPolicy({
    version: 1,
    organizationId: 'organization-1',
    domains: { defaultDecision: 'deny', allow: ['example.test'], deny: [] },
    apps: { defaultDecision: 'deny', allow: ['com.example.editor'], deny: [] },
    profileAccount: { allowedProfileRefs: [], allowedAccountRefs: [] },
    highRisk: { allowedCapabilities: [], allowedOperations: ['act'] },
    approval: { requiredCapabilities: ['input', 'navigate', 'file', 'secret', 'destructive'] },
    retention: { auditTtlMs: 60_000 },
  });
  const adapter = new ExternalSurfaceAgentAdapter({
    runtime,
    providers,
    policy,
    createOperationId: () => 'external-operation-1',
  });
  const identity = {
    conversationId: 'conversation-1',
    runId: 'run-1',
    agentId: 'agent-a',
  };
  return { runtime, providers, policy, adapter, identity };
}

function prepareBrowserHarness() {
  const harness = createHarness();
  const prepared = harness.runtime.prepareBrowserSession({ identity: harness.identity });
  const observed = harness.runtime.recordBrowserObservation({
    identity: harness.identity,
    surfaceSessionId: prepared.session.sessionId,
    target: browserTarget,
    providerGeneration: 'managed:external-adapter:1',
    elements: [{
      kind: 'browser-element',
      ref: 'element:host-issued',
      tabRef: browserTarget.tabRef,
      documentRevision: browserTarget.documentRevision,
      backendNodeId: 42,
    }],
    evidenceAssetIds: ['evidence:before'],
  });
  let dispatches = 0;
  const authority: ExternalBrowserHostAuthorityV1 = {
    surface: 'browser',
    identity: harness.identity,
    providerId: 'system-chrome-cdp',
    organizationId: 'organization-1',
    policyTarget: { domain: 'example.test' },
    surfaceSessionId: prepared.session.sessionId,
    predecessorStateId: observed.observation.stateId,
    async dispatch(_signal, subject, request) {
      dispatches += 1;
      expect(subject).toMatchObject({
        sessionId: prepared.session.sessionId,
        runId: 'run-1',
        agentId: 'agent-a',
      });
      expect(request).toEqual({
        version: 1,
        entrypoint: 'neo browser',
        operation: 'screenshot',
        arguments: { action: 'screenshot' },
      });
      return {
        providerResult: { screenshotRef: 'artifact:screenshot' },
        outcome: {
          delivery: 'confirmed',
          verification: 'not_requested',
          evidenceRefs: ['evidence:after'],
        },
      };
    },
  };
  return { ...harness, prepared, observed, authority, dispatches: () => dispatches };
}

describe('ExternalSurfaceAgentAdapter', () => {
  it('routes neo browser through the existing Session, Grant, Observation, Action, and Event runtime', async () => {
    const harness = prepareBrowserHarness();
    const result = await harness.adapter.invoke(harness.authority, {
      version: 1,
      entrypoint: 'neo browser',
      operation: 'screenshot',
      arguments: {},
    });

    expect(result).toMatchObject({
      version: 1,
      entrypoint: 'neo browser',
      surface: 'browser',
      provider: 'system-chrome-cdp',
      session: {
        sessionId: harness.prepared.session.sessionId,
        runId: 'run-1',
        agentId: 'agent-a',
      },
      action: {
        operationId: 'external-operation-1',
        predecessorStateId: harness.observed.observation.stateId,
        delivery: 'confirmed',
        verification: 'not_requested',
        overall: 'delivered_unverified',
        evidenceRefs: ['evidence:after'],
      },
      providerResult: { screenshotRef: 'artifact:screenshot' },
    });
    expect(result.events.map((event) => event.phase)).toEqual(['observe', 'observe']);
    expect(harness.dispatches()).toBe(1);
    expect(JSON.stringify(result.session)).not.toContain('grantId');
    expect(harness.runtime.sessions.get(harness.prepared.session.sessionId)?.grantId).toBeTruthy();
    expect(harness.policy.listAudit()).toContainEqual(expect.objectContaining({
      decision: 'allow',
      operation: 'screenshot',
      metadata: expect.objectContaining({ redactionStatus: 'redacted' }),
    }));
  });

  it('accepts only a current Host-issued element ref and hands sanitized action arguments to the provider', async () => {
    const harness = prepareBrowserHarness();
    const provider = harness.providers.describe('system-chrome-cdp')!;
    const approval = harness.policy.issueApproval({
      organizationId: 'organization-1',
      provider,
      operation: 'click',
      capabilities: ['input'],
      target: { domain: 'example.test' },
      ttlMs: 30_000,
    });
    let providerRequest: unknown;

    const result = await harness.adapter.invoke({
      ...harness.authority,
      approvalRef: approval.approvalRef,
      async dispatch(_signal, _subject, request) {
        providerRequest = request;
        return {
          providerResult: { clicked: true },
          outcome: { delivery: 'confirmed', verification: 'not_requested' },
        };
      },
    }, {
      version: 1,
      entrypoint: 'neo browser',
      operation: 'click',
      arguments: { targetRef: 'element:host-issued' },
    });

    expect(result.action).toMatchObject({ delivery: 'confirmed' });
    expect(providerRequest).toEqual({
      version: 1,
      entrypoint: 'neo browser',
      operation: 'click',
      arguments: { action: 'click', targetRef: 'element:host-issued' },
    });

    const staleApproval = harness.policy.issueApproval({
      organizationId: 'organization-1',
      provider,
      operation: 'click',
      capabilities: ['input'],
      target: { domain: 'example.test' },
      ttlMs: 30_000,
    });
    await expect(harness.adapter.invoke({
      ...harness.authority,
      approvalRef: staleApproval.approvalRef,
    }, {
      version: 1,
      entrypoint: 'neo browser',
      operation: 'click',
      arguments: { targetRef: 'element:foreign-or-stale' },
    })).rejects.toMatchObject({
      surfaceError: { code: 'SURFACE_ELEMENT_REF_NOT_FOUND' },
    });
  });

  it('rejects external owner, grant, lease, session, tab, window, and raw target authority before dispatch', async () => {
    const harness = prepareBrowserHarness();
    const forbiddenPayloads = [
      { agentId: 'agent-a' },
      { arguments: { grantId: 'grant:forged' } },
      { arguments: { provider: 'browser-relay' } },
      { arguments: { leaseId: 'lease:forged' } },
      { arguments: { surfaceSessionId: harness.prepared.session.sessionId } },
      { arguments: { targetApp: 'com.example.unsafe' } },
      { arguments: { profileRef: 'profile:personal' } },
      { arguments: { target: { tabId: 7, windowId: 9 } } },
      { arguments: { targetRef: { tabRef: 'tab:forged' } } },
    ];

    for (const extra of forbiddenPayloads) {
      await expect(harness.adapter.invoke(harness.authority, {
        version: 1,
        entrypoint: 'neo browser',
        operation: 'screenshot',
        ...extra,
      } as never)).rejects.toMatchObject({
        surfaceError: {
          code: 'SURFACE_POLICY_BLOCKED',
          detailsSafe: { reason: 'external_authority_forbidden' },
        },
      });
    }
    expect(harness.dispatches()).toBe(0);
  });

  it('uses only Host-injected identity and preserves runtime cross-agent isolation', async () => {
    const harness = prepareBrowserHarness();
    let dispatches = 0;
    const foreignAuthority: ExternalBrowserHostAuthorityV1 = {
      ...harness.authority,
      identity: { ...harness.identity, agentId: 'agent-b' },
      async dispatch() {
        dispatches += 1;
        return { providerResult: {}, outcome: { delivery: 'confirmed' } };
      },
    };

    await expect(harness.adapter.invoke(foreignAuthority, {
      version: 1,
      entrypoint: 'neo surface',
      operation: 'screenshot',
    })).rejects.toMatchObject({
      surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' },
    });
    expect(dispatches).toBe(0);
  });

  it('routes neo surface Computer action through the same runtime with Host-only state and approval', async () => {
    const harness = createHarness();
    const prepared = harness.runtime.prepareComputerSession({ identity: harness.identity });
    const providerStateId = 'computer-provider-state-1';
    harness.runtime.recordComputerObservation({
      identity: harness.identity,
      surfaceSessionId: prepared.session.sessionId,
      state: {
        version: 1,
        stateId: providerStateId,
        root: {
          provider: 'cua-driver',
          pid: 42,
          windowId: 7,
          appName: 'Example Editor',
          title: 'Draft',
        },
        hostRevision: 1,
        observedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        elements: [{ ref: 'e1', role: 'AXButton', label: 'Save' }],
      },
      metadata: {
        providerGeneration: 'cua:external-adapter:1',
        providerSnapshotId: 'snapshot:1',
      },
    });
    const computerProvider = harness.providers.describe('cua-driver')!;
    const approval = harness.policy.issueApproval({
      organizationId: 'organization-1',
      provider: computerProvider,
      operation: 'act',
      capabilities: ['input'],
      target: { appId: 'com.example.editor' },
      ttlMs: 30_000,
    });
    let dispatches = 0;
    const result = await harness.adapter.invoke({
      surface: 'computer',
      identity: harness.identity,
      providerId: 'cua-driver',
      organizationId: 'organization-1',
      policyTarget: { appId: 'com.example.editor' },
      approvalRef: approval.approvalRef,
      surfaceSessionId: prepared.session.sessionId,
      providerStateId,
      async dispatch(_signal, subject) {
        dispatches += 1;
        expect(subject.sessionId).toBe(prepared.session.sessionId);
        return {
          providerResult: { delivered: true },
          outcome: { delivery: 'confirmed', verification: 'not_requested' },
        };
      },
    }, {
      version: 1,
      entrypoint: 'neo surface',
      operation: 'act',
      arguments: {
        mutation: { kind: 'click', elementRef: 'e1' },
      },
    });

    expect(result).toMatchObject({
      surface: 'computer',
      provider: 'cua-driver',
      session: { sessionId: prepared.session.sessionId, agentId: 'agent-a' },
      action: { delivery: 'confirmed', overall: 'delivered_unverified' },
    });
    expect(dispatches).toBe(1);
  });

  it('fails closed for entrypoint/surface mismatch and gated or unregistered providers', async () => {
    const harness = prepareBrowserHarness();
    await expect(harness.adapter.invoke({
      surface: 'computer',
      identity: harness.identity,
      providerId: 'cua-driver',
      organizationId: 'organization-1',
      policyTarget: { appId: 'com.example.editor' },
      surfaceSessionId: 'computer-session',
      providerStateId: 'computer-state',
      async dispatch() {
        return { providerResult: {}, outcome: { delivery: 'confirmed' } };
      },
    }, {
      version: 1,
      entrypoint: 'neo browser',
      operation: 'act',
    })).rejects.toMatchObject({
      surfaceError: {
        code: 'SURFACE_POLICY_BLOCKED',
        detailsSafe: { reason: 'entrypoint_surface_mismatch' },
      },
    });

    await expect(harness.adapter.invoke({
      ...harness.authority,
      providerId: 'future:remote-managed',
    }, {
      version: 1,
      entrypoint: 'neo surface',
      operation: 'screenshot',
    })).rejects.toMatchObject({
      surfaceError: {
        code: 'SURFACE_CAPABILITY_UNSUPPORTED',
        detailsSafe: { reason: 'provider_gate_pending' },
      },
    });
    expect(harness.dispatches()).toBe(0);
  });
});
