import type {
  BrowserInteractionStep,
  BrowserInteractionStepResult,
} from '../../shared/contract/browserInteraction';

const DEFAULT_EXPECT_TIMEOUT_MS = 5000;
const POST_ACTION_SETTLE_MS = 200;
const POLL_INTERVAL_MS = 80;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type IframeWindow = Window & typeof globalThis;

function getContext(iframe: HTMLIFrameElement): {
  win: IframeWindow;
  doc: Document;
} | null {
  const win = iframe.contentWindow as IframeWindow | null;
  const doc = iframe.contentDocument;
  if (!win || !doc) return null;
  return { win, doc };
}

function dispatchMouseEvent(
  win: IframeWindow,
  target: EventTarget,
  type: string,
  x: number,
  y: number,
): void {
  const event = new win.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    view: win,
    clientX: x,
    clientY: y,
    button: 0,
  });
  target.dispatchEvent(event);
}

function clickAtPoint(win: IframeWindow, doc: Document, x: number, y: number): boolean {
  const target = doc.elementFromPoint(x, y);
  if (!target) return false;
  dispatchMouseEvent(win, target, 'mousedown', x, y);
  dispatchMouseEvent(win, target, 'mouseup', x, y);
  dispatchMouseEvent(win, target, 'click', x, y);
  return true;
}

function hoverAtPoint(win: IframeWindow, doc: Document, x: number, y: number): boolean {
  const target = doc.elementFromPoint(x, y);
  if (!target) return false;
  dispatchMouseEvent(win, target, 'mouseover', x, y);
  dispatchMouseEvent(win, target, 'mouseenter', x, y);
  dispatchMouseEvent(win, target, 'mousemove', x, y);
  return true;
}

function typeText(win: IframeWindow, doc: Document, text: string): boolean {
  const active = doc.activeElement as HTMLElement | null;
  if (!active) return false;
  if (active instanceof win.HTMLInputElement || active instanceof win.HTMLTextAreaElement) {
    const currentValue = active.value;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      active instanceof win.HTMLInputElement ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    nativeSetter?.call(active, currentValue + text);
    active.dispatchEvent(new win.Event('input', { bubbles: true }));
    active.dispatchEvent(new win.Event('change', { bubbles: true }));
    return true;
  }
  for (const char of text) {
    active.dispatchEvent(new win.KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }));
    active.dispatchEvent(new win.KeyboardEvent('keypress', { key: char, bubbles: true, cancelable: true }));
    active.dispatchEvent(new win.KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true }));
  }
  return true;
}

function pressKey(win: IframeWindow, doc: Document, key: string): boolean {
  const target: EventTarget = doc.activeElement ?? doc.body;
  target.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  target.dispatchEvent(new win.KeyboardEvent('keypress', { key, bubbles: true, cancelable: true }));
  target.dispatchEvent(new win.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  return true;
}

function isElementVisible(win: IframeWindow, el: Element): boolean {
  if (!(el instanceof win.HTMLElement)) return true;
  if ((el as HTMLElement).offsetParent === null && win.getComputedStyle(el).position !== 'fixed') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = win.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
  return true;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return predicate();
}

function countNonblankCanvas(doc: Document): number {
  let count = 0;
  for (const canvas of Array.from(doc.querySelectorAll('canvas'))) {
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || canvas.width <= 0 || canvas.height <= 0) continue;
      const x = Math.floor(canvas.width / 2);
      const y = Math.floor(canvas.height / 2);
      const pixel = context.getImageData(x, y, 1, 1).data;
      if (pixel[3] > 8 && pixel[0] + pixel[1] + pixel[2] > 28) count += 1;
    } catch {
      // tainted canvas, skip
    }
  }
  return count;
}

