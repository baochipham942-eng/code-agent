// ============================================================================
// Capability Productization E2E - P2-1 角色视觉化 + P2-2 内置 skill 分类分组
// Web Server 模式（无需 Tauri/Electron），系统 Chrome
//
// 验证（UI 真挂载，非 vitest 静态）：
//   P2-1：角色列表按产物分类分组（research / data-analysis 分组容器渲染，含预设角色）
//   P2-1：角色卡片渲染图标（lucide svg，非纯文字）
//   P2-2：已安装 Skills 的内置组按产物分类二次分组（development 等分类小节渲染）
//
// 前置：webServer 启动时 installBuiltinRoles 安装预设角色 + loadBuiltinSkills 加载内置 skill。
// ============================================================================

import { test, expect, type Page } from '@playwright/test';

test.setTimeout(60_000);

/** 打开设置弹窗（默认落在 Skills / 能力与连接 已安装 tab） */
async function openCapabilitySettings(page: Page) {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });

  const addPanelButton = page.getByRole('button', { name: '打开面板' });
  await expect(addPanelButton).toBeVisible({ timeout: 15_000 });
  await addPanelButton.click();
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByText('在设置中管理 Skill 库').click();

  const settingsDialog = page.getByRole('dialog', { name: '设置' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
  return settingsDialog;
}

test('P2-1 角色列表按产物分类分组 + 卡片渲染图标', async ({ page }) => {
  const dialog = await openCapabilitySettings(page);
  await dialog.getByRole('button', { name: '角色', exact: true }).click();

  // 预设角色卡片仍渲染（回归）
  await expect(dialog.getByText('溯真', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText('数据分析师', { exact: true }).first()).toBeVisible();

  // 分类分组容器：数据分析师 → data-analysis，溯真 → research
  const dataGroup = dialog.locator('[data-role-category="data-analysis"]');
  const researchGroup = dialog.locator('[data-role-category="research"]');
  await expect(dataGroup).toBeVisible();
  await expect(researchGroup).toBeVisible();
  await expect(dataGroup.getByText('数据分析师', { exact: true })).toBeVisible();
  await expect(researchGroup.getByText('溯真', { exact: true })).toBeVisible();

  // 卡片图标：data-analysis 组内角色卡片含 lucide svg（非兜底 UserCircle 纯文字）
  await expect(dataGroup.locator('svg').first()).toBeVisible();

  await page.screenshot({ path: 'screenshots/capprod-roles-grouped.png', fullPage: false });
});

test('P2-2 已安装内置 Skills 按产物分类二次分组', async ({ page }) => {
  const dialog = await openCapabilitySettings(page);

  // 切到左侧导航「Skills」section（默认落在权限与安全）
  await dialog.getByRole('button', { name: 'Skills', exact: true }).click();

  // 默认在「已安装」tab；内置组按分类拆出 development 等小节
  const devSub = dialog.locator('[data-skill-category="development"]');
  await expect(devSub).toBeVisible({ timeout: 10_000 });
  // development 小节标题 + 至少一个内置 dev skill 行（commit/review/test/...）
  await expect(devSub.getByText('开发工程', { exact: false })).toBeVisible();

  // research 分类小节也应存在（literature-review / paper-distillation / research-monitor）
  await expect(dialog.locator('[data-skill-category="research"]')).toBeVisible();

  await page.screenshot({ path: 'screenshots/capprod-skills-grouped.png', fullPage: false });
});
