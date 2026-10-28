import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { ManagedBrowserProviderAdapter } from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import type { BrowserResumeStateStore } from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';
import {
  BROWSER_HUMAN_TAKEOVER_WAIT,
  getToolExecutionTimeoutMs,
} from '../../../../src/shared/constants/timeouts';

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: vi.fn(async () => undefined) }),
}));
vi.mock('../../../../src/host/services/surfaceExecution/CronBrowserLoginState', () => ({
  importBrowserStorageStateForOrigin: vi.fn(async () => undefined),
}));

function createNoopResumeStore(): BrowserResumeStateStore {
  return {
    exportForConversation: vi.fn(async () => '/secure/browser-resume-state/export.json'),
    importForConversation: vi.fn(async () => false),
    clearConversation: vi.fn(async () => undefined),
    activateConversation: vi.fn(),
  };
}

function createFakeBrowser() {
  let running = false;
  const close = vi.fn(async () => {
    running = false;
  });
  const getDomSnapshot = vi.fn(async () => ({
    snapshotId: `snapshot-${getDomSnapshot.mock.calls.length}`,
    tabId: 'managed-tab-1',
    capturedAtMs: 1,
    url: 'https://example.test/page',
    title: 'Example',
    headings: [],
    interactiveElements: [],
  }));
  const service = {
    ensureSession: vi.fn(async () => {
      running = true;
    }),
    isRunning: () => running,
    getActiveTab: () => (running ? { id: 'managed-tab-1' } : null),
    getSessionState: () => ({
      sessionId: 'managed-provider-session',
      profileId: 'isolated-profile',
      provider: 'system-chrome-cdp',
      running,
      tabCount: running ? 1 : 0,
      activeTab: running
        ? {
          id: 'managed-tab-1',
          url: 'https://example.test/page',
          title: 'Example',
          canGoBack: false,
          canGoForward: false,
        }
        : null,
    }),
    onSessionChanged: () => () => undefined,
    getDomSnapshot,
    close,
  };
  return { service: service as unknown as BrowserService, close, getDomSnapshot };
}

