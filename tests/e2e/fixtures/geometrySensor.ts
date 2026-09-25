import type { Page } from '@playwright/test';

export type GeometryRegion = 'sidebar' | 'conversation' | 'composer' | 'other';

export interface GeometryScrollContainer {
  selector: string;
  region?: GeometryRegion;
  affordanceSelectors?: string[];
}

export interface GeometryStickyHeader {
  header: string;
  rowSelector: string;
}

export interface GeometryRightEdgeAlignment {
  subject: string;
  siblings: string[];
  maxOverhangPx?: number;
}

export interface GeometrySensorOptions {
  scrollContainers?: GeometryScrollContainer[];
  mustBeVisible?: string[];
  stickyHeaders?: GeometryStickyHeader[];
  rightEdgeAlignments?: GeometryRightEdgeAlignment[];
}

export interface LayoutShiftRecord {
  value: number;
  phase: 'before-first-interactive' | 'after-interactive';
  hadRecentInput: boolean;
  region: GeometryRegion;
  startTime: number;
  sources: string[];
}

export interface GeometryViolation {
  kind: 'layout-shift' | 'overflow' | 'covered-scrollbar' | 'occlusion' | 'sticky-header' | 'right-overhang';
  selector?: string;
  region?: GeometryRegion;
  detail: string;
}

export interface GeometryReport {
  shifts: LayoutShiftRecord[];
  violations: GeometryViolation[];
}

interface BrowserSensorState {
  interactiveAt: number | null;
  lastInputAt: number;
  shifts: LayoutShiftRecord[];
  observer?: PerformanceObserver;
}

const STATE_KEY = '__neoGeometrySensor';

function classifyRegion(testId: string | null, explicit: string | null): GeometryRegion {
  if (explicit === 'sidebar' || explicit === 'conversation' || explicit === 'composer') return explicit;
  const value = `${explicit ?? ''} ${testId ?? ''}`.toLowerCase();
  if (value.includes('sidebar')) return 'sidebar';
  if (value.includes('composer') || value.includes('chat-input')) return 'composer';
  if (value.includes('conversation') || value.includes('chat') || value.includes('message')) return 'conversation';
  return 'other';
}

function installBrowserSensor(stateKey: string): void {
  const globalWindow = window as unknown as Record<string, unknown> & { __name?: (fn: unknown) => unknown };
  globalWindow.__name = globalWindow.__name ?? ((fn) => fn);
  const existing = globalWindow[stateKey] as BrowserSensorState | undefined;
  if (existing) return;

  const state: BrowserSensorState = { interactiveAt: null, lastInputAt: -Infinity, shifts: [] };
  const classify = (testId: string | null, explicit: string | null): GeometryRegion => {
    if (explicit === 'sidebar' || explicit === 'conversation' || explicit === 'composer') return explicit;
    const value = `${explicit ?? ''} ${testId ?? ''}`.toLowerCase();
    if (value.includes('sidebar')) return 'sidebar';
    if (value.includes('composer') || value.includes('chat-input')) return 'composer';
    if (value.includes('conversation') || value.includes('chat') || value.includes('message')) return 'conversation';
    return 'other';
  };
  const regionOfNode = (node: Node | undefined): GeometryRegion => {
    const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
    const landmark = element?.closest('[data-geometry-region]')?.getAttribute('data-geometry-region') ?? null;
    const testId = element?.closest('[data-testid]')?.getAttribute('data-testid') ?? null;
    return classify(testId, landmark);
  };
  const markInput = () => { state.lastInputAt = performance.now(); };
  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(event, markInput, { capture: true, passive: true });
  }

  if ('PerformanceObserver' in window) {
    state.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEntry[]) {
        const shift = entry as PerformanceEntry & {
          value?: number;
          hadRecentInput?: boolean;
          sources?: Array<{ node?: Node }>;
        };
        const regions = (shift.sources ?? []).map(({ node }) => regionOfNode(node));
        const region = regions.find((value) => value !== 'other') ?? regions[0] ?? 'other';
        const phase = state.interactiveAt !== null && entry.startTime >= state.interactiveAt
          ? 'after-interactive'
          : 'before-first-interactive';
        const hadRecentInput = shift.hadRecentInput === true
          || performance.now() - state.lastInputAt < 500;
        state.shifts.push({
          value: shift.value ?? 0,
          phase,
          hadRecentInput,
          region,
          startTime: entry.startTime,
          sources: (shift.sources ?? []).map(({ node }) => node instanceof Element
            ? node.getAttribute('data-testid') ?? node.tagName.toLowerCase()
            : 'unknown'),
        });
      }
    });
    try {
      state.observer.observe({ type: 'layout-shift', buffered: true });
    } catch {
      // Chromium versions without Layout Instability support keep the other sensors active.
    }
  }
  globalWindow[stateKey] = state;
}

