import type { Page } from '@playwright/test';
import { installGeometrySensor, type GeometryReport, type GeometrySensorOptions } from './geometrySensor';

export const CASELIST_SCROLL_SELECTOR = '[data-testid="eval-case-list-scroll"], [data-testid="eval-case-list-tab"] .overflow-auto';
export const CASELIST_HEADER_SELECTOR = '[data-testid="eval-case-list-tab"] thead.sticky';
export const CASELIST_ROW_SELECTOR = '[data-testid^="eval-case-row-"]';
export const SIDEBAR_SESSION_SCROLL_SELECTOR = '[data-testid="sidebar-session-scroll"]';
export const SIDEBAR_CAPABILITY_ZONE_SELECTOR = '[data-testid="sidebar-capability-zone"]';

export const caselistSensorOptions: GeometrySensorOptions = {
  stickyHeaders: [{ header: CASELIST_HEADER_SELECTOR, rowSelector: CASELIST_ROW_SELECTOR }],
};

export const sidebarSensorOptions: GeometrySensorOptions = {
  scrollContainers: [{ selector: SIDEBAR_SESSION_SCROLL_SELECTOR, region: 'sidebar' }],
  rightEdgeAlignments: [{
    subject: SIDEBAR_SESSION_SCROLL_SELECTOR,
    siblings: [SIDEBAR_CAPABILITY_ZONE_SELECTOR],
    maxOverhangPx: 1,
  }],
};

export async function waitForLayoutSettle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/** FB-162: `pb-2` → `py-2` put 8px padding-top on the real caselist scroller. */
export async function reintroduceCaselistStickyDefect(page: Page): Promise<void> {
  const scroller = page.locator(CASELIST_SCROLL_SELECTOR).first();
  await scroller.waitFor({ timeout: 20_000 });
  await page.addStyleTag({
    content: '[data-testid="eval-case-list-scroll"] { padding-top: 8px !important; }',
  });
  await waitForLayoutSettle(page);
}

/** Round-2 reverse mutation: drop `scrollbar-band` on the real SidebarSessionList scroller. */
export async function reintroduceSidebarOverhangDefect(page: Page): Promise<void> {
  const scroll = page.locator(SIDEBAR_SESSION_SCROLL_SELECTOR);
  await scroll.waitFor({ timeout: 20_000 });
  await scroll.evaluate((element) => {
    element.classList.remove('scrollbar-band');
  });
  await page.addStyleTag({
    content: '[data-testid="sidebar-session-scroll"] { scrollbar-gutter: auto !important; }',
  });
  await waitForLayoutSettle(page);
}

export async function probeCaselistGeometry(page: Page): Promise<GeometryReport> {
  await page.locator('[data-testid="eval-case-list-tab"]').waitFor({ timeout: 20_000 });
  await page.locator(CASELIST_ROW_SELECTOR).first().waitFor({ timeout: 20_000 });
  const scroller = page.locator(CASELIST_SCROLL_SELECTOR).first();
  await scroller.waitFor({ timeout: 20_000 });
  await scroller.evaluate((element) => {
    const node = element as HTMLElement;
    node.scrollTop = Math.min(node.scrollHeight, 240);
  });
  await waitForLayoutSettle(page);
  const sensor = await installGeometrySensor(page, caselistSensorOptions);
  await sensor.markInteractive();
  return sensor.collect();
}

export async function probeSidebarGeometry(page: Page): Promise<GeometryReport> {
  const scroll = page.locator(SIDEBAR_SESSION_SCROLL_SELECTOR);
  await scroll.waitFor({ timeout: 20_000 });
  await page.locator(SIDEBAR_CAPABILITY_ZONE_SELECTOR).waitFor({ timeout: 20_000 });
  await scroll.evaluate((element) => {
    const node = element as HTMLElement;
    node.style.maxHeight = '80px';
  });
  await waitForLayoutSettle(page);
  const sensor = await installGeometrySensor(page, sidebarSensorOptions);
  await sensor.markInteractive();
  return sensor.collect();
}

export function hasKind(report: GeometryReport, kind: GeometryReport['violations'][number]['kind']): boolean {
  return report.violations.some((violation) => violation.kind === kind);
}
