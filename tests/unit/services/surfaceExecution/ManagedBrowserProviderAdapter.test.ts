import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import {
  ManagedBrowserProviderAdapter,
  MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY,
  isUserBrowserSurfaceIdentity,
  managedBrowserProfileModeForIdentity,
  managedBrowserServiceKey,
} from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../../src/shared/contract/surfaceExecution';
import {
  SecureBrowserResumeStateStore,
  type BrowserResumeStateStore,
} from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';

function createMemorySecureStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { values.delete(key); }),
  };
}

function createNoopResumeStore(): BrowserResumeStateStore {
  return {
    exportForConversation: vi.fn(async () => '/secure/browser-resume-state/export.json'),
    importForConversation: vi.fn(async () => false),
    clearConversation: vi.fn(async () => undefined),
    activateConversation: vi.fn(),
  };
}

function createFakeBrowser(failSnapshotAt?: number, options?: {
  sessionId?: string;
  onSessionChanged?: (listener: (reason: string) => void) => () => void;
  cookies?: string[];
}) {
  let running = false;
  let snapshot = 0;
  const ensureSession = vi.fn(async () => {
    running = true;
    return {};
  });
  const close = vi.fn(async () => {
    running = false;
  });
  const sessionChangedListeners = new Set<(reason: string) => void>();
  const cookies = new Set(options?.cookies || []);
  const exportStorageState = vi.fn(async (filePath: string) => {
    await fs.promises.writeFile(filePath, JSON.stringify({
      cookies: [...cookies].map((name) => ({ name, value: '1', domain: 'example.test', path: '/' })),
      origins: [],
    }));
    return { path: filePath, accountState: {} };
  });
  const importStorageState = vi.fn(async (filePath: string) => {
    const state = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as {
      cookies?: Array<{ name?: string }>;
    };
    for (const cookie of state.cookies || []) {
      if (cookie.name) cookies.add(cookie.name);
    }
    return {};
  });
  const service = {
    ensureSession,
    isRunning: () => running,
    getActiveTab: () => running ? { id: 'managed-tab-1' } : null,
    getSessionState: () => ({
      sessionId: options?.sessionId || 'managed-provider-session',
      profileId: 'isolated-profile',
      provider: 'system-chrome-cdp',
      running,
      tabCount: running ? 1 : 0,
      activeTab: running
        ? {
          id: 'managed-tab-1',
          url: snapshot <= 1 ? 'about:blank' : 'https://example.test/after',
          title: snapshot <= 1 ? '' : 'Example',
          canGoBack: snapshot > 1,
          canGoForward: false,
        }
        : null,
    }),
    onSessionChanged: options?.onSessionChanged || ((listener: (reason: string) => void) => {
      sessionChangedListeners.add(listener);
      return () => sessionChangedListeners.delete(listener);
    }),
    emitSessionChangedForTest: (reason: string) => {
      for (const listener of sessionChangedListeners) listener(reason);
    },
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
    exportStorageState,
    importStorageState,
    close,
  };
  return {
    service: service as unknown as BrowserService,
    ensureSession,
    close,
    exportStorageState,
    importStorageState,
    hasCookie: (name: string) => cookies.has(name),
    sessionChangedListeners,
    raw: service,
  };
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
  const acquire = vi.fn((_serviceKey: string | null) => fake.service);
  const resumeStore = createNoopResumeStore();
  const adapter = new ManagedBrowserProviderAdapter(runtime, acquire, release, resumeStore);
  return { registry, runtime, identity, fake, acquire, release, resumeStore, adapter };
}

