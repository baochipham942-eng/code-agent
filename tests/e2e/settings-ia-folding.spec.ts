// ============================================================================
// Settings IA 收敛 E2E — 侧栏三态（maka⑤批 v2 拍板 2026-07-03）
// Web Server 模式下运行（无需 Tauri/Electron）
//
// 验证：
//   1. 默认 5 组 + 「高级」组头可见，组序正确
//   2. 「高级」默认折叠：agentEngine/MCP/插件/Hook 不渲染
//   3. 点组头展开：技术项出现且可点入（普通用户可自行配置）
//   4. 再点收起
// ============================================================================

import { test, expect, type Page } from '@playwright/test';

test.setTimeout(60_000);

// 打开设置弹窗。2026-08-18 改走 settings.open 快捷键（Cmd+, / Ctrl+,，
// src/shared/keybindings/actions.ts 的出厂绑定）：原来那条
// 「打开面板」→ Skills 面板 →「在设置中管理 Skill 库」的路，三个环节按 ADR-049 全已下线
// （「打开面板」按钮在 src 里已不存在）。侧栏账号菜单里的「设置」入口只在**已登录**时挂载，
// e2e 从不登录，所以不能走它。
async function openSettings(page: Page) {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press('ControlOrMeta+Comma');
  const settingsDialog = page.getByRole('dialog', { name: '设置' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
  // 侧栏 nav 单独取范围（内容区也可能出现"高级"等字样，侧栏断言必须锁定 nav）
  return { dialog: settingsDialog, nav: settingsDialog.locator('aside nav') };
}

test('设置侧栏默认 5 组 + 高级组折叠', async ({ page }) => {
  const { dialog, nav } = await openSettings(page);

  for (const label of ['模型与能力', '基础偏好', '工作与协作', '记忆与隐私', '系统']) {
    await expect(nav.getByText(label, { exact: true })).toBeVisible();
  }

  // 高级组头可见但默认折叠（aria-expanded=false，技术项不渲染）
  const advancedHeader = nav.getByRole('button', { name: '高级' });
  await expect(advancedHeader).toBeVisible();
  await expect(advancedHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(nav.getByRole('button', { name: 'MCP', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: '插件管理', exact: true })).toHaveCount(0);

  // 默认可见的用户向 tab 在场。原来这里断言的是「角色」——它已按 ADR-049 搬进侧栏
  // 「能力中心」→ 专家 tab，设置侧栏里不再有（2026-08-18 实测 count=0），换成仍在的两项。
  await expect(nav.getByRole('button', { name: '外观', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: '隐私防线', exact: true })).toBeVisible();
});

test('高级组展开后普通用户可进 MCP/插件/Hook', async ({ page }) => {
  const { dialog, nav } = await openSettings(page);

  const advancedHeader = nav.getByRole('button', { name: '高级' });
  await advancedHeader.click();
  await expect(advancedHeader).toHaveAttribute('aria-expanded', 'true');

  // MCP / 插件管理已按 ADR-049 搬进能力中心（连接器 / 插件 tab），设置侧栏里不再有；
  // 「高级」组现在剩下这三项（2026-08-18 实测）。
  for (const label of ['Hook', '应用截图', '数据与存储']) {
    await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
  }

  // 点入 Hook 验证内容区切换（可自行配置，非只读）
  await nav.getByRole('button', { name: 'Hook', exact: true }).click();
  await expect(dialog.locator('main')).toContainText('Hook', { timeout: 10_000 });

  // 再点组头收起
  await advancedHeader.click();
  await expect(advancedHeader).toHaveAttribute('aria-expanded', 'false');
});
