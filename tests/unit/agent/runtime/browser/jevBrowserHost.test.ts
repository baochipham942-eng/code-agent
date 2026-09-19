import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedJevBrowserHost } from '../../../../../src/host/agent/runtime/browser/jevBrowserHost';
import { redactBrowserWorkbenchTraceParams } from '../../../../../src/host/services/infra/browser/managedBrowserHelpers';
import type { BrowserService } from '../../../../../src/host/services/infra/browserService';
import type { BrowserTargetRef } from '../../../../../src/host/services/infra/browser/types';

function targetRef(): BrowserTargetRef {
  return {
    refId: 'tref_email',
    source: 'dom',
    selector: 'input#email',
    role: 'textbox',
    name: 'Email',
    textHint: 'Email',
    frameId: 'FRAME',
    documentRevision: 'rev',
    tabId: 'tab',
    snapshotId: 'snap',
    capturedAtMs: 1,
    ttlMs: 60_000,
    confidence: 0.9,
    rect: { x: 0, y: 0, width: 160, height: 24 },
  };
}

function makeTracedService(overrides: Partial<{
  typeTargetRef: BrowserService['typeTargetRef'];
  clickTargetRef: BrowserService['clickTargetRef'];
}> = {}) {
  const traces: Array<{ action: string; params: Record<string, unknown>; success?: boolean; error?: string | null }> = [];
  const service = {
    logger: { log: vi.fn(), getLogsAsString: vi.fn(() => '') },
    traces,
    lastTrace: () => traces.at(-1) || null,
    beginTrace: vi.fn((args: { toolName: string; action: string; params?: Record<string, unknown> }) => {
      const trace = {
        id: `trace-${traces.length + 1}`,
        targetKind: 'browser' as const,
        toolName: args.toolName,
        action: args.action,
        params: redactBrowserWorkbenchTraceParams(args.toolName, args.params || {}),
        startedAtMs: Date.now(),
      };
      traces.push({ action: args.action, params: trace.params as Record<string, unknown> });
      return trace;
    }),
    finishTrace: vi.fn((trace: { id: string }, result: { success: boolean; error?: string | null }) => {
      const current = traces.find((item) => item.params && traces.indexOf(item) === traces.length - 1) || traces.at(-1);
      if (current) {
        current.success = result.success;
        current.error = result.error ?? null;
      }
      return { ...trace, ...result, completedAtMs: Date.now() };
    }),
    isRunning: vi.fn(() => true),
    getActiveTab: vi.fn(() => ({ id: 'tab', url: 'http://127.0.0.1/page', title: 'Page' })),
    typeTargetRef: overrides.typeTargetRef ?? vi.fn(async () => undefined),
    clickTargetRef: overrides.clickTargetRef ?? vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    pressKey: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    newTab: vi.fn(async () => undefined),
    launch: vi.fn(async () => undefined),
    captureJevPage: vi.fn(async () => ({})),
    getDialogState: vi.fn(() => ({ pending: false })),
    getPageContent: vi.fn(async () => ({ url: 'http://127.0.0.1/page', title: 'Page', text: '' })),
  };
  return service;
}

describe('createManagedJevBrowserHost', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('内环 type 的 workbench trace 把 text 收成 [redacted N chars] 而不是明文', async () => {
    const secret = 'hunter2-secret-value';
    const service = makeTracedService();
    const host = createManagedJevBrowserHost(service as unknown as BrowserService);
    await host.typeTargetRef(targetRef(), secret);

    const lastTrace = service.lastTrace();
    expect(lastTrace?.params.text).toBe(`[redacted ${secret.length} chars]`);
    expect(JSON.stringify(lastTrace?.params)).not.toContain(secret);
    expect(String(lastTrace?.params.text)).toMatch(/^\[redacted \d+ chars\]$/);
    expect(lastTrace?.params.action).toBe('type');
    expect(service.beginTrace).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'browser_action',
      action: 'type',
      params: expect.objectContaining({ action: 'type' }),
    }));
  });

  it('click/type 超过 2.5s 未完成则抛 timeout，trace 记失败', async () => {
    vi.useFakeTimers();
    const service = makeTracedService({
      typeTargetRef: vi.fn(() => new Promise<BrowserTargetRef>(() => {})),
    });
    const host = createManagedJevBrowserHost(service as unknown as BrowserService);
    const pending = host.typeTargetRef(targetRef(), 'secret-password-value');
    const expectation = expect(pending).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(2500);
    await expectation;
    expect(service.lastTrace()?.success).toBe(false);
    expect(service.lastTrace()?.error).toBe('timeout');
  });
});
