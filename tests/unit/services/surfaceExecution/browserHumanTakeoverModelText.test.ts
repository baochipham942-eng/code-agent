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

// N-BROWSER-SECRETREF-HARDEN-FU1-FU2-FU1-FU1 ③④：cap-expired BUSY 每个
// waiting_human episode 只附送一次完整 100s 等待——模型无视指引再次调用时
// 立即返回同一条 BUSY；用户按继续（resume）后新一轮 takeover 重新完整等待。
describe('cap-expired BUSY waits once per waiting_human episode (FU1-FU2-FU1-FU1 ③④)', () => {
  const setupTakeover = async (h: ReturnType<typeof createHarness>, operationId: string) => {
    const setup = await h.adapter.execute({
      identity: h.identity, operationId, action: 'navigate',
      params: { action: 'navigate', url: 'https://example.test/page' },
      async executeProvider() { return { success: true, output: 'setup' }; },
    });
    expect(setup.success).toBe(true);
    await h.runtime.control(h.subjectFor(), 'takeover');
    expect(h.runtime.sessions.get(h.subjectFor().sessionId)?.state).toBe('waiting_human');
  };
  const snapshotAction = (
    h: ReturnType<typeof createHarness>, calls: { n: number }, operationId: string,
  ) => h.adapter.execute({
    identity: h.identity, operationId, action: 'get_dom_snapshot',
    params: { action: 'get_dom_snapshot' },
    async executeProvider() { calls.n += 1; return { success: true, output: 'should not run' }; },
  });
  const expectBusyWithGuidance = (result: unknown) => {
    expect(result).toMatchObject({
      success: false,
      metadata: { surfaceExecutionErrorV1: { code: 'SURFACE_SESSION_BUSY', userActionRequired: true } },
    });
    const text = String((result as { output?: unknown; error?: unknown }).output
      || (result as { error?: unknown }).error || '');
    expect(text).toContain('Browser Surface session cannot start an operation while waiting_human.');
    expect(text).toMatch(/do not retry/i);
  };

  it('second call in the same episode returns BUSY immediately (no second 100s wait)', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    await setupTakeover(h, 'once-setup');
    const calls = { n: 0 };

    // 第一次：等满 cap 才 BUSY。
    const first = snapshotAction(h, calls, 'once-cap-1');
    await vi.advanceTimersByTimeAsync(
      BROWSER_HUMAN_TAKEOVER_WAIT.CAP_MS + BROWSER_HUMAN_TAKEOVER_WAIT.POLL_INTERVAL_MS,
    );
    expectBusyWithGuidance(await first);
    expect(calls.n).toBe(0);
    const afterFirst = Date.now();

    // 第二次：同一 waiting_human episode 内再调用 → 立即 BUSY，不推进假时钟。
    let settled = false;
    const second = snapshotAction(h, calls, 'once-cap-2').then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expectBusyWithGuidance(await second);
    expect(calls.n).toBe(0);
    expect(Date.now()).toBe(afterFirst);
  });

  it('fresh takeover after Continue gets a full first wait again', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    await setupTakeover(h, 'fresh-setup');
    const calls = { n: 0 };

    // 先耗掉第一次 cap-expired BUSY，让记忆存在。
    const first = snapshotAction(h, calls, 'fresh-cap-1');
    await vi.advanceTimersByTimeAsync(
      BROWSER_HUMAN_TAKEOVER_WAIT.CAP_MS + BROWSER_HUMAN_TAKEOVER_WAIT.POLL_INTERVAL_MS,
    );
    expectBusyWithGuidance(await first);

    // 用户按继续（resume 清记忆）→ 再次接管 → 下一次调用重新完整等待。
    await h.runtime.control(h.subjectFor(), 'resume');
    await h.runtime.control(h.subjectFor(), 'takeover');
    let settled = false;
    const second = snapshotAction(h, calls, 'fresh-cap-2').then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(calls.n).toBe(0);
    const waitStart = Date.now();
    await vi.advanceTimersByTimeAsync(
      BROWSER_HUMAN_TAKEOVER_WAIT.CAP_MS + BROWSER_HUMAN_TAKEOVER_WAIT.POLL_INTERVAL_MS,
    );
    expect(settled).toBe(true);
    expectBusyWithGuidance(await second);
    expect(calls.n).toBe(0);
    expect(Date.now() - waitStart)
      .toBeGreaterThanOrEqual(BROWSER_HUMAN_TAKEOVER_WAIT.CAP_MS);
  });
});
