// 真机交互 E2E：自定义生图模型管理 UI 接线（借鉴项①）。
// 后端 save/list/delete round-trip 已由 webServer HTTP IPC 集成测试单独验收；
// 本测证「DesignWorkspace 真挂载后：图像产物态下出现自定义模型入口 → 点击开管理弹窗 →
// 新增表单渲染 → 客户端必填校验逐字段生效」——这是 node 单测（无真实 DOM 事件/Modal portal）
// 碰不到的渲染器最后一公里。dev 钩子复用 ⑤ undo/redo 既有 __neo* 例。
import { test, expect } from '@playwright/test';

test.setTimeout(60_000);

test('自定义生图模型：入口可见 → 弹窗打开 → 表单校验（真机交互）', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 20_000 });

  // 切设计模式（workspaceModeStore 非 lazy，App 启动即加载）。
  await page.waitForFunction(() => !!(window as any).__neoWorkspaceModeStore, null, { timeout: 15_000 });
  await page.evaluate(() => (window as any).__neoWorkspaceModeStore.getState().setWorkspaceMode('design'));

  // 设计 chunk 加载后设 outputType=mockup（图像产物）→ imageMode 真，生图模型区 + 自定义入口渲染。
  await page.waitForFunction(() => !!(window as any).__neoDesignStore, null, { timeout: 15_000 });
  await page.evaluate(() => (window as any).__neoDesignStore.getState().setOutputType('mockup'));

  // 入口按钮可见（DesignWorkspace 在 imageMode 下渲染「自定义生图模型」ghost 按钮）。
  const openBtn = page.getByRole('button', { name: '自定义生图模型' });
  await expect(openBtn).toBeVisible({ timeout: 15_000 });

  // 点击 → 管理弹窗打开（标题 + 副文案）。无后端时列表 IPC 优雅回退空表，不崩。
  await openBtn.click();
  await expect(page.getByText('接入你自己的 OpenAI 兼容生图端点', { exact: false })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('还没有自定义模型', { exact: false })).toBeVisible({ timeout: 10_000 });

  // 进新增表单。
  await page.getByRole('button', { name: '新增' }).click();
  await expect(page.getByText('显示名称', { exact: false })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByPlaceholder('https://api.example.com/v1')).toBeVisible();

  // 空表单保存 → 逐字段必填校验（客户端，先 label 报错）。
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('请填写显示名称')).toBeVisible({ timeout: 5_000 });

  // 填显示名后再保存 → 推进到 baseUrl 校验。
  await page.getByPlaceholder('例如：我的 SDXL').fill('E2E 占位模型');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('请填写端点 Base URL')).toBeVisible({ timeout: 5_000 });

  // 无与本测相关的 console error（滤掉无后端时的 401/网络噪声）。
  const real = consoleErrors.filter(
    (e) => !/favicon|workspace\/file|domain|401|403|net::ERR|Failed to load resource|invoke/i.test(e),
  );
  expect(real).toEqual([]);
});
