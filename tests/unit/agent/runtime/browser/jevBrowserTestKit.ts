import { vi } from 'vitest';
import type { JevAnswers, JevSystemOneCall } from '../../../../../src/shared/constants/jevQuestions';
import type { JevCapturedSnapshot } from '../../../../../src/host/services/infra/browser/jevBrowserSnapshotPrep';
import type { BrowserDomSnapshot, BrowserTargetRef } from '../../../../../src/host/services/infra/browser/types';
import { resolveBrowserJevStep } from '../../../../../src/host/agent/runtime/browser/jevBrowserStep';
import type { JevBrowserHost } from '../../../../../src/host/agent/runtime/browser/jevBrowserHost';
import type { ToolContext } from '../../../../../src/host/tools/types';

export function targetRef(
  id: string,
  name: string,
  rect: { x: number; y: number; width: number; height: number },
): BrowserTargetRef {
  return {
    refId: id,
    source: 'dom',
    selector: `#${id}`,
    name,
    textHint: name,
    frameId: 'FRAME',
    documentRevision: 'rev',
    tabId: 'tab',
    snapshotId: 'snap',
    capturedAtMs: 1,
    ttlMs: 60_000,
    confidence: 0.9,
    rect,
  };
}

export function button(id: string, text: string, y = 10): BrowserDomSnapshot['interactiveElements'][number] {
  const rect = { x: 0, y, width: 80, height: 20 };
  return {
    tag: 'button',
    text,
    ariaLabel: text,
    placeholder: null,
    selectorHint: `#${id}`,
    targetRef: targetRef(id, text, rect),
    rect,
  };
}

export function snapshot(
  title: string,
  elements: BrowserDomSnapshot['interactiveElements'],
  url = 'http://127.0.0.1/page',
): JevCapturedSnapshot {
  return {
    snapshot: {
      snapshotId: 'snap',
      tabId: 'tab',
      capturedAtMs: 1,
      url,
      title,
      headings: [{ level: 1, text: title }],
      interactiveElements: elements,
    },
    extras: elements.map(() => ({ inputType: null, autocomplete: null, accept: null })),
    viewport: { width: 800, height: 600 },
    scrollY: 0,
  };
}

export function answers(overrides: Partial<{
  operation: string;
  opConf: number;
  target: string;
  targetConf: number;
  done: number;
  risk: number;
}> = {}): JevAnswers {
  return {
    operation: { choice: overrides.operation ?? 'click', confidence: overrides.opConf ?? 0.9 },
    target: { choice: overrides.target ?? 'tref_go', confidence: overrides.targetConf ?? 0.9 },
    done: { noul: overrides.done ?? 0.1 },
    risk: { noul: overrides.risk ?? 0.1 },
  };
}

export class FakeHost implements JevBrowserHost {
  launched = true;
  url = 'http://127.0.0.1/page';
  pages: JevCapturedSnapshot[];
  clicks: string[] = [];
  types: Array<{ id: string; text: string }> = [];
  scrolls: string[] = [];
  formValues: Record<string, string> = {};
  visibleText = '';
  dialog: { pending: boolean; type?: string } = { pending: false };
  launchCount = 0;
  navigateCount = 0;
  closeCount = 0;
  captureCount = 0;
  captchaClicked = false;
  lastCaptured: JevCapturedSnapshot | null = null;
  constructor(pages: JevCapturedSnapshot[]) {
    this.pages = pages;
  }
  isLaunched() { return this.launched; }
  async launch() {
    this.launchCount += 1;
    this.launched = true;
  }
  async navigate(url: string) {
    this.navigateCount += 1;
    this.url = url;
  }
  async close() {
    this.closeCount += 1;
    this.launched = false;
  }
  currentUrl() { return this.url; }
  async capture() {
    this.captureCount += 1;
    const current = this.pages[0] || snapshot('Empty', []);
    const shot = { ...current, snapshot: { ...current.snapshot, url: this.url } };
    this.lastCaptured = shot;
    return shot;
  }
  async clickTargetRef(ref: BrowserTargetRef) {
    this.clicks.push(ref.refId);
    if (ref.refId === 'captcha' || /captcha|not a robot/i.test(ref.name || '')) {
      this.captchaClicked = true;
    }
  }
  async typeTargetRef(ref: BrowserTargetRef, text: string) { this.types.push({ id: ref.refId, text }); }
  async scroll(direction: 'up' | 'down') { this.scrolls.push(direction); }
  async pressEnter() {}
  async wait() {}
  getDialogState() { return this.dialog; }
  async getFormValues() { return this.formValues; }
  async getVisibleText() { return this.visibleText; }
  async listDownloads() { return []; }
}

let turnSeq = 0;
export function context(requestPermission: ToolContext['requestPermission'] = async () => true): ToolContext {
  turnSeq += 1;
  return {
    workingDirectory: '/tmp',
    sessionId: `s${turnSeq}`,
    turnId: `t${turnSeq}`,
    requestPermission,
  };
}

export function stubSystemOne(
  impl: (state: Record<string, unknown>) => JevAnswers | Promise<JevAnswers>,
): JevSystemOneCall & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const fn = vi.fn(async (state: Record<string, unknown>) => {
    calls.push(state);
    return impl(state);
  }) as unknown as JevSystemOneCall & { calls: Record<string, unknown>[] };
  fn.calls = calls;
  return fn;
}

export async function runLoop(
  host: FakeHost,
  systemOne: JevSystemOneCall,
  input: {
    task?: string;
    assertions?: Array<Record<string, unknown>>;
    mutate?: 'done1' | 'empty-window';
    jevBudgetUsd?: number;
  },
  ctx: ToolContext = context(),
  extra?: { quickType?: ((prompt: string) => Promise<string | null>) | null },
) {
  vi.stubEnv('CODE_AGENT_BROWSER_JEV_STEP', '1');
  const driver = resolveBrowserJevStep({
    systemOne,
    host,
    mutate: input.mutate,
    ...(extra && Object.hasOwn(extra, 'quickType') ? { quickType: extra.quickType } : {}),
  });
  if (!driver) throw new Error('driver unarmed');
  const result = await driver.run(input, ctx);
  return {
    ...result,
    status: result.metadata?.status,
    fallback: result.metadata?.fallback,
    reason: result.metadata?.reason,
    browserJevMode: result.metadata?.browserJevMode,
    falseDoneCount: result.metadata?.false_done_count,
  };
}