function createHarness() {
  const registry = new RunRegistry();
  registry.start({ runId: 'run-a', sessionId: 'conversation-a', workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const identity: SurfaceRuntimeIdentityV1 = {
    conversationId: 'conversation-a',
    runId: 'run-a',
    agentId: 'agent-a',
  };
  const fake = createFakeBrowser();
  const resumeStore = createNoopResumeStore();
  const adapter = new ManagedBrowserProviderAdapter(
    runtime,
    () => fake.service,
    async () => undefined,
    resumeStore,
  );
  const subjectFor = () => {
    const binding = adapter.getBinding(identity);
    if (!binding) throw new Error('managed browser binding was not created');
    return {
      sessionId: binding.surfaceSessionId,
      runId: identity.runId,
      agentId: identity.agentId,
    };
  };
  return { runtime, identity, fake, resumeStore, adapter, subjectFor };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('browser preempt really stops the shared browser', () => {
  it('keeps the human-takeover wait cap under the browser_action tool inactivity budget', () => {
    const budget = getToolExecutionTimeoutMs('browser_action');
    expect(budget).toBeLessThanOrEqual(120_000);
    expect(BROWSER_HUMAN_TAKEOVER_WAIT.CAP_MS).toBeLessThan(budget ?? 0);
    expect(BROWSER_HUMAN_TAKEOVER_WAIT.POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(BROWSER_HUMAN_TAKEOVER_WAIT.POLL_INTERVAL_MS)
      .toBeLessThan(BROWSER_HUMAN_TAKEOVER_WAIT.CAP_MS);
  });

  it('takeover aborts the in-flight action without close, then resume runs the next action on the same browser', async () => {
    const { runtime, identity, fake, resumeStore, adapter, subjectFor } = createHarness();
    let abortReason: unknown = 'unset';
    let inflightEntered = false;
    const inflight = adapter.execute({
      identity,
      operationId: 'inflight-navigate',
      action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/page' },
      executeProvider(signal, browserService) {
        inflightEntered = true;
        expect(browserService).toBe(fake.service);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortReason = signal.reason;
            reject(new Error('provider aborted'));
          }, { once: true });
        });
      },
    });
    await vi.waitFor(() => expect(inflightEntered).toBe(true));

    await runtime.control(subjectFor(), 'takeover');
    const inflightResult = await inflight;

    expect(abortReason).toBe('surface-human-takeover');
    expect(inflightResult).toMatchObject({
      success: false,
      metadata: { surfaceExecutionErrorV1: { code: 'SURFACE_REQUEST_CANCELLED' } },
    });
    expect(fake.close).not.toHaveBeenCalled();
    expect(resumeStore.exportForConversation).not.toHaveBeenCalled();
    expect(runtime.sessions.get(subjectFor().sessionId)?.state).toBe('waiting_human');

    let nextEntered = false;
    let settled = false;
    const next = adapter.execute({
      identity,
      operationId: 'resume-navigate',
      action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/page' },
      async executeProvider(_signal, browserService) {
        nextEntered = true;
        expect(browserService).toBe(fake.service);
        return { success: true, output: 'continued on the same page' };
      },
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(fake.getDomSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(nextEntered).toBe(false);
    expect(settled).toBe(false);

    await runtime.control(subjectFor(), 'resume');
    const resumed = await next;
    expect(resumed.success).toBe(true);
    expect(nextEntered).toBe(true);
    expect(settled).toBe(true);
    expect(fake.close).not.toHaveBeenCalled();
    expect(runtime.sessions.get(subjectFor().sessionId)?.state).toBe('running');
  });

  it('forwards a non-takeover abort reason through the coordinator and still closes', async () => {
    const { runtime, identity, fake, resumeStore, adapter, subjectFor } = createHarness();
    let abortReason: unknown = 'unset';
    let entered = false;
    const inflight = adapter.execute({
      identity,
      operationId: 'stop-navigate',
      action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/page' },
      executeProvider(signal) {
        entered = true;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortReason = signal.reason;
            reject(new Error('provider aborted'));
          }, { once: true });
        });
      },
    });
    await vi.waitFor(() => expect(entered).toBe(true));

    await runtime.control(subjectFor(), 'stop');
    await inflight;

    expect(abortReason).toBe('surface-stopped');
    expect(resumeStore.exportForConversation).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('stop while a browser action is blocked rejects once with SURFACE_SESSION_BUSY', async () => {
    const { runtime, identity, fake, adapter, subjectFor } = createHarness();
    let inflightEntered = false;
    const inflight = adapter.execute({
      identity,
      operationId: 'inflight-before-stop',
      action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/page' },
      executeProvider(signal) {
        inflightEntered = true;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
        });
      },
    });
    await vi.waitFor(() => expect(inflightEntered).toBe(true));
    await runtime.control(subjectFor(), 'takeover');
    await inflight;

    let nextCalls = 0;
    const blocked = adapter.execute({
      identity,
      operationId: 'blocked-until-stop',
      action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/page' },
      async executeProvider() {
        nextCalls += 1;
        return { success: true, output: 'should not run' };
      },
    });
    await vi.waitFor(() => expect(fake.getDomSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(nextCalls).toBe(0);

    await runtime.control(subjectFor(), 'stop');
    const result = await blocked;
    expect(result).toMatchObject({
      success: false,
      metadata: { surfaceExecutionErrorV1: { code: 'SURFACE_SESSION_BUSY' } },
    });
    expect(nextCalls).toBe(0);
  });

  it('cap expiry while a browser action is blocked rejects once with SURFACE_SESSION_BUSY', async () => {
    vi.useFakeTimers();
    const { runtime, identity, fake, adapter, subjectFor } = createHarness();
    const setup = await adapter.execute({
      identity,
      operationId: 'setup-navigate',
      action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/page' },
      async executeProvider() {
        return { success: true, output: 'setup' };
      },
    });
    expect(setup.success).toBe(true);
    await runtime.control(subjectFor(), 'takeover');

    let blockedCalls = 0;
    const blocked = adapter.execute({
      identity,
      operationId: 'blocked-until-cap',
      action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/page' },
      async executeProvider() {
        blockedCalls += 1;
        return { success: true, output: 'should not run' };
      },
    });
    await vi.advanceTimersByTimeAsync(
      BROWSER_HUMAN_TAKEOVER_WAIT.CAP_MS + BROWSER_HUMAN_TAKEOVER_WAIT.POLL_INTERVAL_MS,
    );
    const result = await blocked;
    expect(result).toMatchObject({
      success: false,
      metadata: { surfaceExecutionErrorV1: { code: 'SURFACE_SESSION_BUSY' } },
    });
    expect(blockedCalls).toBe(0);
    expect(fake.close).not.toHaveBeenCalled();
  });
});
