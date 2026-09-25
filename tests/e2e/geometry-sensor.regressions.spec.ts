import { expect, test } from './fixtures/axeTest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGeometryVite, type GeometryViteServer } from '../../scripts/perf/geometry-sensor-runtime';
import { hasKind, probeCaselistGeometry, probeSidebarGeometry } from './fixtures/geometryScenarios';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let vite: GeometryViteServer;

test.beforeAll(async () => {
  vite = await startGeometryVite(repoRoot);
});

test.afterAll(async () => {
  await vite?.server.close();
});

test.describe('current-page geometry sensors', () => {
  test('eval case list sticky header stays opaque on the current page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(vite.caselistUrl, { waitUntil: 'domcontentloaded' });
    const report = await probeCaselistGeometry(page);
    expect(report.violations, JSON.stringify(report.violations)).toEqual([]);
    expect(hasKind(report, 'sticky-header')).toBe(false);
  });

  test('sidebar session list content-box right matches sibling columns on the current page', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 720 });
    await page.goto(vite.sidebarUrl, { waitUntil: 'domcontentloaded' });
    const report = await probeSidebarGeometry(page);
    expect(report.violations, JSON.stringify(report.violations)).toEqual([]);
    expect(hasKind(report, 'right-overhang')).toBe(false);
  });
});
