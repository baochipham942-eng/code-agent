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

import { test, expect, type Page } from './fixtures/axeTest';

test.setTimeout(60_000);

// 打开设置弹窗。2026-08-18 改走 settings.open 快捷键（Cmd+, / Ctrl+,，
// src/shared/keybindings/actions.ts 的出厂绑定）：原来那条
// 「打开面板」→ Skills 面板 →「在设置中管理 Skill 库」的路，三个环节按 ADR-049 全已下线
// （「打开面板」按钮在 src 里已不存在）。侧栏账号菜单里的「设置」入口只在**已登录**时挂载，
// e2e 从不登录，所以不能走它。
async function openModelSettings(page: Page) {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press('ControlOrMeta+Comma');
  const settingsDialog = page.getByRole('dialog', { name: '设置' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });

  const nav = settingsDialog.locator('aside nav');
  await nav.getByRole('button', { name: '通用模型', exact: true }).click();
  // 内容区断言一律锁在 <main> 里：侧栏 nav 里也有「诊断」等同名按钮，不锁会撞 strict mode。
  return { dialog: settingsDialog, nav, main: settingsDialog.locator('main') };
}

test('模型设置页渲染 Master-Detail 布局', async ({ page }) => {
  const { main: dialog } = await openModelSettings(page);

  // 左侧 Provider 列表。占位符里是 U+2026 省略号，不是三个 ASCII 点（旧写法用的是后者，永远找不到）。
  await expect(dialog.getByPlaceholder('搜索 Provider 或模型…')).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByRole('button', { name: '新增 Provider', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '诊断' })).toBeVisible();
  await expect(dialog.getByText(/已可用 · \d+/)).toBeVisible();

  // 右侧详情面板：① 连接 区块（标题与步骤编号同节点，用唯一字段 label 断言）
  await expect(dialog.getByText('接口地址（Base URL）').first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: '测试连接' })).toBeVisible();

  await page.screenshot({ path: 'screenshots/model-settings-master-detail.png', fullPage: false });
});

test('引擎目录拆为独立 tab，模型页不再包含引擎目录', async ({ page }) => {
  const { nav, main } = await openModelSettings(page);

  // 引擎目录区块的标题已从「Agent Engine 模型目录」改成「外部引擎默认模型」
  // ——前者现在只是 admin 控制平面的 artifact 标签（zhSettingsSystem.ts:515），不再是设置页区块。
  await expect(main.getByText('接口地址（Base URL）').first()).toBeVisible({ timeout: 10_000 });
  await expect(main.getByText('外部引擎默认模型')).not.toBeVisible();

  // 独立 tab 现在叫「执行引擎」（原「Agent 引擎」），并被收进侧栏折叠的「高级」组里
  // ——2026-08-18 实测：不展开「高级」，nav 里 count=0。
  await nav.getByRole('button', { name: '高级' }).click();
  await nav.getByRole('button', { name: '执行引擎', exact: true }).click();
  await expect(main.getByText('外部引擎默认模型')).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: 'screenshots/agent-engine-settings-tab.png', fullPage: false });
});

// 原名「『新增』切换到新增表单」。ModelSettings.tsx 给这个按钮写死了 `disabled={isWebMode()}`，
// 而 e2e 恒在 web 模式 ⇒ 新增自定义 Provider 的表单在本 harness 里**产品上就不可达**，
// 断言表单字段等于要求一个桌面端专属能力在 web 下出现，永远红。
// 改成守住真实契约：按钮在场且在 web 模式下被禁用（这条一旦被误改成可用，会立刻红）。
test('新增 Provider 是桌面端能力：web 模式下按钮在场但禁用', async ({ page }) => {
  const { main } = await openModelSettings(page);

  const addProvider = main.getByRole('button', { name: '新增 Provider', exact: true });
  await expect(addProvider).toBeVisible({ timeout: 10_000 });
  await expect(addProvider).toBeDisabled();

  await page.screenshot({ path: 'screenshots/model-settings-add-provider.png', fullPage: false });
});

test('未配置 Provider 显示渐进式空态', async ({ page }) => {
  const { main } = await openModelSettings(page);

  // 分组标题是「待添加 Key · N」（不是「未配置 · N」），组内每行是「<首字母> / <名字> / 添加 Key」，
  // 行上已没有「配置 →」按钮——2026-08-18 实测，直接点行本身即可进详情。
  const unconfiguredToggle = main.getByRole('button', { name: /待添加 Key · \d+/ });
  await expect(unconfiguredToggle).toBeVisible({ timeout: 10_000 });
  await unconfiguredToggle.click();

  await main.getByRole('button', { name: /添加 Key/ }).first().click();

  // 渐进式空态：连接区块在，模型区块提示填 Key
  await expect(main.getByText('填写 API Key 并测试连接后，即可发现和启用该 Provider 的模型。')).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: 'screenshots/model-settings-unconfigured.png', fullPage: false });
});
