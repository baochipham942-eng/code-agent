import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lR8aWQAAAABJRU5ErkJggg==';

test('design canvas import, layer inspector, and camera gestures stay stable', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const imagePath = testInfo.outputPath('design-canvas-smoke.png');
  await writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));

  await page.goto('/');
  const designTab = page.getByRole('button', { name: '设计' }).first();
  await expect(designTab).toBeVisible();
  await designTab.click({ force: true });
  const designWorkspace = page.getByTestId('design-workspace');
  await expect(designWorkspace).toBeVisible({ timeout: 15_000 });

  await designWorkspace.getByRole('button', { name: '图' }).click();
  await expect(page.getByTestId('design-canvas')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('design-import-image-input').setInputFiles(imagePath);
  const layerButton = page.getByRole('button', { name: /未命名节点.*图片.*产物/ });
  await expect(layerButton).toBeVisible({ timeout: 15_000 });
  await layerButton.click();

  await expect(page.getByText('图层名称')).toBeVisible();
  await expect(page.getByText('设为主版')).toBeVisible();
  await expect(page.getByText('淘汰')).toBeVisible();

  const canvas = page.getByTestId('design-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const center = {
    x: (box?.x ?? 0) + (box?.width ?? 0) / 2,
    y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
  };

  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, 220);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -180);
  await page.keyboard.up('Control');

  await page.keyboard.down('Space');
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 80, center.y + 30, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');

  await expect(page.getByText('图层名称')).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