export async function runInAppInteractionStep(
  iframe: HTMLIFrameElement,
  step: BrowserInteractionStep,
): Promise<BrowserInteractionStepResult> {
  const startedAt = Date.now();
  const failures: string[] = [];
  const checks: string[] = [];
  const expectTimeout = step.expect?.timeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS;
  const labelPrefix = `[in-app${step.label ? ` · ${step.label}` : ''}]`;

  const context = getContext(iframe);
  if (!context) {
    return {
      label: step.label,
      viewport: step.viewport ?? 'in-app',
      action: step.action,
      passed: false,
      durationMs: Date.now() - startedAt,
      failures: [`${labelPrefix} iframe has no contentWindow/contentDocument (cross-origin or not loaded)`],
      checks,
    };
  }
  const { win, doc } = context;

  try {
    switch (step.action.type) {
      case 'click': {
        const ok = clickAtPoint(win, doc, step.action.x, step.action.y);
        if (ok) checks.push(`${labelPrefix} clicked at (${step.action.x}, ${step.action.y})`);
        else failures.push(`${labelPrefix} no element at (${step.action.x}, ${step.action.y})`);
        break;
      }
      case 'click-selector': {
        const target = doc.querySelector(step.action.selector);
        if (!target) {
          failures.push(`${labelPrefix} selector not found: ${step.action.selector}`);
          break;
        }
        const rect = target.getBoundingClientRect();
        dispatchMouseEvent(win, target, 'mousedown', rect.left + rect.width / 2, rect.top + rect.height / 2);
        dispatchMouseEvent(win, target, 'mouseup', rect.left + rect.width / 2, rect.top + rect.height / 2);
        dispatchMouseEvent(win, target, 'click', rect.left + rect.width / 2, rect.top + rect.height / 2);
        checks.push(`${labelPrefix} clicked selector ${step.action.selector}`);
        break;
      }
      case 'hover': {
        const ok = hoverAtPoint(win, doc, step.action.x, step.action.y);
        if (ok) checks.push(`${labelPrefix} hovered at (${step.action.x}, ${step.action.y})`);
        else failures.push(`${labelPrefix} no element at (${step.action.x}, ${step.action.y}) to hover`);
        break;
      }
      case 'type': {
        const ok = typeText(win, doc, step.action.text);
        if (ok) checks.push(`${labelPrefix} typed ${step.action.text.length} char(s)`);
        else failures.push(`${labelPrefix} no active element to receive text`);
        break;
      }
      case 'press':
        pressKey(win, doc, step.action.key);
        checks.push(`${labelPrefix} pressed ${step.action.key}`);
        break;
      case 'wait':
        await delay(step.action.ms);
        checks.push(`${labelPrefix} waited ${step.action.ms}ms`);
        break;
    }

    await delay(POST_ACTION_SETTLE_MS);

    if (step.expect) {
      if (step.expect.textVisible) {
        const needle = step.expect.textVisible;
        const ok = await waitFor(() => {
          const text = doc.body?.innerText ?? '';
          return text.toLowerCase().includes(needle.toLowerCase());
        }, expectTimeout);
        if (ok) checks.push(`${labelPrefix} text visible: ${needle}`);
        else failures.push(`${labelPrefix} expected text "${needle}" not visible within ${expectTimeout}ms`);
      }
      if (step.expect.textHidden) {
        const needle = step.expect.textHidden;
        const ok = await waitFor(() => {
          const text = doc.body?.innerText ?? '';
          return !text.toLowerCase().includes(needle.toLowerCase());
        }, expectTimeout);
        if (ok) checks.push(`${labelPrefix} text hidden: ${needle}`);
        else failures.push(`${labelPrefix} expected text "${needle}" not hidden within ${expectTimeout}ms`);
      }
      if (step.expect.selectorVisible) {
        const sel = step.expect.selectorVisible;
        const ok = await waitFor(() => {
          const el = doc.querySelector(sel);
          return el ? isElementVisible(win, el) : false;
        }, expectTimeout);
        if (ok) checks.push(`${labelPrefix} selector visible: ${sel}`);
        else failures.push(`${labelPrefix} expected selector "${sel}" not visible within ${expectTimeout}ms`);
      }
      if (step.expect.selectorHidden) {
        const sel = step.expect.selectorHidden;
        const ok = await waitFor(() => {
          const el = doc.querySelector(sel);
          return !el || !isElementVisible(win, el);
        }, expectTimeout);
        if (ok) checks.push(`${labelPrefix} selector hidden: ${sel}`);
        else failures.push(`${labelPrefix} expected selector "${sel}" not hidden within ${expectTimeout}ms`);
      }
      if (step.expect.nonblankCanvasMin && step.expect.nonblankCanvasMin > 0) {
        const min = step.expect.nonblankCanvasMin;
        const count = countNonblankCanvas(doc);
        if (count >= min) checks.push(`${labelPrefix} nonblank canvas ${count} ≥ ${min}`);
        else failures.push(`${labelPrefix} nonblank canvas count ${count} < required ${min}`);
      }
    }
  } catch (error) {
    failures.push(`${labelPrefix} action ${step.action.type} threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    label: step.label,
    viewport: step.viewport ?? 'in-app',
    action: step.action,
    passed: failures.length === 0,
    durationMs: Date.now() - startedAt,
    failures,
    checks,
  };
}

export async function runInAppInteractions(
  iframe: HTMLIFrameElement,
  steps: BrowserInteractionStep[],
): Promise<BrowserInteractionStepResult[]> {
  const results: BrowserInteractionStepResult[] = [];
  for (const step of steps) {
    const result = await runInAppInteractionStep(iframe, step);
    results.push(result);
  }
  return results;
}
