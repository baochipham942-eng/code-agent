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
} from '../../../../src/shared/constants/timeouts';

// N-BROWSER-SECRETREF-HARDEN-FU1-FU2-FU1 ①：cap 过期的 BUSY(waiting_human) 浏览器
// 动作结果，模型可见文本（transcriptProjection 的 result.output || result.error）
// 必须带上「用户还在用浏览器 / 不要重试 / 请用户按继续」的指引。
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
  const getDomSnapshot = vi.fn(async () => ({
    snapshotId: 'snapshot-1',
    tabId: 'managed-tab-1',
    capturedAtMs: 1,
    url: 'https://example.test/page',
    title: 'Example',
    headings: [],
    interactiveElements: [],
  }));
  const service = {
    ensureSession: vi.fn(async () => { running = true; }),
    isRunning: () => running,
    getActiveTab: () => (running ? { id: 'managed-tab-1' } : null),
    getSessionState: () => ({
      sessionId: 'managed-provider-session',
      profileId: 'isolated-profile',
      provider: 'system-chrome-cdp',
      running,
      tabCount: running ? 1 : 0,
      activeTab: running ? { id: 'managed-tab-1', url: 'https://example.test/page', title: 'Example', canGoBack: false, canGoForward: false } : null,
    }),
    onSessionChanged: () => () => undefined,
    getDomSnapshot,
    close: vi.fn(async () => { running = false; }),
    setLeaseInUse: vi.fn(),
  };
  return { service: service as unknown as BrowserService, getDomSnapshot };
}

function createHarness() {
  const registry = new RunRegistry();
  registry.start({ runId: 'run-a', sessionId: 'conversation-a', workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const identity: SurfaceRuntimeIdentityV1 = {
    conversationId: 'conversation-a', runId: 'run-a', agentId: 'agent-a',
  };
  const fake = createFakeBrowser();
  const adapter = new ManagedBrowserProviderAdapter(
    runtime, () => fake.service, async () => undefined, createNoopResumeStore(),
  );
  const subjectFor = () => {
    const binding = adapter.getBinding(identity);
    if (!binding) throw new Error('managed browser binding was not created');
    return { sessionId: binding.surfaceSessionId, runId: identity.runId, agentId: identity.agentId };
  };
  return { runtime, identity, fake, adapter, subjectFor };
}

afterEach(() => { vi.useRealTimers(); });

describe('model-visible BUSY(waiting_human) tool text (FU1-FU2-FU1 ①②)', () => {
  it('cap-expired BUSY message carries the do-not-retry / press-Continue guidance', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    const setup = await h.adapter.execute({
      identity: h.identity, operationId: 'setup', action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/page' },
      async executeProvider() { return { success: true, output: 'setup' }; },
    });
    expect(setup.success).toBe(true);
    await h.runtime.control(h.subjectFor(), 'takeover');
    expect(h.runtime.sessions.get(h.subjectFor().sessionId)?.state).toBe('waiting_human');

    let dispatched = 0;
    const p = h.adapter.execute({
      identity: h.identity, operationId: 'ro-cap', action: 'get_dom_snapshot',
      params: { action: 'get_dom_snapshot' },
      async executeProvider() { dispatched += 1; return { success: true, output: 'should not run' }; },
    });
    await vi.advanceTimersByTimeAsync(
      BROWSER_HUMAN_TAKEOVER_WAIT.CAP_MS + BROWSER_HUMAN_TAKEOVER_WAIT.POLL_INTERVAL_MS,
    );
    const result = await p;

    expect(dispatched).toBe(0);
    expect(result).toMatchObject({
      success: false,
      metadata: { surfaceExecutionErrorV1: { code: 'SURFACE_SESSION_BUSY', userActionRequired: true } },
    });
    const text = (result as { output?: unknown; error?: unknown }).output
      || (result as { error?: unknown }).error
      || '';
    // ①证据：修改前这里是裸 "Browser Surface session cannot start an operation
    // while waiting_human."；修改后必须含指引。
    expect(String(text)).toContain('Browser Surface session cannot start an operation while waiting_human.');
    expect(String(text)).toMatch(/user (is still using|still holds|has taken over) the browser/i);
    expect(String(text)).toMatch(/do not retry/i);
    expect(String(text)).toMatch(/press Continue|click Continue|按「继续」|press 继续/i);
  });
});
