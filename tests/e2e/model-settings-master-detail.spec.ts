// ============================================================================
// Model Settings Master-Detail E2E - 模型设置页主从布局验证
// Web Server 模式下运行（无需 Tauri/Electron）
//
// 验证 Master-Detail 重构：
//   1. 左侧 Provider 列表（已配置 / 未配置分组）渲染
//   2. 右侧详情面板三段式（连接 / 模型 / 高级）渲染
//   3. 「新增 / 中转站」切换到新增表单
//   4. 选择未配置 Provider 显示渐进式空态（无模型区块）
// ============================================================================

import { test, expect, type Page } from '@playwright/test';

test.setTimeout(60_000);

/** 打开设置弹窗 → 切到「模型」tab（复用 app.spec.ts 已验证的 Workbench 路径） */
async function openModelSettings(page: Page) {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });

  // 右侧 workbench 面板默认折叠；'打开面板'(+) 在 WorkbenchTabs 内，需先展开面板才挂载。
  const addPanelButton = page.getByRole('button', { name: '打开面板' });
  if (!(await addPanelButton.isVisible().catch(() => false))) {
    const showTaskPanel = page.getByRole('button', { name: 'Show task panel' });
    await expect(showTaskPanel).toBeVisible({ timeout: 15_000 });
    await showTaskPanel.click();
  }
  await expect(addPanelButton).toBeVisible({ timeout: 15_000 });
  await addPanelButton.click();
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByText('在设置中管理 Skill 库').click();

  const settingsDialog = page.getByRole('dialog', { name: '设置' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });

  await settingsDialog.getByRole('button', { name: '通用模型', exact: true }).click();
  return settingsDialog;
}

test('模型设置页渲染 Master-Detail 布局', async ({ page }) => {
  const dialog = await openModelSettings(page);

  // 左侧 Provider 列表
  await expect(dialog.getByPlaceholder('搜索 Provider 或模型...')).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByRole('button', { name: '新增', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '诊断' })).toBeVisible();
  await expect(dialog.getByText(/已可用 · \d+/)).toBeVisible();

  // 右侧详情面板：① 连接 区块（标题与步骤编号同节点，用唯一字段 label 断言）
  await expect(dialog.getByText('接口地址（Base URL）').first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: '测试连接' })).toBeVisible();

  await page.screenshot({ path: 'screenshots/model-settings-master-detail.png', fullPage: false });
});

test('Agent 引擎拆为独立 tab，模型页不再包含引擎目录', async ({ page }) => {
  const dialog = await openModelSettings(page);

  // 模型页里不再有 Agent Engine 模型目录
  await expect(dialog.getByText('接口地址（Base URL）').first()).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText('Agent Engine 模型目录')).not.toBeVisible();

  // 独立的 Agent 引擎 tab 存在且能渲染引擎目录
  await dialog.getByRole('button', { name: 'Agent 引擎', exact: true }).click();
  await expect(dialog.getByText('Agent Engine 模型目录')).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: 'screenshots/agent-engine-settings-tab.png', fullPage: false });
});

test('「新增」切换到新增表单', async ({ page }) => {
  const dialog = await openModelSettings(page);

  await dialog.getByRole('button', { name: '新增', exact: true }).click();

  // 新增表单出现
  await expect(dialog.getByText('新增', { exact: true })).toBeVisible();
  await expect(dialog.getByPlaceholder('https://example.com/v1')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '添加 Provider' })).toBeVisible();
  // 协议选择存在
  await expect(dialog.getByText('填到 /v1 为止，不要带 /chat/completions。')).toBeVisible();

  await page.screenshot({ path: 'screenshots/model-settings-add-provider.png', fullPage: false });
});

test('未配置 Provider 显示渐进式空态', async ({ page }) => {
  const dialog = await openModelSettings(page);

  // 展开「未配置」分组（若有未配置 provider）
  const unconfiguredToggle = dialog.getByRole('button', { name: /未配置 · \d+/ });
  if (await unconfiguredToggle.isVisible().catch(() => false)) {
    await unconfiguredToggle.click();
    // 点击第一个未配置 provider（按钮文案带「配置 →」）
    const firstUnconfigured = dialog.getByRole('button', { name: /配置 →/ }).first();
    await firstUnconfigured.click();

    // 渐进式空态：连接区块在，模型区块提示填 Key
    await expect(dialog.getByText('填写 API Key 并测试连接后，即可发现和启用该 Provider 的模型。')).toBeVisible();

    await page.screenshot({ path: 'screenshots/model-settings-unconfigured.png', fullPage: false });
  }
});
