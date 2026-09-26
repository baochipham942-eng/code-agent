import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const evidenceDir = process.env.WAKE_RATIONALE_EVIDENCE_DIR
  || path.resolve('test-results/wake-rationale-visual');

test('wake rationale why expands with geometry below the suggest body', async ({ page }) => {
  await mkdir(evidenceDir, { recursive: true });
  await page.setViewportSize({ width: 960, height: 620 });
  await page.goto('/tests/renderer/visual/wake-rationale.html?theme=dark');

  const why = page.getByTestId('wake-rationale-why');
  await expect(why).toBeVisible();
  const whyBox = await why.boundingBox();
  expect(whyBox).toBeTruthy();
  expect(whyBox!.height).toBeGreaterThan(12);
  expect(whyBox!.height).toBeLessThan(36);

  const card = page.getByTestId('wake-suggest-card');
  const cardBox = await card.boundingBox();
  expect(cardBox).toBeTruthy();
  expect(whyBox!.y).toBeGreaterThan(cardBox!.y);

  await page.screenshot({
    path: path.join(evidenceDir, 'why-collapsed.png'),
    fullPage: true,
  });

  await why.click();
  const panel = page.getByTestId('wake-rationale-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('wake-rationale-text')).toContainText('连续两周没更新');
  const whyAfter = await why.boundingBox();
  const panelBox = await panel.boundingBox();
  expect(whyAfter).toBeTruthy();
  expect(panelBox).toBeTruthy();
  expect(panelBox!.y).toBeGreaterThan(whyAfter!.y + whyAfter!.height - 1);
  expect(panelBox!.height).toBeGreaterThan(whyAfter!.height);

  await page.screenshot({
    path: path.join(evidenceDir, 'why-expanded.png'),
    fullPage: true,
  });
});

test('missing rationale shows the recorded-missing copy', async ({ page }) => {
  await mkdir(evidenceDir, { recursive: true });
  await page.setViewportSize({ width: 960, height: 620 });
  await page.goto('/tests/renderer/visual/wake-rationale.html?theme=dark&missing=1');
  await page.getByTestId('wake-rationale-why').click();
  await expect(page.getByTestId('wake-rationale-missing')).toHaveText('这条没有记录理由');
  await page.screenshot({
    path: path.join(evidenceDir, 'why-missing.png'),
    fullPage: true,
  });
});