describe('ManagedBrowserProviderAdapter profile selection (P0 auth-state)', () => {
  it('user browse resolves to shared personal service key + persistent profile', () => {
    const userIdentity: SurfaceRuntimeIdentityV1 = {
      conversationId: 'conversation-a',
      runId: 'run-user',
      agentId: SURFACE_USER_BROWSER_AGENT_ID,
    };
    expect(isUserBrowserSurfaceIdentity(userIdentity)).toBe(true);
    expect(managedBrowserServiceKey(userIdentity)).toBe(MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY);
    expect(managedBrowserServiceKey(userIdentity)).toBe('__default__');
    expect(managedBrowserProfileModeForIdentity(userIdentity)).toBe('persistent');
    // Same personal key across conversations / runs (login survives reopen).
    expect(managedBrowserServiceKey({
      conversationId: 'conversation-b',
      runId: 'run-user-2',
      agentId: SURFACE_USER_BROWSER_AGENT_ID,
    })).toBe(MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY);
  });

  it('agent tasks keep isolated surface service keys (reverse criterion)', () => {
    const agentIdentity: SurfaceRuntimeIdentityV1 = {
      conversationId: 'conversation-a',
      runId: 'run-a',
      agentId: 'agent-a',
    };
    expect(isUserBrowserSurfaceIdentity(agentIdentity)).toBe(false);
    expect(managedBrowserServiceKey(agentIdentity)).toMatch(/^surface-/);
    expect(managedBrowserServiceKey(agentIdentity)).not.toBe(MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY);
    expect(managedBrowserProfileModeForIdentity(agentIdentity)).toBe('isolated');
    // Different runs / agents never share the personal key.
    expect(managedBrowserServiceKey({
      ...agentIdentity,
      runId: 'run-b',
    })).not.toBe(managedBrowserServiceKey(agentIdentity));
    expect(managedBrowserServiceKey({
      ...agentIdentity,
      agentId: 'agent-b',
    })).not.toBe(managedBrowserServiceKey(agentIdentity));
  });

  it('mutation ≥2: flipping agentId away from user-browser-link loses personal profile selection', () => {
    const personal = {
      conversationId: 'c',
      runId: 'r',
      agentId: SURFACE_USER_BROWSER_AGENT_ID,
    };
    const flippedAgent = { ...personal, agentId: 'agent-x' };
    const flippedEmpty = { ...personal, agentId: 'user-browser' }; // near-miss id
    expect(managedBrowserServiceKey(personal)).toBe(MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY);
    expect(managedBrowserProfileModeForIdentity(personal)).toBe('persistent');
    // Mutation 1: any non-user agentId must not get personal key.
    expect(managedBrowserServiceKey(flippedAgent)).not.toBe(MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY);
    expect(managedBrowserProfileModeForIdentity(flippedAgent)).toBe('isolated');
    // Mutation 2: near-miss id still isolated (no prefix match).
    expect(managedBrowserServiceKey(flippedEmpty)).not.toBe(MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY);
    expect(managedBrowserProfileModeForIdentity(flippedEmpty)).toBe('isolated');
  });

  it('user browse ensureSession uses persistent profileMode; agent uses isolated', async () => {
    const userRegistry = new RunRegistry();
    userRegistry.startAuxiliary({
      runId: 'run-user',
      sessionId: 'conversation-a',
      workspace: process.cwd(),
    });
    const userRuntime = new SurfaceExecutionRuntime({ runRegistry: userRegistry });
    const userFake = createFakeBrowser(undefined, { sessionId: 'user-session' });
    const userAcquire = vi.fn((_key: string | null) => userFake.service);
    const userAdapter = new ManagedBrowserProviderAdapter(
      userRuntime,
      userAcquire,
      async () => undefined,
    );
    await userAdapter.execute({
      identity: {
        conversationId: 'conversation-a',
        runId: 'run-user',
        agentId: SURFACE_USER_BROWSER_AGENT_ID,
      },
      operationId: 'user-prep',
      action: 'get_dom_snapshot',
      params: { action: 'get_dom_snapshot' },
      async executeProvider(_signal, browserService) {
        return { success: true, metadata: { domSnapshot: await browserService.getDomSnapshot() } };
      },
    });
    expect(userFake.ensureSession).toHaveBeenCalledWith('about:blank', expect.objectContaining({
      profileMode: 'persistent',
      leaseOwner: 'user-personal-browser',
    }));
    expect(userAcquire).toHaveBeenCalledWith(null);

    const { identity, fake, acquire, adapter } = createHarness();
    await adapter.execute({
      identity,
      operationId: 'agent-prep',
      action: 'get_dom_snapshot',
      params: { action: 'get_dom_snapshot' },
      async executeProvider(_signal, browserService) {
        return { success: true, metadata: { domSnapshot: await browserService.getDomSnapshot() } };
      },
    });
    expect(fake.ensureSession).toHaveBeenCalledWith('about:blank', expect.objectContaining({
      profileMode: 'isolated',
      leaseOwner: 'surface:run-a',
    }));
    expect(acquire.mock.calls[0][0]).toMatch(/^surface-/);
    expect(acquire.mock.calls[0][0]).not.toBe(MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY);
  });
});

