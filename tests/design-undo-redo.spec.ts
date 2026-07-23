// 真机交互 E2E：设计画布 undo/redo 经真实 attached keydown listener 验收（Phase 6）。
// 单测覆盖了引擎/store/路由,本测专证"DesignCanvas 挂载后 window keydown listener 真的 attach 且 Cmd+Z 生效"——
// 这是单测(node 环境无 konva)碰不到的最后一公里。
import { test, expect } from '@playwright/test';

test.setTimeout(60_000);

/* eslint-disable @typescript-eslint/no-explicit-any */

test('设计画布 Cmd+Z 撤销 / Cmd+Shift+Z 重做（真实 listener）', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 20_000 });

  // 从普通会话的 workbench 入口打开画布 tab。
  const newSessionBtn = page.getByRole('button', { name: '新会话' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();
  await expect(page.locator('[data-session-id][aria-current="true"]').first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Show task panel' }).click();
  const canvasEntry = page.getByTestId('open-design-canvas');
  await expect(canvasEntry).toBeEnabled();
  await canvasEntry.click();
  await expect(page.getByTestId('design-canvas-tab')).toBeVisible({ timeout: 15_000 });

  // 等画布 store 钩子 + konva canvas 渲染出来（证明 DesignCanvas 真挂载了，listener attach）。
  await page.waitForFunction(() => !!(window as any).__neoDesignCanvasStore, null, { timeout: 15_000 });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });

  // seed 一个节点 A 在 x=0。
  await page.evaluate(() => {
    (window as any).__neoDesignCanvasStore.getState().loadDoc('run-e2e', {
      version: 1,
      nodes: [{ id: 'A', src: 'assets/a.png', x: 0, y: 0, width: 100, height: 100, createdAt: 1 }],
      camera: { x: 0, y: 0, scale: 1 },
    });
  });

  // 移动 A → x=500（产生 Layer1 编辑撤销点）。
  await page.evaluate(() => (window as any).__neoDesignCanvasStore.getState().updateNode('A', { x: 500 }));
  expect(await page.evaluate(() => (window as any).__neoDesignCanvasStore.getState().nodes[0].x)).toBe(500);
  expect(await page.evaluate(() => (window as any).__neoDesignCanvasStore.getState().canEditUndo())).toBe(true);

  // 点画布空白处确保焦点不在输入框（让 keydown 走画布 undo 而非被输入边界 return）。
  await page.locator('canvas').first().click({ position: { x: 5, y: 5 } });

  // 真 Cmd+Z → 经真实 attached listener → undoEdit → A 回 x=0。
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(
    () => (window as any).__neoDesignCanvasStore.getState().nodes.find((n: any) => n.id === 'A')?.x === 0,
    null,
    { timeout: 5_000 },
  );
  expect(
    await page.evaluate(() => (window as any).__neoDesignCanvasStore.getState().nodes.find((n: any) => n.id === 'A').x),
  ).toBe(0);

  // 真 Cmd+Shift+Z → redoEdit → A 回 x=500。
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForFunction(
    () => (window as any).__neoDesignCanvasStore.getState().nodes.find((n: any) => n.id === 'A')?.x === 500,
    null,
    { timeout: 5_000 },
  );
  expect(
    await page.evaluate(() => (window as any).__neoDesignCanvasStore.getState().nodes.find((n: any) => n.id === 'A').x),
  ).toBe(500);

  // 无新增 console error（滤掉与本测无关的后端 401/favicon/网络噪声）。
  const real = consoleErrors.filter((e) => !/favicon|workspace\/file|401|net::ERR|Failed to load resource/i.test(e));
  expect(real).toEqual([]);
});
