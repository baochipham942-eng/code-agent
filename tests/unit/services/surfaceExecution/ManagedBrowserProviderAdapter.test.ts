import { describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import {
  ManagedBrowserProviderAdapter,
  managedBrowserServiceKey,
} from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';

function createFakeBrowser(failSnapshotAt?: number) {
  let running = false;
  let snapshot = 0;
  const ensureSession = vi.fn(async () => {
    running = true;
    return {};
  });
  const close = vi.fn(async () => {
    running = false;
  });
  const service = {
    ensureSession,
    isRunning: () => running,
    getActiveTab: () => running ? { id: 'managed-tab-1' } : null,
    getSessionState: () => ({
      sessionId: 'managed-provider-session',
      profileId: 'isolated-profile',
      provider: 'system-chrome-cdp',
    }),
    getDomSnapshot: vi.fn(async () => {
      snapshot += 1;
      if (snapshot === failSnapshotAt) throw new Error('snapshot unavailable');
      return {
        snapshotId: `snapshot-${snapshot}`,
        tabId: 'managed-tab-1',
        capturedAtMs: Date.now(),
        url: snapshot === 1 ? 'about:blank' : 'https://example.test/after',
        title: 'Example',
        headings: [],
        interactiveElements: [{
          tag: 'button',
          role: 'button',
          text: 'Save',
          selectorHint: '#save',
          backendNodeId: 42,
          targetRef: {
            refId: `target-${snapshot}`,
            source: 'dom',
            selector: '#save',
            frameId: 'managed-frame-1',
            documentRevision: `document_snapshot-${snapshot}_managed-frame-1`,
            tabId: 'managed-tab-1',
            snapshotId: `snapshot-${snapshot}`,
            capturedAtMs: Date.now(),
            ttlMs: 30_000,
            confidence: 1,
            backendNodeId: 42,
          },
          rect: { x: 10, y: 20, width: 80, height: 30 },
        }],
      };
    }),
    close,
  };
  return { service: service as unknown as BrowserService, ensureSession, close };
}

function createHarness(failSnapshotAt?: number) {
  const registry = new RunRegistry();
  registry.start({ runId: 'run-a', sessionId: 'conversation-a', workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const identity: SurfaceRuntimeIdentityV1 = {
    conversationId: 'conversation-a',
    runId: 'run-a',
    agentId: 'agent-a',
  };
  const fake = createFakeBrowser(failSnapshotAt);
  const release = vi.fn(async () => fake.close());
  const adapter = new ManagedBrowserProviderAdapter(runtime, () => fake.service, release);
  return { registry, runtime, identity, fake, release, adapter };
}

describe('ManagedBrowserProviderAdapter', () => {
  it('binds the returned DOM target refs to the current Surface observation', async () => {
    const { identity, fake, adapter } = createHarness();
    const observed = await adapter.execute({
      identity,
      operationId: 'dom-1',
      action: 'get_dom_snapshot',
      params: { action: 'get_dom_snapshot' },
      async executeProvider(_signal, browserService) {
        const snapshot = await browserService.getDomSnapshot();
        return { success: true, metadata: { domSnapshot: snapshot } };
      },
    });
    const snapshot = observed.metadata?.domSnapshot as {
      interactiveElements: Array<{ targetRef: { refId: string } }>;
    };
    const targetRef = snapshot.interactiveElements[0].targetRef;

    expect(fake.service.getDomSnapshot).toHaveBeenCalledTimes(2);
    expect(observed.metadata?.surfaceObservationV1).toMatchObject({
      elementRefs: [{ ref: targetRef.refId }],
    });

    const clicked = await adapter.execute({
      identity,
      operationId: 'click-current-ref',
      action: 'click',
      params: { action: 'click', targetRef },
      async executeProvider() {
        return { success: true, output: 'clicked' };
      },
    });
    expect(clicked.success).toBe(true);
    expect(fake.service.getDomSnapshot).toHaveBeenCalledTimes(3);
  });

  it('uses a run-scoped isolated profile and executes mutations through Surface control', async () => {
    const { runtime, identity, fake, release, adapter } = createHarness();
    const result = await adapter.execute({
      identity,
      operationId: 'navigate-1',
      action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/after' },
      async executeProvider(_signal, browserService) {
        expect(browserService).toBe(fake.service);
        return { success: true, output: 'navigated' };
      },
    });

    expect(result.success).toBe(true);
    expect(fake.ensureSession).toHaveBeenCalledWith('about:blank', expect.objectContaining({
      profileMode: 'isolated',
      leaseOwner: 'surface:run-a',
    }));
    expect(result.metadata).toMatchObject({
      engine: 'managed',
      managedProfileMode: 'isolated',
      surfaceExecutionActionResultV1: {
        delivery: 'confirmed',
        overall: 'delivered_unverified',
        successorState: {
          target: { origin: 'https://example.test' },
          elementRefs: [{ backendNodeId: 42, selectorFallback: '#save' }],
        },
      },
    });
    const binding = adapter.getBinding(identity);
    expect(binding?.serviceKey).toBe(managedBrowserServiceKey(identity));
    expect(binding?.predecessorStateId).toBe(
      (result.metadata?.surfaceExecutionActionResultV1 as { successorState: { stateId: string } })
        .successorState.stateId,
    );

    await runtime.endRun(identity);
    expect(release).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('isolates owner keys and closes the provider when stop aborts an active mutation', async () => {
    const { runtime, identity, fake, adapter } = createHarness();
    expect(managedBrowserServiceKey(identity)).not.toBe(managedBrowserServiceKey({
      ...identity,
      runId: 'run-b',
    }));

    const operation = adapter.execute({
      identity,
      operationId: 'click-blocked',
      action: 'click',
      params: { action: 'click', targetRef: { refId: 'target-1' } },
      executeProvider(signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
        });
      },
    });
    await vi.waitFor(() => expect(adapter.getBinding(identity)).not.toBeNull());
    const binding = adapter.getBinding(identity)!;
    await runtime.control({
      sessionId: binding.surfaceSessionId,
      runId: identity.runId,
      agentId: identity.agentId,
    }, 'stop');

    await expect(operation).resolves.toMatchObject({
      success: false,
      metadata: {
        surfaceExecutionErrorV1: { code: 'SURFACE_REQUEST_CANCELLED' },
      },
    });
    expect(fake.close).toHaveBeenCalled();
  });

  it('reports delivered mutation with a missing successor as ambiguous and non-replayable', async () => {
    const { identity, adapter } = createHarness(2);
    const result = await adapter.execute({
      identity,
      operationId: 'click-without-successor',
      action: 'click',
      params: { action: 'click', targetRef: { refId: 'target-1' } },
      async executeProvider() {
        return { success: true, output: 'clicked' };
      },
    });

    expect(result.metadata).toMatchObject({
      surfaceExecutionActionResultV1: {
        delivery: 'confirmed',
        verification: 'inconclusive',
        overall: 'ambiguous',
        error: {
          code: 'SURFACE_POSTCONDITION_FAILED',
          phase: 'verify',
          recommendedAction: expect.stringContaining('do not replay'),
        },
      },
    });
  });
});