describe('ManagedBrowserProviderAdapter', () => {
  it('getPreferredUiSessionState returns the live surface-bound browser session', async () => {
    const registry = new RunRegistry();
    registry.startAuxiliary({
      runId: 'run-user',
      sessionId: 'conversation-a',
      workspace: process.cwd(),
    });
    const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
    const userBrowser = createFakeBrowser(undefined, { sessionId: 'user-session' });
    const adapter = new ManagedBrowserProviderAdapter(
      runtime,
      () => userBrowser.service,
      async () => undefined,
    );

    expect(adapter.getPreferredUiSessionState()).toBeNull();

    await adapter.execute({
      identity: {
        conversationId: 'conversation-a',
        runId: 'run-user',
        agentId: SURFACE_USER_BROWSER_AGENT_ID,
      },
      operationId: 'prep-user',
      action: 'get_dom_snapshot',
      params: { action: 'get_dom_snapshot' },
      async executeProvider(_signal, browserService) {
        return { success: true, metadata: { domSnapshot: await browserService.getDomSnapshot() } };
      },
    });

    const preferred = adapter.getPreferredUiSessionState();
    expect(preferred?.sessionId).toBe('user-session');
    expect(preferred?.running).toBe(true);
  });

  it('organic page_load refreshes surface observation target', async () => {
    const { identity, fake, adapter } = createHarness();
    await adapter.execute({
      identity,
      operationId: 'prep-1',
      action: 'get_dom_snapshot',
      params: { action: 'get_dom_snapshot' },
      async executeProvider(_signal, browserService) {
        return { success: true, metadata: { domSnapshot: await browserService.getDomSnapshot() } };
      },
    });
    const snapshotsBefore = (fake.service.getDomSnapshot as ReturnType<typeof vi.fn>).mock.calls.length;
    // 模拟用户透传引发的有机跳转
    fake.raw.emitSessionChangedForTest('page_load');
    await vi.waitFor(() => {
      expect((fake.service.getDomSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
        .toBeGreaterThan(snapshotsBefore);
    });
    const binding = adapter.getBinding(identity);
    expect(binding?.target.origin).toBe('https://example.test');
  });

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

  it('exports before close and imports the cookie into the next run in the same conversation', async () => {
    const temporaryRoot = path.join(os.tmpdir(), `managed-browser-resume-${randomUUID()}`);
    const secureStorage = createMemorySecureStorage();
    const resumeStore = new SecureBrowserResumeStateStore({
      rootDir: temporaryRoot,
      secureStorage,
      workspaceRoot: process.cwd(),
    });
    const registry = new RunRegistry();
    registry.start({ runId: 'run-a', sessionId: 'conversation-a', workspace: process.cwd() });
    const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
    const first = createFakeBrowser(undefined, { sessionId: 'session-a', cookies: ['login'] });
    const second = createFakeBrowser(undefined, { sessionId: 'session-b' });
    let acquisition = 0;
    const acquire = vi.fn(() => (acquisition++ === 0 ? first.service : second.service));
    const release = vi.fn(async () => undefined);
    const adapter = new ManagedBrowserProviderAdapter(runtime, acquire, release, resumeStore);
    const firstIdentity: SurfaceRuntimeIdentityV1 = {
      conversationId: 'conversation-a',
      runId: 'run-a',
      agentId: 'agent-a',
    };

    try {
      const active = adapter.execute({
        identity: firstIdentity,
        operationId: 'first-click',
        action: 'click',
        params: { action: 'click', targetRef: { refId: 'target-1' } },
        executeProvider(signal) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
          });
        },
      });
      await vi.waitFor(() => expect(adapter.getBinding(firstIdentity)).not.toBeNull());
      const firstBinding = adapter.getBinding(firstIdentity)!;
      await runtime.control({
        sessionId: firstBinding.surfaceSessionId,
        runId: firstIdentity.runId,
        agentId: firstIdentity.agentId,
      }, 'stop');
      await expect(active).resolves.toMatchObject({ success: false });

      registry.unregister('run-a');
      registry.start({ runId: 'run-b', sessionId: 'conversation-a', workspace: process.cwd() });
      const secondIdentity: SurfaceRuntimeIdentityV1 = { ...firstIdentity, runId: 'run-b' };
      const resumed = await adapter.execute({
        identity: secondIdentity,
        operationId: 'second-observe',
        action: 'get_dom_snapshot',
        params: { action: 'get_dom_snapshot' },
        async executeProvider(_signal, browserService) {
          return { success: true, metadata: { domSnapshot: await browserService.getDomSnapshot() } };
        },
      });

      expect(resumed.success).toBe(true);
      expect(first.exportStorageState).toHaveBeenCalledOnce();
      expect(second.importStorageState).toHaveBeenCalledOnce();
      expect(second.hasCookie('login')).toBe(true);
    } finally {
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('does not close until the asynchronous resume-state export finishes', async () => {
    const { runtime, identity, fake } = createHarness();
    let finishExport!: () => void;
    const exportPending = new Promise<void>((resolve) => { finishExport = resolve; });
    const resumeStore: BrowserResumeStateStore = {
      exportForConversation: vi.fn(async () => {
        await exportPending;
        return '/secure/browser-resume-state/export.json';
      }),
      importForConversation: vi.fn(async () => false),
      clearConversation: vi.fn(async () => undefined),
      activateConversation: vi.fn(),
    };
    const release = vi.fn(async () => undefined);
    const adapter = new ManagedBrowserProviderAdapter(runtime, () => fake.service, release, resumeStore);
    const active = adapter.execute({
      identity,
      operationId: 'ordered-click',
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
    const stopping = runtime.control({
      sessionId: binding.surfaceSessionId,
      runId: identity.runId,
      agentId: identity.agentId,
    }, 'stop');

    await vi.waitFor(() => expect(resumeStore.exportForConversation).toHaveBeenCalledOnce());
    try {
      expect(fake.close).not.toHaveBeenCalled();
    } finally {
      finishExport();
      await stopping;
      await active;
    }
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('fails loud when export fails while still closing the browser and logging the failure', async () => {
    const { runtime, identity, fake } = createHarness();
    const resumeStore: BrowserResumeStateStore = {
      exportForConversation: vi.fn(async () => { throw new Error('secure write failed'); }),
      importForConversation: vi.fn(async () => false),
      clearConversation: vi.fn(async () => undefined),
      activateConversation: vi.fn(),
    };
    const resumeLogger = { error: vi.fn() };
    const adapter = new ManagedBrowserProviderAdapter(
      runtime,
      () => fake.service,
      async () => undefined,
      resumeStore,
      resumeLogger,
    );
    const active = adapter.execute({
      identity,
      operationId: 'failed-export-click',
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

    await expect(runtime.control({
      sessionId: binding.surfaceSessionId,
      runId: identity.runId,
      agentId: identity.agentId,
    }, 'stop')).rejects.toThrow('Browser login state could not be saved');
    await expect(active).resolves.toMatchObject({ success: false });
    expect(fake.close).toHaveBeenCalledOnce();
    expect(resumeLogger.error).toHaveBeenCalledWith(
      'Failed to save managed browser login state before close',
      expect.objectContaining({ error: 'secure write failed' }),
    );
  });

  it('does not import conversation A state into conversation B and keeps temp files out of artifacts', async () => {
    const temporaryRoot = path.join(os.tmpdir(), `managed-browser-resume-${randomUUID()}`);
    const screenshotDir = path.join(process.cwd(), 'artifacts', 'screenshots');
    const secureStorage = createMemorySecureStorage();
    const resumeStore = new SecureBrowserResumeStateStore({
      rootDir: temporaryRoot,
      secureStorage,
      workspaceRoot: process.cwd(),
    });
    const source = createFakeBrowser(undefined, { cookies: ['conversation-a-login'] });
    const target = createFakeBrowser();

    try {
      const exportedPath = await resumeStore.exportForConversation('conversation-a', source.service);
      expect(path.relative(process.cwd(), exportedPath).startsWith('..')).toBe(true);
      expect(path.relative(screenshotDir, exportedPath).startsWith('..')).toBe(true);
      expect(fs.existsSync(exportedPath)).toBe(false);

      const registry = new RunRegistry();
      registry.start({ runId: 'run-b', sessionId: 'conversation-b', workspace: process.cwd() });
      const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
      const adapter = new ManagedBrowserProviderAdapter(
        runtime,
        () => target.service,
        async () => undefined,
        resumeStore,
      );
      const result = await adapter.execute({
        identity: { conversationId: 'conversation-b', runId: 'run-b', agentId: 'agent-b' },
        operationId: 'conversation-b-observe',
        action: 'get_dom_snapshot',
        params: { action: 'get_dom_snapshot' },
        async executeProvider(_signal, browserService) {
          return { success: true, metadata: { domSnapshot: await browserService.getDomSnapshot() } };
        },
      });

      expect(result.success).toBe(true);
      expect(target.importStorageState).not.toHaveBeenCalled();
      expect(target.hasCookie('conversation-a-login')).toBe(false);

      await resumeStore.clearConversation('conversation-a');
      source.exportStorageState.mockClear();
      await resumeStore.exportForConversation('conversation-a', source.service);
      expect(source.exportStorageState).not.toHaveBeenCalled();
      expect(secureStorage.values.size).toBe(0);
    } finally {
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('reports a corrupted stored state instead of silently starting as resumed', async () => {
    const temporaryRoot = path.join(os.tmpdir(), `managed-browser-resume-${randomUUID()}`);
    const secureStorage = createMemorySecureStorage();
    const resumeStore = new SecureBrowserResumeStateStore({
      rootDir: temporaryRoot,
      secureStorage,
      workspaceRoot: process.cwd(),
    });
    const source = createFakeBrowser(undefined, { cookies: ['login'] });
    const target = createFakeBrowser();
    const resumeLogger = { error: vi.fn() };

    try {
      await resumeStore.exportForConversation('conversation-a', source.service);
      const slot = [...secureStorage.values.keys()][0];
      secureStorage.values.set(slot, '{broken-json');
      const registry = new RunRegistry();
      registry.start({ runId: 'run-a', sessionId: 'conversation-a', workspace: process.cwd() });
      const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
      const release = vi.fn(async () => undefined);
      const adapter = new ManagedBrowserProviderAdapter(
        runtime,
        () => target.service,
        release,
        resumeStore,
        resumeLogger,
      );
      const result = await adapter.execute({
        identity: { conversationId: 'conversation-a', runId: 'run-a', agentId: 'agent-a' },
        operationId: 'corrupt-resume-state',
        action: 'get_dom_snapshot',
        params: { action: 'get_dom_snapshot' },
        async executeProvider(_signal, browserService) {
          return { success: true, metadata: { domSnapshot: await browserService.getDomSnapshot() } };
        },
      });

      expect(result).toMatchObject({
        success: false,
        metadata: { code: 'BROWSER_RESUME_STATE_IMPORT_FAILED' },
      });
      expect(target.close).toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
      expect(resumeLogger.error).toHaveBeenCalledWith(
        'Failed to restore managed browser login state',
        expect.objectContaining({ error: expect.any(String) }),
      );
    } finally {
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('keeps binding setup equivalent when no resume state is stored', async () => {
    const { identity, fake, resumeStore, adapter } = createHarness();
    const result = await adapter.execute({
      identity,
      operationId: 'no-resume-state',
      action: 'get_dom_snapshot',
      params: { action: 'get_dom_snapshot' },
      async executeProvider(_signal, browserService) {
        return { success: true, metadata: { domSnapshot: await browserService.getDomSnapshot() } };
      },
    });

    expect(result.success).toBe(true);
    expect(resumeStore.importForConversation).toHaveBeenCalledWith(identity.conversationId, fake.service);
    expect(fake.importStorageState).not.toHaveBeenCalled();
    expect(fake.ensureSession).toHaveBeenCalledOnce();
  });

  it('shares one physical browser within a conversation while preserving separate run owners', async () => {
    const { registry, runtime, identity, fake, acquire, release, adapter } = createHarness();
    const userHandle = registry.startAuxiliary({
      runId: 'run-user-browser',
      sessionId: identity.conversationId,
      workspace: process.cwd(),
    });
    const userIdentity: SurfaceRuntimeIdentityV1 = {
      conversationId: identity.conversationId,
      runId: userHandle.context.runId,
      agentId: 'user-browser-link',
    };
    const navigate = (owner: SurfaceRuntimeIdentityV1, operationId: string) => adapter.execute({
      identity: owner,
      operationId,
      action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/after' },
      async executeProvider(_signal, browserService) {
        expect(browserService).toBe(fake.service);
        return { success: true, output: 'navigated' };
      },
    });

    expect((await navigate(identity, 'agent-navigate')).success).toBe(true);
    expect((await navigate(userIdentity, 'user-navigate')).success).toBe(true);
    expect(acquire).toHaveBeenCalledOnce();
    expect(adapter.getBinding(identity)?.surfaceSessionId)
      .not.toBe(adapter.getBinding(userIdentity)?.surfaceSessionId);

    await runtime.endRun(identity);
    expect(release).not.toHaveBeenCalled();
    await runtime.endRun(userIdentity);
    expect(release).toHaveBeenCalledOnce();
  });

  it('refreshes a stale observation before a URL-targeted mutation instead of failing', async () => {
    // 真机实测（2026-08-02）：点开一个链接后静置 45s 再点下一个，必报
    // "Observation is consumed, superseded, or expired." 且对用户完全隐形。
    // 观测 TTL 30s，而 binding 跟着整个 conversation 长活——过一分钟再点链接是常态。
    vi.useFakeTimers();
    try {
      const { identity, adapter } = createHarness();
      const navigate = (operationId: string) => adapter.execute({
        identity,
        operationId,
        action: 'navigate',
        params: { action: 'navigate', url: 'https://example.test/after' },
        async executeProvider() {
          return { success: true, output: 'navigated' };
        },
      });

      expect((await navigate('navigate-fresh')).success).toBe(true);
      await vi.advanceTimersByTimeAsync(45_000);
      const stale = await navigate('navigate-after-ttl');
      expect(stale.success).toBe(true);
      expect(stale.metadata?.surfaceExecutionErrorV1).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps two agent sub-runs in one conversation on separate physical browsers', async () => {
    const { identity, acquire, adapter } = createHarness();
    // 同一 conversation + 同一 run 下的两个 sub-agent：右栏一次只显示一扇窗，
    // 让它们共用一个页面等于互相静默改导航，比看不见第二扇窗更糟。
    const siblingIdentity: SurfaceRuntimeIdentityV1 = { ...identity, agentId: 'agent-b' };
    const navigate = (owner: SurfaceRuntimeIdentityV1, operationId: string) => adapter.execute({
      identity: owner,
      operationId,
      action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/sibling' },
      async executeProvider() {
        return { success: true, output: 'navigated' };
      },
    });

    expect((await navigate(identity, 'agent-a-navigate')).success).toBe(true);
    expect((await navigate(siblingIdentity, 'agent-b-navigate')).success).toBe(true);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire.mock.calls[0][0]).not.toBe(acquire.mock.calls[1][0]);
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
