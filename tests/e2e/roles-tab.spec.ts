// ============================================================================
// Roles Tab E2E - 角色面板 UI 挂载验证（持久化角色资产，设计 §7/§8 验收 4 的 UI 侧）
// Web Server 模式下运行（无需 Tauri/Electron）
//
// 验证：
//   1. 设置页「角色」tab 存在且可进入
//   2. 预设角色卡片（研究员 / 数据分析师）渲染，含记忆条数
//   3. 点击角色卡片进入详情：角色记忆 / 工作履历 / 角色定义 三个区块渲染
//   4. 返回列表正常
//
// 前置：webServer 启动时 installBuiltinRoles 会自动安装预设角色，
// 所以角色卡片必然存在（记忆/履历可能为空，空态也是合法渲染）。
// ============================================================================

import { test, expect, type Page } from '@playwright/test';

test.setTimeout(60_000);

/** 打开设置弹窗 → 切到「角色」tab（复用 model-settings spec 已验证的 Workbench 路径） */
async function openRolesSettings(page: Page) {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });

  const addPanelButton = page.getByRole('button', { name: '打开面板' });
  await expect(addPanelButton).toBeVisible({ timeout: 15_000 });
  await addPanelButton.click();
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByText('在设置中管理 Skill 库').click();

  const settingsDialog = page.getByRole('dialog', { name: '设置' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });

  await settingsDialog.getByRole('button', { name: '角色', exact: true }).click();
  return settingsDialog;
}

test('角色面板渲染预设角色卡片', async ({ page }) => {
  const dialog = await openRolesSettings(page);

  // 页面标题与说明
  await expect(dialog.getByText('持久化角色 = 角色定义 + 角色记忆 + 工作履历', { exact: false })).toBeVisible({ timeout: 10_000 });

  // 预设角色卡片（installBuiltinRoles 在 webServer 启动时安装，必然存在）
  await expect(dialog.getByText('研究员', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText('数据分析师', { exact: true }).first()).toBeVisible();

  // 卡片上的记忆条数指标
  await expect(dialog.getByText(/\d+ 条记忆/).first()).toBeVisible();

  await page.screenshot({ path: 'screenshots/roles-tab-list.png', fullPage: false });
});

test('角色详情：主动性 / 记忆 / 履历 / 定义 四区块渲染', async ({ page }) => {
  const dialog = await openRolesSettings(page);

  // 点击研究员卡片进入详情
  await dialog.getByText('研究员', { exact: true }).first().click();

  // 四个区块（记忆可能为空 → 空态文案也算渲染成功）
  await expect(dialog.getByText('主动性', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText(/角色记忆（\d+）/)).toBeVisible();
  await expect(dialog.getByText('工作履历', { exact: true })).toBeVisible();
  await expect(dialog.getByText('角色定义', { exact: true })).toBeVisible();

  // 主动性出厂默认为静默档
  await expect(dialog.getByText('静默', { exact: true })).toBeVisible();
  await expect(dialog.getByText('每日简报', { exact: true })).toBeVisible();
  await expect(dialog.getByText('实时介入', { exact: true })).toBeVisible();

  // 返回列表
  await page.screenshot({ path: 'screenshots/roles-tab-detail.png', fullPage: false });
  await dialog.getByText('返回角色列表').click();
  await expect(dialog.getByText('数据分析师', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
});

test('主动性开关：设置页开启每日简报 → 立即生效并持久化', async ({ page }) => {
  const dialog = await openRolesSettings(page);
  await dialog.getByText('研究员', { exact: true }).first().click();
  await expect(dialog.getByText('主动性', { exact: true })).toBeVisible({ timeout: 10_000 });

  // 点击"每日简报"档
  await dialog.getByText('每日简报', { exact: true }).click();

  // 选中态：每日简报的提示文案出现且选中样式生效（重新加载 detail 后仍是每日简报）
  await expect(dialog.getByText(/每天 09:00 醒来巡检产物/)).toBeVisible({ timeout: 10_000 });

  // 退出再进入详情 → 配置已持久化（settings 写入 + detail 反映）
  await dialog.getByText('返回角色列表').click();
  await dialog.getByText('研究员', { exact: true }).first().click();
  await expect(dialog.getByText('主动性', { exact: true })).toBeVisible({ timeout: 10_000 });
  // 每日简报处于选中态（emerald 高亮的选项里包含"每日简报"）
  const selectedOption = dialog.locator('button.border-emerald-600\\/70');
  await expect(selectedOption).toHaveCount(1, { timeout: 10_000 });
  await expect(selectedOption).toContainText('每日简报');

  await page.screenshot({ path: 'screenshots/roles-tab-proactivity.png', fullPage: false });

  // 收尾：改回静默（不污染后续测试/环境）
  await dialog.getByText('静默', { exact: true }).click();
  await expect(dialog.locator('button.border-emerald-600\\/70')).toContainText('静默', { timeout: 10_000 });
});
