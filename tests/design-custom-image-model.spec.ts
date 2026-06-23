// 真机交互 E2E：自定义生图/生视频端点的「配置」入口已迁到设置页「生成模型」tab
// （IA：模型配置归设置页，设计页只选不配）。本测证：设置页 visualModels tab 真挂载后
// 出现生图/生视频两段 + 自定义端点新增表单逐字段必填校验。后端 save/list/delete round-trip
// 已由 webServer HTTP-IPC 集成单独验收。dev 钩子 __neoAppStore 复用 __neo* 例。
import { test, expect } from '@playwright/test';

test.setTimeout(60_000);

/* eslint-disable @typescript-eslint/no-explicit-any */

test('生成模型设置页：生图/生视频两段 + 自定义端点表单校验（真机交互）', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 20_000 });

  // 经 appStore.openSettingsTab 打开设置并跳到「生成模型」tab（非 lazy，启动即加载）。
  await page.waitForFunction(() => !!(window as any).__neoAppStore, null, { timeout: 15_000 });
  await page.evaluate(() => (window as any).__neoAppStore.getState().openSettingsTab('visualModels'));

  // 两段标题可见（生图模型 / 生视频模型）。
  await expect(page.getByText('生图模型', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('生视频模型', { exact: true })).toBeVisible({ timeout: 10_000 });
  // 生视频「出片待接入」提示可见。
  await expect(page.getByText('出片能力接入中', { exact: false })).toBeVisible({ timeout: 10_000 });

  // 生图段：点首个「新增」进自定义端点表单 → 表单字段渲染。
  await page.getByRole('button', { name: '新增' }).first().click();
  await expect(page.getByPlaceholder('https://api.example.com/v1').first()).toBeVisible({ timeout: 10_000 });

  // 空表单保存 → 客户端逐字段校验（先 label）。
  await page.getByRole('button', { name: '保存' }).first().click();
  await expect(page.getByText('请填写显示名称').first()).toBeVisible({ timeout: 5_000 });

  // 无与本测相关的 console error（滤掉无后端时的 401/网络噪声）。
  const real = consoleErrors.filter(
    (e) => !/favicon|workspace\/file|domain|401|403|net::ERR|Failed to load resource|invoke/i.test(e),
  );
  expect(real).toEqual([]);
});
