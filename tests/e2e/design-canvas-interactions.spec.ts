import { expect, test } from './fixtures/axeTest';
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
  // 「设计」这个按钮不存在（tab 标签是「设计画布」，且它只在 workbench 里被打开后才有）。
  // 正确入口 = 建会话 → 展开右栏 → 空态启动器的 open-workbench-view-design-canvas，
  // 与 design-canvas-conversational.e2e.spec.ts 同源（2026-08-18 实测：旧写法找不到元素）。
  const newSessionBtn = page.getByRole('button', { name: /新任务|新会话/ }).first();
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();
  await expect(page.locator('[data-session-id][aria-current="true"]').first()).toBeVisible({ timeout: 10_000 });

  const expandBtn = page.locator('[data-testid="titlebar-expand-workbench"]');
  await expandBtn.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (await expandBtn.isVisible().catch(() => false)) await expandBtn.click();

  const entryBtn = page.locator('[data-testid="open-workbench-view-design-canvas"]');
  await expect(entryBtn).toBeVisible({ timeout: 10_000 });
  await entryBtn.click();

  // 🔴 本单只修到入口为止：下面这段仍然指着两个**已不存在的 testid**——
  // `design-workspace` 与 `design-import-image-input`，src 全仓 grep 均为 0
  // （画布容器现在是 `design-canvas-tab`，图片导入换过一轮交互）。
  // 那是设计画布这条线自己的 surface 腐烂，不在 N-E2E-CONTRACT 的「13 个 data-chat-input
  // 剧本」名单里，故意不在本单顺手改写——留着让它红在真正坏掉的那一格。
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
