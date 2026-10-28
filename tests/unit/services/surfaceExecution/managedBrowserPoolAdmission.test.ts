import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { BrowserPool, BrowserPoolBusyError, browserPool } from '../../../../src/host/services/infra/browserPool';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import {
  ManagedBrowserProviderAdapter,
  MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY,
  managedBrowserServiceKey,
} from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../../src/shared/contract/surfaceExecution';
import type { BrowserResumeStateStore } from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';
import { BROWSER_TIMEOUTS } from '../../../../src/shared/constants/timeouts';

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async () => undefined,
  }),
}));
vi.mock('../../../../src/host/services/surfaceExecution/CronBrowserLoginState', () => ({
  importBrowserStorageStateForOrigin: async () => undefined,
}));

function createFake(key: string) {
  let running = false;
  const close = vi.fn(async () => {
    running = false;
  });
  const service = {
    ensureSession: vi.fn(async () => {
      running = true;
    }),
    close,
    isRunning: () => running,
    getActiveTab: () => (running ? { id: 'tab-1' } : null),
    getSessionState: () => ({
      sessionId: `session-${key}`,
      profileId: `profile-${key}`,
      provider: 'system-chrome-cdp',
      running,
      tabCount: running ? 1 : 0,
      activeTab: running
        ? { id: 'tab-1', url: 'about:blank', title: 'Example', canGoBack: false, canGoForward: false }
        : null,
    }),
    onSessionChanged: () => () => undefined,
    getDomSnapshot: vi.fn(async () => ({
      snapshotId: 'snapshot-1',
      tabId: 'tab-1',
      capturedAtMs: 1,
      url: 'about:blank',
      title: 'Example',
      headings: [],
      interactiveElements: [],
    })),
  };
  return { key, close, service: service as unknown as BrowserService };
}

function createResumeStore(): BrowserResumeStateStore {
  return {
    exportForConversation: async () => '/secure/browser-resume-state/export.json',
    importForConversation: async () => false,
    clearConversation: async () => undefined,
    activateConversation: () => undefined,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('managed browser pool admission', () => {
  it('does not mark the personal default key in use', async () => {
    const pool = new BrowserPool(4, createFake('__default__').service, (key) => createFake(key).service);
    const setInUse = vi.spyOn(browserPool, 'setInUse').mockImplementation((key, inUse) => {
      pool.setInUse(key, inUse);
    });
    vi.spyOn(browserPool, 'acquire').mockImplementation((agentId) => pool.acquire(agentId));
    const registry = new RunRegistry();
    registry.startAuxiliary({
      runId: 'run-user',
      sessionId: 'conversation-user',
      workspace: process.cwd(),
    });
    const adapter = new ManagedBrowserProviderAdapter(
      new SurfaceExecutionRuntime({ runRegistry: registry }),
      undefined,
      undefined,
      createResumeStore(),
    );
    const identity: SurfaceRuntimeIdentityV1 = {
      conversationId: 'conversation-user',
      runId: 'run-user',
      agentId: SURFACE_USER_BROWSER_AGENT_ID,
    };

    const result = await adapter.execute({
      identity,
      operationId: 'user-prep',
      action: 'get_dom_snapshot',
      params: { action: 'get_dom_snapshot' },
      async executeProvider(_signal, browserService) {
        return { success: true, metadata: { domSnapshot: await browserService.getDomSnapshot() } };
      },
    });

    expect(result.success).toBe(true);
    expect(managedBrowserServiceKey(identity)).toBe(MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY);
    expect(setInUse).not.toHaveBeenCalled();
  });

  it('keeps a thinking run browser when five managed runs overlap past the idle threshold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.setSystemTime(start);
    const fakes = new Map<string, ReturnType<typeof createFake>>();
    const pool = new BrowserPool(4, createFake('__default__').service, (key) => {
      const fake = createFake(key);
      fakes.set(key, fake);
      return fake.service;
    });
    vi.spyOn(browserPool, 'acquire').mockImplementation((agentId) => pool.acquire(agentId));
    vi.spyOn(browserPool, 'setInUse').mockImplementation((key, inUse) => {
      pool.setInUse(key, inUse);
    });
    vi.spyOn(browserPool, 'releaseAgent').mockImplementation((key) => pool.releaseAgent(key));

    const registry = new RunRegistry();
    const chats: SurfaceRuntimeIdentityV1[] = [0, 1, 2, 3, 4].map((index) => ({
      conversationId: `conversation-${index}`,
      runId: `run-${index}`,
      agentId: `agent-${index}`,
    }));
    for (const identity of chats) {
      registry.start({
        runId: identity.runId,
        sessionId: identity.conversationId,
        workspace: process.cwd(),
      });
    }
    const adapter = new ManagedBrowserProviderAdapter(
      new SurfaceExecutionRuntime({ runRegistry: registry }),
      undefined,
      undefined,
      createResumeStore(),
    );
    const execute = (identity: SurfaceRuntimeIdentityV1, operationId: string) => adapter.execute({
      identity,
      operationId,
      action: 'get_dom_snapshot',
      params: { action: 'get_dom_snapshot' },
      async executeProvider(_signal, browserService) {
        return { success: true, metadata: { domSnapshot: await browserService.getDomSnapshot() } };
      },
    });

    const held = await Promise.all(chats.slice(0, 4).map((identity, index) => execute(identity, `prep-${index}`)));
    expect(held.every((result) => result.success)).toBe(true);

    const thinking = chats[0];
    const thinkingKey = managedBrowserServiceKey(thinking);
    vi.setSystemTime(start + BROWSER_TIMEOUTS.POOL_IDLE_RECLAIM + 1_000);
    for (const identity of chats.slice(1, 4)) {
      pool.acquire(managedBrowserServiceKey(identity));
    }

    const fifth = await execute(chats[4], 'prep-fifth');

    expect(fifth.success).toBe(false);
    expect(fifth.error).toBe(new BrowserPoolBusyError(4).message);
    expect(fakes.get(thinkingKey)?.close).not.toHaveBeenCalled();
    expect(pool.hasAgent(thinkingKey)).toBe(true);
    for (const identity of chats.slice(0, 4)) {
      expect(fakes.get(managedBrowserServiceKey(identity))?.close).not.toHaveBeenCalled();
    }
    expect(pool.hasAgent(managedBrowserServiceKey(chats[4]))).toBe(false);
  });
});
