// N-BROWSER-KEEP-RESULT-PAGE：keep → release 存活 → adopt 认领 → 用户释放不关窗
// 的 adapter 级链路（fake BrowserService + 真 SurfaceExecutionRuntime + 真 registry）。
import { describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import {
  ManagedBrowserProviderAdapter,
  MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY,
} from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import {
  KeptBrowserRegistry,
  type KeptBrowserPoolFacade,
} from '../../../../src/host/services/surfaceExecution/keptBrowserRegistry';
import { UserBrowserLinkService } from '../../../../src/host/services/surfaceExecution/UserBrowserLinkService';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../../src/shared/contract/surfaceExecution';
import type { BrowserResumeStateStore } from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';

const cronMocks = vi.hoisted(() => ({
  getSession: vi.fn(async () => undefined),
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: cronMocks.getSession }),
}));

// adapter 的 releaseBinding 走 browserPool.setInUse 单例：换成可断言的假池。
const poolMocks = vi.hoisted(() => ({
  setInUse: vi.fn(),
  setKept: vi.fn(),
  releaseAgent: vi.fn(async () => undefined),
}));
vi.mock('../../../../src/host/services/infra/browserPool', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/host/services/infra/browserPool')>();
  return {
    ...actual,
    browserPool: poolMocks as unknown as typeof actual.browserPool,
  };
});

function createNoopResumeStore(): BrowserResumeStateStore {
  return {
    exportForConversation: vi.fn(async () => '/secure/browser-resume-state/export.json'),
    importForConversation: vi.fn(async () => false),
    clearConversation: vi.fn(async () => undefined),
    activateConversation: vi.fn(),
  };
}

interface FakeTab {
  id: string;
  url: string;
  title: string;
}

