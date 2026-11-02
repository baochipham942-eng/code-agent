/**
 * N-JEV-BROWSER-ARMED-REST2-FU1: RBS-07 showed the main-model continuation after a Jev
 * `low_confidence` hand-back clicking "Delete" with no approval request, because the
 * risky-target gate lived only inside the Jev inner loop. The continuation (same
 * sessionId) must now inherit that gate; sessions Jev never ran in stay unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../../../../../src/host/services/infra/browserService';
import type { BrowserTargetRef } from '../../../../../src/host/services/infra/browser/types';
import { beginBrowserWorkbenchTrace, finishBrowserWorkbenchTrace } from '../../../../../src/host/services/infra/browser/browserTraceLifecycle';
import type { ToolContext } from '../../../../../src/host/tools/types';
import { answers, button, context, FakeHost, runLoop, snapshot, stubSystemOne, targetRef } from './jevBrowserTestKit';

type StubSurface = Pick<
  BrowserService,
  'resolveTargetRef' | 'findElements' | 'clickTargetRef' | 'getPageContent' | 'getActiveTab' | 'beginTrace' | 'finishTrace' | 'logger'
>;

const pool = vi.hoisted(() => ({ service: null as unknown }));
vi.mock('../../../../../src/host/services/infra/browserPool', () => ({
  BrowserPoolBusyError: class BrowserPoolBusyError extends Error {},
  getBrowserService: () => pool.service,
}));

import { browserActionTool } from '../../../../../src/host/tools/vision/browserAction';

class StubBrowserService implements StubSurface {
  clicks: string[] = [];
  readonly refs = new Map<string, BrowserTargetRef>();
  logger = { log: vi.fn(), getLogsAsString: () => '' } as unknown as BrowserService['logger'];
  async resolveTargetRef(input: unknown) {
    const refId = typeof input === 'string' ? input : (input as BrowserTargetRef).refId;
    const found = this.refs.get(refId);
    if (!found) throw new Error(`TargetRef ${refId} is stale or unknown`);
    return { targetRef: found };
  }
  async clickTargetRef(input: unknown) {
    const { targetRef: resolved } = await this.resolveTargetRef(input);
    this.clicks.push(resolved.refId);
    return resolved;
  }
  async findElements(selector: string) {
    return selector === 'button.added-manually'
      ? [{ selector, text: 'Delete', tagName: 'button', attributes: { class: 'added-manually' }, rect: { x: 0, y: 0, width: 50, height: 20 } }]
      : [];
  }
  async getPageContent() { return { url: 'https://example.test/', title: 'Shelf', text: 'A plain shelf page with controls.' }; }
  getActiveTab() { return null; }
  beginTrace(args: { toolName: string; action: string; params?: Record<string, unknown> }) {
    return beginBrowserWorkbenchTrace({
      ...args,
      mode: 'headless',
      providerDiagnostics: { provider: 'stub', executable: null, cdpPort: null, missingExecutable: false, recommendedAction: null } as never,
      profileDir: '/tmp/stub-profile',
      before: null,
    });
  }
  finishTrace(trace: ReturnType<BrowserService['beginTrace']>, args: { success: boolean; error?: string | null }) {
    return finishBrowserWorkbenchTrace(trace, { ...args, after: null, consoleErrors: [], networkFailures: [] });
  }
}

function managedContext(requestPermission: ToolContext['requestPermission']): ToolContext {
  return { ...context(requestPermission), sessionId: `fu1-${Math.random().toString(36).slice(2)}` };
}

async function jevLowConfidenceHandback(ctx: ToolContext): Promise<void> {
  const host = new FakeHost([snapshot('Shelf', [button('tref_go', 'Run')], 'http://127.0.0.1/handback')]);
  host.url = 'http://127.0.0.1/handback';
  const result = await runLoop(host, stubSystemOne(() => answers({ opConf: 0.4 })), { task: 'Remove the item' }, ctx);
  expect(result.status).toBe('fallback');
  expect(result.reason).toBe('low_confidence');
}

describe('Jev hand-back approval inheritance for the main-model Browser tool', () => {
  let service: StubBrowserService;
  beforeEach(() => {
    service = new StubBrowserService();
    service.refs.set('tref_delete', targetRef('tref_delete', 'Delete', { x: 0, y: 0, width: 50, height: 20 }));
    service.refs.set('tref_help', targetRef('tref_help', 'Help', { x: 0, y: 30, width: 50, height: 20 }));
    pool.service = service;
  });
  afterEach(() => vi.unstubAllEnvs());

  it('denied approval after a low_confidence hand-back blocks the Delete click', async () => {
    const requestPermission = vi.fn(async () => false);
    const ctx = managedContext(requestPermission);
    await jevLowConfidenceHandback(ctx);
    expect(requestPermission).not.toHaveBeenCalled();

    const result = await browserActionTool.execute({ action: 'click', targetRef: 'tref_delete' }, ctx);

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      forceConfirm: true,
      dangerLevel: 'danger',
      tool: 'browser_action.click',
    }));
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('SURFACE_APPROVAL_REQUIRED');
    expect(service.clicks).toEqual([]);
  });

  it('proceeds with the click once the user approves', async () => {
    const ctx = managedContext(vi.fn(async () => true));
    await jevLowConfidenceHandback(ctx);
    const result = await browserActionTool.execute({ action: 'click', targetRef: 'tref_delete' }, ctx);
    expect(result.success).toBe(true);
    expect(service.clicks).toEqual(['tref_delete']);
  });

  it('does not prompt for non-risky targets in a hand-back session', async () => {
    const requestPermission = vi.fn(async () => false);
    const ctx = managedContext(requestPermission);
    await jevLowConfidenceHandback(ctx);
    const result = await browserActionTool.execute({ action: 'click', targetRef: 'tref_help' }, ctx);
    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('leaves a session where Jev never ran unchanged (clicks Delete without asking)', async () => {
    const requestPermission = vi.fn(async () => false);
    const ctx = managedContext(requestPermission);
    const result = await browserActionTool.execute({ action: 'click', targetRef: 'tref_delete' }, ctx);
    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(service.clicks).toEqual(['tref_delete']);
  });

  it('gates selector and click_text targets by the same keyword', async () => {
    const requestPermission = vi.fn(async () => false);
    const ctx = managedContext(requestPermission);
    await jevLowConfidenceHandback(ctx);
    const clickSelector = vi.fn();
    (service as unknown as Record<string, unknown>).click = clickSelector;
    const bySelector = await browserActionTool.execute({ action: 'click', selector: 'button.delete-account' }, ctx);
    const byText = await browserActionTool.execute({ action: 'click_text', text: '删除' }, ctx);
    expect(bySelector.metadata?.code).toBe('SURFACE_APPROVAL_REQUIRED');
    expect(byText.metadata?.code).toBe('SURFACE_APPROVAL_REQUIRED');
    expect(clickSelector).not.toHaveBeenCalled();
  });

  it('gates an opaque CSS selector by the matched element text (RBS-07 button.added-manually = "Delete")', async () => {
    const requestPermission = vi.fn(async () => false);
    const ctx = managedContext(requestPermission);
    await jevLowConfidenceHandback(ctx);
    const clickSelector = vi.fn();
    (service as unknown as Record<string, unknown>).click = clickSelector;
    const result = await browserActionTool.execute({ action: 'click', selector: 'button.added-manually' }, ctx);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(result.metadata?.code).toBe('SURFACE_APPROVAL_REQUIRED');
    expect(clickSelector).not.toHaveBeenCalled();
  });
});
