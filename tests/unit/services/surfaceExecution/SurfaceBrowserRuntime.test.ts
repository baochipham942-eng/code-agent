import { describe, expect, it } from 'vitest';
import type { SurfaceTargetRefV1 } from '../../../../src/shared/contract/surfaceExecution';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
  type SurfaceTakeoverControlV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';

const managedTarget: Extract<SurfaceTargetRefV1, { kind: 'browser' }> = {
  kind: 'browser',
  browserInstanceId: 'browser:managed-profile',
  windowRef: 'window:managed-agent',
  tabRef: 'tab:managed-one',
  origin: 'https://example.test',
  documentRevision: 'document:1',
  title: 'Example',
};

const relayTarget: Extract<SurfaceTargetRefV1, { kind: 'browser' }> = {
  ...managedTarget,
  browserInstanceId: 'browser:relay-profile',
  windowRef: 'window:relay-agent',
  tabRef: 'tab:relay-borrowed',
};

function createHarness(runId = 'run-1', conversationId = 'conversation-1') {
  const registry = new RunRegistry();
  registry.start({ runId, sessionId: conversationId, workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const identity: SurfaceRuntimeIdentityV1 = {
    conversationId,
    runId,
    agentId: 'agent-a',
  };
  return { registry, runtime, identity };
}

function browserElement(target = managedTarget) {
  return {
    kind: 'browser-element' as const,
    ref: 'element:save',
    tabRef: target.tabRef,
    documentRevision: target.documentRevision,
    backendNodeId: 42,
    role: 'button',
    name: 'Save',
  };
}

describe('SurfaceExecutionRuntime Browser control plane', () => {
  it('binds owner/session/target state and preserves successor verification semantics', async () => {
    const { runtime, identity } = createHarness();
    const prepared = runtime.prepareBrowserSession({ identity });
    expect(() => runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      target: { ...managedTarget, documentRevision: '' },
      providerGeneration: 'managed:generation-1',
    })).toThrowError(expect.objectContaining({
      surfaceError: expect.objectContaining({ code: 'SURFACE_STATE_STALE' }),
    }));
    const observed = runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      target: managedTarget,
      providerGeneration: 'managed:generation-1',
      elements: [browserElement()],
      evidenceAssetIds: ['evidence:before'],
    });
    expect(runtime.getBrowserBinding({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: observed.observation.stateId,
    })).toMatchObject({
      subject: prepared.subject,
      observation: {
        target: managedTarget,
        lifecycle: 'fresh',
        elementRefs: [{ stateId: observed.observation.stateId, backendNodeId: 42 }],
      },
    });

    const executed = await runtime.executeBrowserAction({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: observed.observation.stateId,
      operationId: 'browser-click-1',
      action: 'click',
      arguments: { action: 'click', elementRef: 'element:save' },
      expectation: { kind: 'text_present', text: 'Saved' },
      async dispatch() {
        const successorTarget = { ...managedTarget, documentRevision: 'document:2' };
        const successor = runtime.recordBrowserObservation({
          identity,
          surfaceSessionId: prepared.session.sessionId,
          target: successorTarget,
          providerGeneration: 'managed:generation-1',
          elements: [browserElement(successorTarget)],
          evidenceAssetIds: ['evidence:after'],
        }).observation;
        return {
          providerResult: { clicked: true },
          outcome: {
            delivery: 'confirmed',
            verification: 'satisfied',
            successorObservation: successor,
            evidenceRefs: ['evidence:after'],
          },
        };
      },
    });
    expect(executed).toMatchObject({
      providerResult: { clicked: true },
      surfaceResult: {
        delivery: 'confirmed',
        verification: 'satisfied',
        overall: 'succeeded',
        evidenceRefs: ['evidence:after'],
        successorState: { target: { documentRevision: 'document:2' } },
      },
    });
    expect(runtime.grants.getOwned(
      executed.session.grantId as string,
      prepared.subject,
    )).toMatchObject({
      singleUse: true,
      consumedAt: expect.any(Number),
      target: { documentRevision: 'document:1', tabRef: managedTarget.tabRef },
      actionClasses: ['managed_browser:click'],
    });
    await expect(runtime.executeBrowserAction({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: observed.observation.stateId,
      operationId: 'browser-click-replay',
      action: 'click',
      arguments: { action: 'click', elementRef: 'element:save' },
      async dispatch() {
        return { providerResult: {}, outcome: { delivery: 'confirmed' } };
      },
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_STATE_STALE' } });
  });

  it('rejects cross-agent, cross-session, and inactive RunRegistry owners before dispatch', async () => {
    const { registry, runtime, identity } = createHarness();
    const managed = runtime.prepareBrowserSession({ identity });
    const observed = runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: managed.session.sessionId,
      target: managedTarget,
      providerGeneration: 'managed:generation-1',
    });
    const otherSession = runtime.prepareBrowserSession({ identity, provider: 'remote-managed' });
    let dispatches = 0;
    const execute = (owner: SurfaceRuntimeIdentityV1, surfaceSessionId: string, provider?: string) => (
      runtime.executeBrowserAction({
        identity: owner,
        surfaceSessionId,
        predecessorStateId: observed.observation.stateId,
        ...(provider ? { provider } : {}),
        operationId: `cross-${owner.agentId}-${surfaceSessionId}`,
        action: 'click',
        arguments: { action: 'click' },
        async dispatch() {
          dispatches += 1;
          return { providerResult: {}, outcome: { delivery: 'confirmed' } };
        },
      })
    );

    await expect(execute({ ...identity, agentId: 'agent-b' }, managed.session.sessionId))
      .rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });
    await expect(execute(identity, otherSession.session.sessionId, 'remote-managed'))
      .rejects.toMatchObject({ surfaceError: { code: 'SURFACE_STATE_STALE' } });
    await registry.get(identity.runId)?.cancel('test-cancel');
    await expect(execute(identity, managed.session.sessionId))
      .rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });
    expect(dispatches).toBe(0);
  });

  it('requires an exact Relay lease and cancels active input before restoring the tab', async () => {
    const { runtime, identity } = createHarness();
    const prepared = runtime.prepareBrowserSession({ identity, provider: 'browser-relay' });
    const leaseSubject = { conversationId: identity.conversationId, ...prepared.subject };
    const lease = runtime.browserTabLeases.registerAvailable({
      subject: leaseSubject,
      browserInstanceId: relayTarget.browserInstanceId,
      tabRef: relayTarget.tabRef,
      agentWindowRef: relayTarget.windowRef,
      originalPlacement: { windowRef: 'window:user-original', index: 2, pinned: true },
    });
    runtime.browserTabLeases.requestConsent({ leaseId: lease.leaseId, subject: leaseSubject });
    runtime.browserTabLeases.approve({
      leaseId: lease.leaseId,
      subject: leaseSubject,
      approvalRef: 'approval-relay-runtime',
      domainScopes: ['example.test'],
      actionScopes: ['get_content', 'click'],
      ttlMs: 60_000,
    });
    expect(() => runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      provider: 'browser-relay',
      target: relayTarget,
      providerGeneration: 'relay:generation-1',
      leaseAction: 'get_content',
    })).toThrowError(expect.objectContaining({
      surfaceError: expect.objectContaining({ code: 'BROWSER_TAB_BORROW_REQUIRED' }),
    }));
    const observed = runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      provider: 'browser-relay',
      target: relayTarget,
      providerGeneration: 'relay:generation-1',
      leaseId: lease.leaseId,
      leaseAction: 'get_content',
    });
    const order: string[] = [];
    runtime.registerBrowserTabLeaseCleanup({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      leaseId: lease.leaseId,
      restore(placement) {
        order.push(`restore:${placement.windowRef}:${placement.index}`);
      },
    });
    const action = runtime.executeBrowserAction({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: observed.observation.stateId,
      provider: 'browser-relay',
      leaseId: lease.leaseId,
      operationId: 'relay-click',
      action: 'click',
      arguments: { action: 'click' },
      dispatch(signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            order.push('provider-aborted');
            reject(new Error('relay action cancelled'));
          }, { once: true });
        });
      },
    });
    await Promise.resolve();
    await runtime.endRun(identity);
    await expect(action).rejects.toMatchObject({
      surfaceError: { code: 'SURFACE_REQUEST_CANCELLED' },
    });
    expect(order).toEqual([
      'provider-aborted',
      'restore:window:user-original:2',
    ]);
    expect(runtime.browserTabLeases.getOwned(lease.leaseId, leaseSubject)?.state).toBe('returned');
    expect(runtime.sessions.get(prepared.session.sessionId)?.state).toBe('completed');
  });

  it('blocks Browser operations during takeover until resume and fails closed on tab return', async () => {
    const managedHarness = createHarness();
    const managed = managedHarness.runtime.prepareBrowserSession({ identity: managedHarness.identity });
    const observed = managedHarness.runtime.recordBrowserObservation({
      identity: managedHarness.identity,
      surfaceSessionId: managed.session.sessionId,
      target: managedTarget,
      providerGeneration: 'managed:generation-1',
    });
    const takeover = await managedHarness.runtime.control(
      managed.subject,
      'takeover',
      { reason: 'Complete MFA', timeoutMs: 5_000 },
    ) as SurfaceTakeoverControlV1;
    expect(managedHarness.runtime.sessions.get(managed.session.sessionId)?.state).toBe('waiting_human');
    await expect(managedHarness.runtime.executeBrowserAction({
      identity: managedHarness.identity,
      surfaceSessionId: managed.session.sessionId,
      predecessorStateId: observed.observation.stateId,
      operationId: 'blocked-during-takeover',
      action: 'click',
      arguments: { action: 'click' },
      async dispatch() {
        return { providerResult: {}, outcome: { delivery: 'confirmed' } };
      },
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_SESSION_BUSY' } });
    await managedHarness.runtime.control(managed.subject, 'resume');
    await expect(takeover.wait).resolves.toBe('continue');
    expect(managedHarness.runtime.sessions.get(managed.session.sessionId)?.state).toBe('running');

    const failedHarness = createHarness('run-2', 'conversation-2');
    const relay = failedHarness.runtime.prepareBrowserSession({
      identity: failedHarness.identity,
      provider: 'browser-relay',
    });
    const leaseSubject = { conversationId: failedHarness.identity.conversationId, ...relay.subject };
    const lease = failedHarness.runtime.browserTabLeases.registerAvailable({
      subject: leaseSubject,
      browserInstanceId: relayTarget.browserInstanceId,
      tabRef: relayTarget.tabRef,
      agentWindowRef: relayTarget.windowRef,
      originalPlacement: { windowRef: 'window:user-original', index: 2 },
    });
    failedHarness.runtime.browserTabLeases.requestConsent({ leaseId: lease.leaseId, subject: leaseSubject });
    failedHarness.runtime.browserTabLeases.approve({
      leaseId: lease.leaseId,
      subject: leaseSubject,
      approvalRef: 'approval-relay-failure',
      domainScopes: ['example.test'],
      actionScopes: ['get_content'],
      ttlMs: 60_000,
    });
    failedHarness.runtime.registerBrowserTabLeaseCleanup({
      identity: failedHarness.identity,
      surfaceSessionId: relay.session.sessionId,
      leaseId: lease.leaseId,
      restore() {
        throw new Error('private provider details');
      },
    });
    await expect(failedHarness.runtime.endRun(failedHarness.identity)).rejects.toMatchObject({
      surfaceError: { code: 'SURFACE_CLEANUP_FAILED', phase: 'cleanup' },
    });
    expect(failedHarness.runtime.browserTabLeases.getOwned(lease.leaseId, leaseSubject))
      .toMatchObject({ state: 'recovery_required', recoveryCode: 'return_failed' });
    expect(failedHarness.runtime.sessions.get(relay.session.sessionId)?.state).toBe('failed');
  });
});