function createFakeBrowser(options?: { initialTabs?: FakeTab[] }) {
  let running = false;
  let snapshot = 0;
  const tabs = new Map<string, FakeTab>([
    ...(options?.initialTabs ?? [{ id: 'tab-result', url: 'https://example.test/result', title: 'Result' }]),
  ].map((tab) => [tab.id, { ...tab }]));
  let activeTabId = tabs.keys().next().value ?? null;
  const listeners = new Set<(reason: string) => void>();
  const navigate = vi.fn(async (url: string, tabId?: string) => {
    const tab = tabs.get(tabId || activeTabId || '');
    if (tab) tab.url = url;
  });
  const service = {
    ensureSession: vi.fn(async () => {
      running = true;
      return {};
    }),
    isRunning: () => running,
    getActiveTab: () => (running ? tabs.get(activeTabId || '') ?? null : null),
    listTabs: () => Array.from(tabs.values()).map((tab) => ({ ...tab })),
    closeTab: vi.fn(async (tabId: string) => {
      tabs.delete(tabId);
      if (activeTabId === tabId) activeTabId = tabs.keys().next().value ?? null;
    }),
    switchTab: vi.fn(async (tabId: string) => {
      activeTabId = tabId;
    }),
    navigate,
    getSessionState: () => ({
      sessionId: 'managed-provider-session',
      profileId: 'isolated-profile',
      provider: 'system-chrome-cdp',
      running,
      tabCount: tabs.size,
      lease: null,
      activeTab: service.getActiveTab(),
    }),
    onSessionChanged: (listener: (reason: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitSessionChangedForTest: (reason: string) => {
      for (const listener of listeners) listener(reason);
    },
    getDomSnapshot: vi.fn(async () => {
      snapshot += 1;
      const tab = service.getActiveTab();
      return {
        snapshotId: `snapshot-${snapshot}`,
        tabId: tab?.id ?? 'tab-result',
        capturedAtMs: Date.now(),
        url: tab?.url ?? 'https://example.test/result',
        title: tab?.title ?? 'Result',
        headings: [],
        interactiveElements: [],
      };
    }),
    close: vi.fn(async () => {
      running = false;
    }),
    setLeaseInUse: vi.fn(),
  };
  return {
    service: service as unknown as BrowserService,
    raw: service,
    navigate,
    tabs,
    setActiveTab: (id: string) => { activeTabId = id; },
    setRunning: (value: boolean) => { running = value; },
  };
}

function createKeptPool(): { pool: KeptBrowserPoolFacade } {
  return {
    pool: {
      setKept: poolMocks.setKept,
      releaseAgent: poolMocks.releaseAgent,
    },
  };
}

function createHarness(options?: { initialTabs?: FakeTab[] }) {
  const registry = new RunRegistry();
  registry.start({ runId: 'run-a', sessionId: 'conversation-a', workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const identity: SurfaceRuntimeIdentityV1 = {
    conversationId: 'conversation-a',
    runId: 'run-a',
    agentId: 'agent-a',
  };
  const fake = createFakeBrowser(options);
  const release = vi.fn(async () => fake.raw.close());
  const acquire = vi.fn((_serviceKey: string | null) => fake.service);
  const keptPool = createKeptPool();
  const keptRegistry = new KeptBrowserRegistry(keptPool.pool);
  const adapter = new ManagedBrowserProviderAdapter(
    runtime,
    acquire,
    release,
    createNoopResumeStore(),
    undefined,
    keptRegistry,
  );
  const links = new UserBrowserLinkService(registry, runtime, adapter, keptRegistry);
  return { registry, runtime, identity, fake, acquire, release, adapter, keptRegistry, links };
}

async function executeAction(
  adapter: ManagedBrowserProviderAdapter,
  identity: SurfaceRuntimeIdentityV1,
  operationId: string,
  action = 'navigate',
) {
  return adapter.execute({
    identity,
    operationId,
    action,
    params: { action },
    async executeProvider() {
      return { success: true, output: `${action} ok` };
    },
  });
}

describe('managed browser keep result page (N-BROWSER-KEEP-RESULT-PAGE)', () => {
  it('keeps the window alive across agent run end: no release, no close, pool entry idle + kept', async () => {
    const { runtime, identity, fake, release, adapter, keptRegistry } = createHarness();
    expect((await executeAction(adapter, identity, 'nav-1')).success).toBe(true);

    const kept = adapter.markResultPageKept(identity, {
      url: 'https://example.test/result',
      title: 'Result',
    });
    expect(kept).toEqual({ ok: true, serviceKey: expect.stringMatching(/^surface-/) });
    expect(keptRegistry.getAlive('conversation-a')).toMatchObject({
      url: 'https://example.test/result',
      state: 'kept',
    });

    await runtime.endRun(identity);

    expect(release).not.toHaveBeenCalled();
    expect(fake.raw.close).not.toHaveBeenCalled();
    expect(fake.raw.setLeaseInUse).toHaveBeenLastCalledWith(false);
    expect(poolMocks.setKept).toHaveBeenCalledWith(expect.stringMatching(/^surface-/), true);
  });

  it('refreshes the kept URL at run release when the model navigated after keeping', async () => {
    const { runtime, identity, fake, adapter, keptRegistry } = createHarness();
    await executeAction(adapter, identity, 'nav-1');
    adapter.markResultPageKept(identity, { url: 'https://example.test/result', title: 'Result' });

    // keep 之后模型又把活跃页导航到了最终结果。
    fake.tabs.set('tab-result', { id: 'tab-result', url: 'https://example.test/final', title: 'Final' });
    await runtime.endRun(identity);

    expect(keptRegistry.getAlive('conversation-a')).toMatchObject({
      url: 'https://example.test/final',
      title: 'Final',
    });
  });

  it('refuses to keep the personal-profile binding (user-shared window)', async () => {
    const { runtime, adapter, registry } = createHarness();
    const userHandle = registry.startAuxiliary({
      runId: 'run-user-browser',
      sessionId: 'conversation-a',
      workspace: process.cwd(),
    });
    const userIdentity: SurfaceRuntimeIdentityV1 = {
      conversationId: 'conversation-a',
      runId: userHandle.context.runId,
      agentId: SURFACE_USER_BROWSER_AGENT_ID,
    };
    await executeAction(adapter, userIdentity, 'user-nav-1');

    const kept = adapter.markResultPageKept(userIdentity, {
      url: 'https://example.test/result',
      title: 'Result',
    });

    expect(kept).toEqual({
      ok: false,
      reason: expect.stringContaining('personal browser profile'),
    });
    await runtime.endRun(userIdentity);
  });

  it('adopts the kept window for the user without navigating, and user release keeps it alive', async () => {
    const { runtime, registry, identity, fake, release, adapter, keptRegistry, links } = createHarness();
    await executeAction(adapter, identity, 'nav-1');
    adapter.markResultPageKept(identity, { url: 'https://example.test/result', title: 'Result' });
    await runtime.endRun(identity);
    release.mockClear();

    const adopted = await links.adopt({ conversationId: 'conversation-a', workspace: process.cwd() });

    expect(adopted.surfaceSessionId).toBeTruthy();
    expect(adopted.snapshot.conversationId).toBe('conversation-a');
    // 绑上的是 kept 服务键，不是个人 __default__；没有发生导航。
    const binding = adapter.getBinding({
      conversationId: 'conversation-a',
      runId: adopted.runId,
      agentId: SURFACE_USER_BROWSER_AGENT_ID,
    } as SurfaceRuntimeIdentityV1);
    expect(binding?.serviceKey).toBe(keptRegistry.getAlive('conversation-a')?.serviceKey);
    expect(binding?.serviceKey).not.toBe(MANAGED_BROWSER_USER_PERSONAL_SERVICE_KEY);
    expect(fake.navigate).not.toHaveBeenCalled();
    expect(fake.raw.ensureSession).toHaveBeenLastCalledWith('about:blank', expect.objectContaining({
      leaseOwner: 'user-personal-browser',
    }));

    // 用户关掉 rail：user run 结束，kept 窗不关。
    await links.end('conversation-a', 'user');
    expect(fake.raw.close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(keptRegistry.getAlive('conversation-a')).not.toBeNull();

    // 闲置回收（lease 到期关窗）后：closed + URL 留存。
    fake.raw.emitSessionChangedForTest('close');
    expect(keptRegistry.getAlive('conversation-a')).toBeNull();
    expect(keptRegistry.snapshot('conversation-a')).toMatchObject({
      state: 'closed',
      url: 'https://example.test/result',
    });
  });

  it('adopt falls back to a plain error when no kept window exists', async () => {
    const { links } = createHarness();
    await expect(links.adopt({
      conversationId: 'conversation-a',
      workspace: process.cwd(),
    })).rejects.toThrow('No kept result page is open');
  });

  it('a newer keep from another run closes the older kept window', async () => {
    const { runtime, registry, adapter, keptRegistry } = createHarness();
    registry.startAuxiliary({
      runId: 'run-b',
      sessionId: 'conversation-a',
      workspace: process.cwd(),
    });
    const secondIdentity: SurfaceRuntimeIdentityV1 = {
      conversationId: 'conversation-a',
      runId: 'run-b',
      agentId: 'agent-a',
    };

    await executeAction(adapter, { ...{ conversationId: 'conversation-a', runId: 'run-a', agentId: 'agent-a' } }, 'nav-1');
    const firstKept = adapter.markResultPageKept(
      { conversationId: 'conversation-a', runId: 'run-a', agentId: 'agent-a' },
      { url: 'https://example.test/first', title: 'First' },
    );
    expect(firstKept.ok).toBe(true);
    const firstKey = firstKept.ok ? firstKept.serviceKey : '';

    await executeAction(adapter, secondIdentity, 'nav-2');
    const secondKept = adapter.markResultPageKept(secondIdentity, {
      url: 'https://example.test/second',
      title: 'Second',
    });
    expect(secondKept.ok).toBe(true);

    expect(keptRegistry.getAlive('conversation-a')).toMatchObject({
      serviceKey: secondKept.ok ? secondKept.serviceKey : '',
      url: 'https://example.test/second',
    });
    expect(poolMocks.releaseAgent).toHaveBeenCalledWith(firstKey);
    await runtime.endRun(secondIdentity);
  });
});
