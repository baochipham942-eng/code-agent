import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { ManagedBrowserProviderAdapter } from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import type { BrowserResumeStateStore } from '../../../../src/host/services/surfaceExecution/BrowserResumeStateStore';
import { typeSecret } from '../../../../src/host/tools/vision/browserSecretRefGuard';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../../src/shared/contract/surfaceExecution';

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => undefined }),
}));

const SECRET = 'hunter2-Zq9!fixture';
const NAME = 'CODE_AGENT_BROWSER_SECRET_TAKEOVER_PWD';
const ORIGINS = `${NAME}_ORIGINS`;

function createFakeBrowser(getUrl: () => string) {
  let running = false;
  let snapshot = 0;
  const close = vi.fn(async () => { running = false; });
  const typed = vi.fn(async () => undefined);
  const service = {
    ensureSession: vi.fn(async () => { running = true; return {}; }),
    isRunning: () => running,
    getActiveTab: () => (running ? { id: 'tab-1' } : null),
    getLiveTabUrl: () => getUrl(),
    getSessionState: () => ({
      sessionId: 'takeover-session',
      profileId: 'isolated-profile',
      provider: 'system-chrome-cdp',
      running,
      tabCount: running ? 1 : 0,
      lease: running
        ? { leaseId: 'l', owner: 'managed-browser', acquiredAtMs: 1, lastHeartbeatAtMs: 1, expiresAtMs: Number.MAX_SAFE_INTEGER, ttlMs: 1800000, status: 'active' as const }
        : null,
      activeTab: running ? { id: 'tab-1', url: getUrl(), title: 'T', canGoBack: false, canGoForward: false } : null,
    }),
    onSessionChanged: () => () => undefined,
    getDomSnapshot: vi.fn(async () => {
      snapshot += 1;
      return {
        snapshotId: `snapshot-${snapshot}`,
        tabId: 'tab-1',
        capturedAtMs: Date.now(),
        url: getUrl(),
        title: 'T',
        headings: [],
        interactiveElements: [],
      };
    }),
    getElementBoundingBox: vi.fn(async () => ({ x: 1, y: 2, width: 3, height: 4 })),
    type: typed,
    typeTargetRef: typed,
    exportStorageState: vi.fn(async () => ({ path: '/x', accountState: {} })),
    close,
    setLeaseInUse: vi.fn(),
  };
  return { service: service as unknown as BrowserService, close, typed };
}