export async function installGeometrySensor(page: Page, options: GeometrySensorOptions = {}): Promise<GeometrySensor> {
  // addInitScript reinstalls the observer after every navigation so page.goto
  // does not drop layout-shift records. evaluate covers the already-open document.
  await page.addInitScript(installBrowserSensor, STATE_KEY);
  await page.evaluate(installBrowserSensor, STATE_KEY);

  const sensor = {
    markInteractive: async () => {
      await page.evaluate((stateKey) => {
        const state = (window as unknown as Record<string, unknown>)[stateKey] as BrowserSensorState | undefined;
        if (state) state.interactiveAt = performance.now();
      }, STATE_KEY);
    },
    collect: async () => page.evaluate(({ stateKey, sensorOptions }) => {
      const classify = (testId: string | null, explicit: string | null): GeometryRegion => {
        if (explicit === 'sidebar' || explicit === 'conversation' || explicit === 'composer') return explicit;
        const value = `${explicit ?? ''} ${testId ?? ''}`.toLowerCase();
        if (value.includes('sidebar')) return 'sidebar';
        if (value.includes('composer') || value.includes('chat-input')) return 'composer';
        if (value.includes('conversation') || value.includes('chat') || value.includes('message')) return 'conversation';
        return 'other';
      };
      const state = (window as unknown as Record<string, unknown>)[stateKey] as BrowserSensorState | undefined;
      const violations: GeometryViolation[] = [];
      const shifts = state?.shifts ?? [];
      for (const shift of shifts) {
        if (shift.phase === 'after-interactive' && !shift.hadRecentInput) {
          violations.push({
            kind: 'layout-shift',
            region: shift.region,
            detail: `layout shift ${shift.value.toFixed(4)} at ${shift.startTime.toFixed(1)}ms`,
          });
        }
      }

      const regionFor = (element: Element): GeometryRegion => {
        const explicit = element.closest('[data-geometry-region]')?.getAttribute('data-geometry-region');
        const testId = element.closest('[data-testid]')?.getAttribute('data-testid');
        return classify(testId ?? null, explicit ?? null);
      };
      const isDescendantOrSelf = (element: Element, candidate: Element | null): boolean =>
        candidate === element || (candidate !== null && element.contains(candidate));
      const contentBoxRight = (element: HTMLElement): number =>
        element.getBoundingClientRect().left + element.clientLeft + element.clientWidth;
      const scrollParentOf = (element: Element): HTMLElement | null => {
        let current = element.parentElement;
        while (current) {
          const overflowY = getComputedStyle(current).overflowY;
          if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return current;
          current = current.parentElement;
        }
        return null;
      };

      for (const container of sensorOptions.scrollContainers ?? []) {
        const element = document.querySelector(container.selector);
        if (!(element instanceof HTMLElement)) {
          violations.push({ kind: 'overflow', selector: container.selector, detail: 'scroll container not found' });
          continue;
        }
        const overflowing = element.scrollHeight > element.clientHeight + 1;
        if (!overflowing) continue;
        const style = getComputedStyle(element);
        const scrollbarVisible = style.overflowY !== 'hidden'
          && style.overflowY !== 'clip'
          && style.scrollbarWidth !== 'none'
          && (style.overflowY === 'scroll' || element.offsetWidth - element.clientWidth > 1);
        const hasAffordance = (container.affordanceSelectors ?? []).some((selector) =>
          element.matches(selector) || Boolean(element.querySelector(selector)));
        if (!scrollbarVisible && !hasAffordance) {
          violations.push({
            kind: 'overflow',
            selector: container.selector,
            region: container.region ?? regionFor(element),
            detail: 'content overflows without a visible scrollbar or scroll affordance',
          });
        }

        const rect = element.getBoundingClientRect();
        const direction = style.direction === 'rtl' ? 'left' : 'right';
        const gutterX = direction === 'right' ? rect.right - 1 : rect.left + 1;
        const sampleYs = [0.25, 0.5, 0.75].map((fraction) =>
          rect.top + Math.min(Math.max(rect.height * fraction, 1), Math.max(rect.height - 1, 1)));
        for (const y of sampleYs) {
          const hit = document.elementFromPoint(gutterX, y);
          if (hit instanceof Element && !isDescendantOrSelf(element, hit)) {
            violations.push({
              kind: 'covered-scrollbar',
              selector: container.selector,
              region: container.region ?? regionFor(element),
              detail: `scrollbar gutter is painted by ${hit.getAttribute('data-testid') ?? hit.tagName.toLowerCase()}`,
            });
            break;
          }
        }
      }

      for (const selector of sensorOptions.mustBeVisible ?? []) {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
          violations.push({ kind: 'occlusion', selector, detail: 'required element not found' });
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.left < 0
          || rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
          violations.push({ kind: 'occlusion', selector, detail: 'required element is outside the viewport' });
          continue;
        }
        const points = [
          [rect.left + 1, rect.top + 1], [rect.right - 1, rect.top + 1],
          [rect.left + 1, rect.bottom - 1], [rect.right - 1, rect.bottom - 1],
          [rect.left + rect.width / 2, rect.top + rect.height / 2],
        ];
        for (const [x, y] of points) {
          const hit = document.elementFromPoint(x, y);
          if (hit instanceof Element && !isDescendantOrSelf(element, hit)) {
            violations.push({ kind: 'occlusion', selector, detail: `painted over at ${x.toFixed(1)},${y.toFixed(1)}` });
            break;
          }
        }
      }

      for (const sticky of sensorOptions.stickyHeaders ?? []) {
        const header = document.querySelector(sticky.header);
        if (!(header instanceof HTMLElement)) {
          violations.push({ kind: 'sticky-header', selector: sticky.header, detail: 'sticky header not found' });
          continue;
        }
        const headerRect = header.getBoundingClientRect();
        const scroller = scrollParentOf(header);
        const clipTop = scroller instanceof HTMLElement ? scroller.getBoundingClientRect().top : 0;
        for (const row of document.querySelectorAll(sticky.rowSelector)) {
          if (!(row instanceof HTMLElement)) continue;
          const rowRect = row.getBoundingClientRect();
          if (rowRect.top >= headerRect.top - 1) continue;
          const visibleAboveHeader = Math.min(rowRect.bottom, headerRect.top) - Math.max(rowRect.top, clipTop);
          if (visibleAboveHeader > 1) {
            violations.push({
              kind: 'sticky-header',
              selector: sticky.header,
              detail: `row content is painted ${visibleAboveHeader.toFixed(1)}px above sticky header`,
            });
            break;
          }
        }
      }

      for (const alignment of sensorOptions.rightEdgeAlignments ?? []) {
        const subject = document.querySelector(alignment.subject);
        if (!(subject instanceof HTMLElement)) {
          violations.push({ kind: 'right-overhang', selector: alignment.subject, detail: 'subject not found' });
          continue;
        }
        const subjectRight = contentBoxRight(subject);
        const maxOverhangPx = alignment.maxOverhangPx ?? 1;
        for (const siblingSelector of alignment.siblings) {
          const sibling = document.querySelector(siblingSelector);
          if (!(sibling instanceof HTMLElement)) {
            violations.push({ kind: 'right-overhang', selector: siblingSelector, detail: 'sibling not found' });
            continue;
          }
          const overhang = subjectRight - contentBoxRight(sibling);
          if (overhang > maxOverhangPx) {
            violations.push({
              kind: 'right-overhang',
              selector: alignment.subject,
              region: regionFor(subject),
              detail: `content-box right overhangs ${siblingSelector} by ${overhang.toFixed(1)}px`,
            });
          }
        }
      }
      return { shifts, violations } satisfies GeometryReport;
    }, { stateKey: STATE_KEY, sensorOptions: options }),
    async assertClean() {
      const report = await this.collect();
      if (report.violations.length > 0) throw new Error(`[geometry] ${JSON.stringify(report.violations)}`);
      return report;
    },
  };
  return sensor;
}

export interface GeometrySensor {
  markInteractive(): Promise<void>;
  collect(): Promise<GeometryReport>;
  assertClean(): Promise<GeometryReport>;
}

export { classifyRegion };
