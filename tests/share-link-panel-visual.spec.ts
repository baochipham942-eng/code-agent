import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const evidenceDir = process.env.ARTIFACT_SHARE_EVIDENCE_DIR
  || path.resolve('test-results/share-link-panel-visual');

for (const theme of ['light', 'dark'] as const) {
  test(`share link panel ${theme}`, async ({ page }) => {
    await mkdir(evidenceDir, { recursive: true });
    await page.setViewportSize({ width: 1120, height: 760 });
    await page.goto(`/tests/visual/share-link-panel.html?theme=${theme}`);
    const panel = page.getByTestId('share-link-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByText('链接内容落后于 v3')).toBeVisible();
    await expect(page.getByText('有链接的人')).toBeVisible();
    await page.screenshot({
      path: path.join(evidenceDir, `share-link-panel-${theme}.png`),
      fullPage: true,
    });
  });
}
