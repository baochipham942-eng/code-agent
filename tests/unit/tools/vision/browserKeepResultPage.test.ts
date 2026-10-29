// N-BROWSER-KEEP-RESULT-PAGE：keep_result_page 处理器——拒绝面 + 关多余标签 + 标记 kept。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { executeKeepResultPage } from '../../../../src/host/tools/vision/browserKeepResultPage';
import type { SurfaceRuntimeIdentityV1 } from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import type { ManagedBrowserProviderAdapter } from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';

const permissionMocks = vi.hoisted(() => ({
  isUnattendedSession: vi.fn(() => false),
}));

vi.mock('../../../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    isUnattendedSession: permissionMocks.isUnattendedSession,
  }),
}));

const identity: SurfaceRuntimeIdentityV1 = {
  conversationId: 'conversation-a',
  runId: 'run-a',
  agentId: 'agent-a',
};

function createBrowser(tabs: Array<{ id: string; url: string; title: string }>, activeId: string) {
  const openTabs = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  return {
    listTabs: () => Array.from(openTabs.values()).map((tab) => ({ ...tab })),
    getActiveTab: () => (openTabs.get(activeId) ? { ...openTabs.get(activeId)! } : null),
    closeTab: vi.fn(async (tabId: string) => {
      openTabs.delete(tabId);
    }),
    remaining: () => Array.from(openTabs.keys()),
  };
}

function createAdapter(options?: {
  serviceKey?: string;
  kept?: { ok: true; serviceKey: string } | { ok: false; reason: string };
}) {
  return {
    getBinding: vi.fn(() => ({
      serviceKey: options?.serviceKey ?? 'surface-key-1',
    })),
    markResultPageKept: vi.fn(() => options?.kept ?? { ok: true, serviceKey: 'surface-key-1' }),
  } as unknown as Pick<ManagedBrowserProviderAdapter, 'markResultPageKept' | 'getBinding'>;
}

beforeEach(() => {
  permissionMocks.isUnattendedSession.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('keep_result_page handler', () => {
  it('closes every tab except the active result tab and marks the binding kept', async () => {
    const browser = createBrowser([
      { id: 'tab-search', url: 'https://example.test/search', title: 'Search' },
      { id: 'tab-result', url: 'https://example.test/result', title: 'Result' },
      { id: 'tab-docs', url: 'https://example.test/docs', title: 'Docs' },
    ], 'tab-result');
    const adapter = createAdapter();

    const result = await executeKeepResultPage({
      identity,
      browserService: browser,
      context: { sessionId: 'conversation-a' },
      params: { action: 'keep_result_page' },
      adapter,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('https://example.test/result');
    expect(browser.remaining()).toEqual(['tab-result']);
    expect(adapter.markResultPageKept).toHaveBeenCalledWith(identity, {
      url: 'https://example.test/result',
      title: 'Result',
    });
  });

  it('refuses the relay engine with a plain sentence and closes nothing', async () => {
    const browser = createBrowser([{ id: 'tab-result', url: 'https://example.test/result', title: 'Result' }], 'tab-result');
    const adapter = createAdapter();

    const result = await executeKeepResultPage({
      identity,
      browserService: browser,
      context: { sessionId: 'conversation-a' },
      params: { action: 'keep_result_page', engine: 'relay' },
      adapter,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('relay engine');
    expect(adapter.markResultPageKept).not.toHaveBeenCalled();
  });

  it('refuses unattended/scheduled runs', async () => {
    permissionMocks.isUnattendedSession.mockReturnValue(true);
    const adapter = createAdapter();

    const result = await executeKeepResultPage({
      identity,
      browserService: createBrowser([{ id: 'tab-result', url: 'https://example.test/r', title: 'R' }], 'tab-result'),
      context: { sessionId: 'conversation-a' },
      params: { action: 'keep_result_page' },
      adapter,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('unattended or scheduled runs');
    expect(adapter.markResultPageKept).not.toHaveBeenCalled();
  });

  it('refuses a run without surface identity (legacy caller)', async () => {
    const result = await executeKeepResultPage({
      identity: null,
      browserService: createBrowser([{ id: 'tab-result', url: 'https://example.test/r', title: 'R' }], 'tab-result'),
      context: { sessionId: 'conversation-a' },
      params: { action: 'keep_result_page' },
      adapter: createAdapter(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('managed browser session');
  });

  it('refuses the personal profile binding before closing any tab', async () => {
    const browser = createBrowser([
      { id: 'tab-result', url: 'https://example.test/result', title: 'Result' },
      { id: 'tab-other', url: 'https://example.test/other', title: 'Other' },
    ], 'tab-result');
    const adapter = createAdapter({ serviceKey: '__default__' });

    const result = await executeKeepResultPage({
      identity,
      browserService: browser,
      context: { sessionId: 'conversation-a' },
      params: { action: 'keep_result_page' },
      adapter,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('personal browser profile');
    expect(browser.remaining()).toEqual(['tab-result', 'tab-other']);
    expect(adapter.markResultPageKept).not.toHaveBeenCalled();
  });

  it('refuses when no binding exists for the run', async () => {
    const adapter = {
      getBinding: vi.fn(() => null),
      markResultPageKept: vi.fn(),
    } as unknown as Pick<ManagedBrowserProviderAdapter, 'markResultPageKept' | 'getBinding'>;

    const result = await executeKeepResultPage({
      identity,
      browserService: createBrowser([{ id: 'tab-result', url: 'https://example.test/r', title: 'R' }], 'tab-result'),
      context: { sessionId: 'conversation-a' },
      params: { action: 'keep_result_page' },
      adapter,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Open the result page');
  });

  it('refuses when there is no active tab', async () => {
    const result = await executeKeepResultPage({
      identity,
      browserService: createBrowser([], 'tab-none'),
      context: { sessionId: 'conversation-a' },
      params: { action: 'keep_result_page' },
      adapter: createAdapter(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No active tab');
  });
});
