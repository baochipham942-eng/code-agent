import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  SurfaceEvidenceCardV1,
  SurfaceTargetRefV1,
} from '../../../../src/shared/contract/surfaceExecution';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
  type SurfaceTakeoverControlV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { SurfaceContinuationService } from '../../../../src/host/services/surfaceExecution/SurfaceContinuationService';

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
  it('carries the owning turn into the session and every published event', () => {
    const { runtime, identity } = createHarness();
    const ownedIdentity = { ...identity, turnId: 'turn-1' };
    const prepared = runtime.prepareBrowserSession({ identity: ownedIdentity });
    const observed = runtime.recordBrowserObservation({
      identity: ownedIdentity,
      surfaceSessionId: prepared.session.sessionId,
      target: managedTarget,
      providerGeneration: 'managed:generation-turn',
    });

    expect(observed.session.turnId).toBe('turn-1');
    expect(observed.events).not.toHaveLength(0);
    expect(observed.events.every((value) => value.turnId === 'turn-1')).toBe(true);
  });

  it('links Browser and Computer sessions and publishes deterministic switch reasons', () => {
    const { runtime, identity } = createHarness();
    const browser = runtime.prepareBrowserSession({ identity });
    const computer = runtime.prepareComputerSession({
      identity,
      switchReason: 'A native preferences window must be inspected.',
    });

    expect(computer.session.parentSessionId).toBe(browser.session.sessionId);
    expect(runtime.events.listOwned(computer.subject)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'prepare',
        status: 'succeeded',
        userSummary: expect.stringContaining('A native preferences window must be inspected.'),
        operation: expect.objectContaining({
          action: 'surface_switch',
          approvalScope: `from:${browser.session.sessionId}`,
        }),
      }),
    ]));

    const switchedBack = runtime.prepareBrowserSession({
      identity,
      switchReason: 'The generated artifact needs DOM and screenshot verification.',
    });
    expect(switchedBack.session.sessionId).toBe(browser.session.sessionId);
    expect(runtime.events.listOwned(switchedBack.subject)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userSummary: expect.stringContaining('The generated artifact needs DOM and screenshot verification.'),
        operation: expect.objectContaining({
          action: 'surface_switch',
          approvalScope: `from:${computer.session.sessionId}`,
        }),
      }),
    ]));
  });

  it('consumes an explicit durable continuation once and requires a fresh observation', () => {
    const registry = new RunRegistry();
    registry.start({ runId: 'run-after-restart', sessionId: 'conversation-1', workspace: process.cwd() });
    const continuations = new SurfaceContinuationService({ createId: () => 'continuation-1' });
    continuations.prepare({
      conversationId: 'conversation-1',
      parentSessionId: 'surface-before-restart',
      agentId: 'agent-a',
    });
    const runtime = new SurfaceExecutionRuntime({ runRegistry: registry, continuations });
    const prepared = runtime.prepareBrowserSession({
      identity: {
        conversationId: 'conversation-1',
        runId: 'run-after-restart',
        agentId: 'agent-a',
      },
    });

    expect(prepared.session.parentSessionId).toBe('surface-before-restart');
    expect(runtime.events.listOwned(prepared.subject)).toContainEqual(expect.objectContaining({
      phase: 'recover',
      status: 'succeeded',
      operation: expect.objectContaining({
        action: 'continue_from_checkpoint',
        expectedOutcome: expect.stringContaining('Observe'),
      }),
    }));
    expect(continuations.peek('conversation-1', 'agent-a')).toBeNull();
  });

  it('advertises only provider-backed Relay operations and observation kinds', () => {
    const { runtime, identity } = createHarness();
    const managed = runtime.prepareBrowserSession({ identity });
    const relay = runtime.prepareBrowserSession({ identity, provider: 'browser-relay' });

    expect(managed.session.capabilities.operations).toContain('upload_file');
    expect(managed.session.capabilities.observationKinds).toContain('network');
    expect(relay.session.capabilities.operations).toEqual(expect.arrayContaining([
      'launch', 'close', 'navigate', 'get_dom_snapshot', 'get_a11y_snapshot', 'screenshot',
      'upload_file',
    ]));
    expect(relay.session.capabilities.operations).not.toContain('wait_for_download');
    expect(relay.session.capabilities.operations).not.toContain('import_profile_cookies');
    expect(relay.session.capabilities.observationKinds).not.toContain('network');
  });

  it('derives owner-safe snapshots and publishes control acknowledgements from Host state', async () => {
    const { runtime, identity } = createHarness();
    const prepared = runtime.prepareBrowserSession({ identity });

    const initial = runtime.snapshotConversation(identity.conversationId);
    expect(initial.sessions[0]).toMatchObject({
      session: {
        sessionId: prepared.session.sessionId,
        provider: 'system-chrome-cdp',
        state: 'running',
      },
      grant: { state: 'none' },
      availableControls: expect.arrayContaining(['pause', 'takeover', 'stop', 'end_session']),
      writable: true,
      source: 'live',
    });
    expect(JSON.stringify(initial)).not.toContain('grantId');

    const paused = await runtime.controlConversation({
      conversationId: identity.conversationId,
      surfaceSessionId: prepared.session.sessionId,
      action: 'pause',
    });
    expect(paused.snapshot.sessions[0]).toMatchObject({
      session: { state: 'paused' },
      availableControls: expect.arrayContaining(['resume', 'takeover', 'stop']),
      events: expect.arrayContaining([expect.objectContaining({
        provider: 'system-chrome-cdp',
        sessionState: 'paused',
        status: 'waiting',
        operation: expect.objectContaining({ action: 'pause' }),
      })]),
    });
    await expect(runtime.controlConversation({
      conversationId: 'conversation-attacker',
      surfaceSessionId: prepared.session.sessionId,
      action: 'resume',
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });

    await runtime.controlConversation({
      conversationId: identity.conversationId,
      surfaceSessionId: prepared.session.sessionId,
      action: 'resume',
    });
    const stopped = await runtime.controlConversation({
      conversationId: identity.conversationId,
      surfaceSessionId: prepared.session.sessionId,
      action: 'stop',
    });
    expect(stopped.snapshot.sessions[0]).toMatchObject({
      session: { state: 'stopping' },
      availableControls: ['end_session'],
      events: expect.arrayContaining([expect.objectContaining({ status: 'cancelled' })]),
    });
    const ended = await runtime.controlConversation({
      conversationId: identity.conversationId,
      surfaceSessionId: prepared.session.sessionId,
      action: 'end_session',
    });
    expect(ended.snapshot.sessions[0]).toMatchObject({
      session: { state: 'completed' },
      availableControls: [],
      writable: false,
    });
  });

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
    await registry.get(identity.runId)?.cancel('user');
    await expect(execute(identity, managed.session.sessionId))
      .rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });
    expect(dispatches).toBe(0);
  });

  it('rejects foreign or stale element refs before issuing a grant or dispatching', async () => {
    const { runtime, identity } = createHarness();
    const prepared = runtime.prepareBrowserSession({ identity });
    const observed = runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      target: managedTarget,
      providerGeneration: 'managed:generation-element-fence',
      elements: [browserElement()],
    });
    let dispatches = 0;

    await expect(runtime.executeBrowserAction({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: observed.observation.stateId,
      operationId: 'foreign-element-ref',
      action: 'click',
      arguments: { action: 'click', targetRef: { refId: 'element:foreign' } },
      async dispatch() {
        dispatches += 1;
        return { providerResult: {}, outcome: { delivery: 'confirmed' } };
      },
    })).rejects.toMatchObject({
      surfaceError: { code: 'SURFACE_ELEMENT_REF_NOT_FOUND' },
    });
    expect(dispatches).toBe(0);
    expect(runtime.getBrowserBinding({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: observed.observation.stateId,
    })?.observation.lifecycle).toBe('fresh');

    await expect(runtime.executeBrowserAction({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: observed.observation.stateId,
      operationId: 'conflicting-element-revision',
      action: 'click',
      arguments: {
        action: 'click',
        targetRef: {
          ref: 'element:save',
          tabRef: managedTarget.tabRef,
          documentRevision: 'document:foreign',
          backendNodeId: 42,
        },
      },
      async dispatch() {
        dispatches += 1;
        return { providerResult: {}, outcome: { delivery: 'confirmed' } };
      },
    })).rejects.toMatchObject({
      surfaceError: { code: 'SURFACE_TARGET_REVISION_CHANGED' },
    });
    expect(dispatches).toBe(0);

    await expect(runtime.executeBrowserAction({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: observed.observation.stateId,
      operationId: 'foreign-drag-destination-ref',
      action: 'drag',
      arguments: {
        action: 'drag',
        targetRef: { ref: 'element:save' },
        destinationTargetRef: { ref: 'element:foreign-destination' },
      },
      async dispatch() {
        dispatches += 1;
        return { providerResult: {}, outcome: { delivery: 'confirmed' } };
      },
    })).rejects.toMatchObject({
      surfaceError: { code: 'SURFACE_ELEMENT_REF_NOT_FOUND' },
    });
    expect(dispatches).toBe(0);

    const accepted = await runtime.executeBrowserAction({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: observed.observation.stateId,
      operationId: 'optional-destination-ref-omitted',
      action: 'type',
      arguments: {
        action: 'type',
        targetRef: { ref: 'element:save' },
        destinationTargetRef: undefined,
      },
      async dispatch() {
        dispatches += 1;
        const successorTarget = { ...managedTarget, documentRevision: 'document:after-type' };
        const successor = runtime.recordBrowserObservation({
          identity,
          surfaceSessionId: prepared.session.sessionId,
          target: successorTarget,
          providerGeneration: 'managed:generation-element-fence',
          elements: [browserElement(successorTarget)],
        }).observation;
        return {
          providerResult: { typed: true },
          outcome: { delivery: 'confirmed', successorObservation: successor },
        };
      },
    });
    expect(accepted.providerResult).toEqual({ typed: true });
    expect(dispatches).toBe(1);
  });

  it('lets the exact cancelling run abort active input before restoring the Relay tab', async () => {
    const { registry, runtime, identity } = createHarness();
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
    let returnedLeaseState: string | undefined;
    runtime.interrupts.registerCleanup(prepared.subject, () => {
      returnedLeaseState = runtime.browserTabLeases.getOwned(lease.leaseId, leaseSubject)?.state;
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
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            order.push('provider-aborted');
            reject(new Error('relay action cancelled'));
          }, { once: true });
        });
      },
    });
    await Promise.resolve();
    const handle = registry.resolve({
      runId: identity.runId,
      sessionId: identity.conversationId,
    });
    await handle?.cancel('user');
    expect(handle?.cancellationRequested).toBe(true);
    expect(() => runtime.prepareComputerSession({ identity })).toThrowError(expect.objectContaining({
      surfaceError: expect.objectContaining({ code: 'SURFACE_TARGET_NOT_OWNED' }),
    }));
    await runtime.endRun(identity);
    await expect(action).rejects.toMatchObject({
      surfaceError: { code: 'SURFACE_REQUEST_CANCELLED' },
    });
    expect(order).toEqual([
      'provider-aborted',
      'restore:window:user-original:2',
    ]);
    expect(returnedLeaseState).toBe('returned');
    expect(runtime.sessions.get(prepared.session.sessionId)?.state).toBe('completed');
  });

  it('cleans every Agent session in the exact cancelling run without touching another run', async () => {
    const { registry, runtime, identity } = createHarness('run-parent', 'conversation-parent');
    const childIdentity = { ...identity, agentId: 'agent-child' };
    const otherIdentity = {
      conversationId: 'conversation-other',
      runId: 'run-other',
      agentId: 'agent-other',
    };
    registry.start({
      runId: otherIdentity.runId,
      sessionId: otherIdentity.conversationId,
      workspace: process.cwd(),
    });
    const parent = runtime.prepareBrowserSession({ identity });
    const child = runtime.prepareBrowserSession({ identity: childIdentity });
    const other = runtime.prepareBrowserSession({ identity: otherIdentity });

    await registry.resolve({
      runId: identity.runId,
      sessionId: identity.conversationId,
    })?.cancel('user');
    await runtime.endRun(identity);

    expect(runtime.sessions.get(parent.session.sessionId)?.state).toBe('completed');
    expect(runtime.sessions.get(child.session.sessionId)?.state).toBe('completed');
    expect(runtime.sessions.get(other.session.sessionId)?.state).toBe('running');
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
    expect(failedHarness.runtime.sessions.get(relay.session.sessionId)?.state).toBe('stopping');
  });

  it('keeps owner-scoped screenshot evidence readable after run cleanup reaches terminal state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-runtime-terminal-frame-'));
    try {
      const path = join(root, 'frame.png');
      writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const { runtime, identity } = createHarness();
      const prepared = runtime.prepareBrowserSession({ identity });
      const evidence: SurfaceEvidenceCardV1 = {
        version: 1,
        evidenceId: 'terminal-frame',
        kind: 'screenshot',
        source: 'browser',
        title: 'Terminal evidence',
        capturedAt: 100,
        assetRef: path,
        redactionStatus: 'clean',
        inspection: {
          captureState: 'captured',
          analysisState: 'not_requested',
          verificationState: 'not_requested',
          supportsStepIds: [],
          checklist: [],
        },
      };
      const projected = runtime.frames.projectEvidence(prepared.subject, [evidence]);
      const assetRef = projected?.[0].assetRef as string;

      await runtime.endRun(identity);

      expect(runtime.sessions.get(prepared.session.sessionId)?.state).toBe('completed');
      await expect(runtime.frames.resolve({
        version: 1,
        conversationId: identity.conversationId,
        surfaceSessionId: prepared.session.sessionId,
        assetRef,
      })).resolves.toMatchObject({ assetRef, mimeType: 'image/png' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