function setup(url: string, identityOverride?: Partial<SurfaceRuntimeIdentityV1>) {
  const registry = new RunRegistry();
  registry.start({ runId: 'run-a', sessionId: 'conversation-a', workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const identity: SurfaceRuntimeIdentityV1 = {
    conversationId: 'conversation-a',
    runId: 'run-a',
    agentId: 'agent-a',
    ...identityOverride,
  };
  const fake = createFakeBrowser(() => url);
  const resumeStore: BrowserResumeStateStore = {
    exportForConversation: vi.fn(async () => '/x'),
    importForConversation: vi.fn(async () => false),
    clearConversation: vi.fn(async () => undefined),
    activateConversation: vi.fn(),
  };
  const logs: string[] = [];
  const logger = {
    warn: (m: string, meta?: unknown) => { logs.push(`warn ${m} ${JSON.stringify(meta)}`); },
    error: (m: string, meta?: unknown) => { logs.push(`error ${m} ${JSON.stringify(meta)}`); },
  };
  const adapter = new ManagedBrowserProviderAdapter(runtime, () => fake.service, vi.fn(async () => undefined), resumeStore, logger);
  const run = (action: string, operationId: string, executeProvider: (b: BrowserService) => Promise<any>) =>
    adapter.execute({
      identity,
      operationId,
      action,
      params: { action },
      executeProvider: (_signal, b) => executeProvider(b),
    });
  const typeStep = (operationId = 'type-1') =>
    run('type', operationId, (b) => typeSecret({ browserService: b as never, secretRef: `env:${NAME}`, selector: '#pw' }));
  const ids = { sessionId: '' };
  const prep = async () => {
    const r = await run('get_dom_snapshot', 'prep', async (b) => ({ success: true, metadata: { domSnapshot: await b.getDomSnapshot() } }));
    ids.sessionId = (r.metadata as any).surfaceExecutionSessionV1.sessionId;
    return r;
  };
  const state = (result: any): string => result.metadata?.surfaceExecutionSessionV1?.state;
  return { runtime, identity, fake, adapter, run, typeStep, prep, logs, state, ids };
}

describe('secretRef origin mismatch hands the browser to the user', () => {
  beforeEach(() => {
    process.env[NAME] = SECRET;
    delete process.env[ORIGINS];
  });
  afterEach(() => {
    delete process.env[NAME];
    delete process.env[ORIGINS];
  });

  it('① mismatch moves the session to waiting_human, types nothing, keeps the window open', async () => {
    process.env[ORIGINS] = 'https://app.example.test';
    const h = setup('https://idp.other.test/login');
    await h.prep();
    const result = await h.typeStep();
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('SECRET_REF_ORIGIN_MISMATCH');
    expect(h.state(result)).toBe('waiting_human');
    expect(h.runtime.sessions.requireOwned(h.ids.sessionId, subjectOf(h)).state).toBe('waiting_human');
    expect(h.fake.typed).not.toHaveBeenCalled();
    expect(h.fake.close).not.toHaveBeenCalled();
    expect(result.error).toContain('belongs to the user');
    expect(result.error).toContain('get_dom_snapshot');
  });

  it('① missing allow-list also hands over', async () => {
    const h = setup('https://idp.other.test/login');
    await h.prep();
    const result = await h.typeStep();
    expect(h.state(result)).toBe('waiting_human');
    expect(h.fake.typed).not.toHaveBeenCalled();
  });

  it('② next action blocks until resume, then runs on the same service', async () => {
    process.env[ORIGINS] = 'https://app.example.test';
    const h = setup('https://idp.other.test/login');
    await h.prep();
    await h.typeStep();
    const seen: BrowserService[] = [];
    let settled = false;
    const next = h
      .run('navigate', 'next-1', async (b) => { seen.push(b); return { success: true, output: 'ok' }; })
      .then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    expect(seen).toHaveLength(0);
    await h.runtime.control(subjectOf(h), 'resume');
    const result = await next;
    expect(result.success).toBe(true);
    expect(seen).toEqual([h.fake.service]);
    expect(h.fake.close).not.toHaveBeenCalled();
  });

  it('③ allow-listed origin does not take over and types the secret', async () => {
    process.env[ORIGINS] = 'https://app.example.test';
    const h = setup('https://app.example.test/login');
    await h.prep();
    const result = await h.typeStep();
    expect(result.success).toBe(true);
    expect(h.fake.typed).toHaveBeenCalled();
    expect(h.state(result)).toBe('running');
    expect(h.runtime.sessions.requireOwned(h.ids.sessionId, subjectOf(h)).state).toBe('running');
  });

  it('③ user-browser identity does not take over', async () => {
    process.env[ORIGINS] = 'https://app.example.test';
    const h = setup('https://idp.other.test/login', { agentId: SURFACE_USER_BROWSER_AGENT_ID });
    await h.prep();
    const result = await h.typeStep();
    expect(result.metadata?.code).toBe('SECRET_REF_ORIGIN_MISMATCH');
    expect(h.runtime.sessions.requireOwned(h.ids.sessionId, subjectOf(h)).state).toBe('running');
  });

  it('⑤ the secret value appears in no result text or log', async () => {
    process.env[ORIGINS] = 'https://app.example.test';
    const h = setup('https://idp.other.test/login');
    await h.prep();
    const result = await h.typeStep();
    expect(JSON.stringify([result, h.logs])).not.toContain(SECRET);
  });
});

function subjectOf(h: ReturnType<typeof setup>) {
  return { sessionId: h.ids.sessionId, runId: h.identity.runId, agentId: h.identity.agentId };
}
