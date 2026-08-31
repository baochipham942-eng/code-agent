// ============================================================================
// Roles E2E - 角色（专家）面板 UI 挂载验证（持久化角色资产，设计 §7/§8 验收 4 的 UI 侧）
// Web Server 模式下运行（无需 Tauri/Electron）
//
// 验证：
//   1. 侧栏「能力中心」→ 专家 tab 可进入
//   2. 预设角色卡片（溯真 / 数据分析师）渲染
//   3. 点「详情」进入角色详情：记录 tab 有 主动性 / 角色记忆 / 工作履历，
//      个性化 tab 有 角色定义编辑器
//   4. 返回列表正常
//
// 前置：webServer 启动时 installBuiltinRoles 会自动安装预设角色，
// 所以角色卡片必然存在（记忆/履历可能为空，空态也是合法渲染）。
//
// 2026-08-18 入口 + 布局迁移（ADR-049）：
//   - 原「打开面板」→ Skills 面板 → 设置弹窗「角色」tab 这条路整条已下线；
//     角色的家是侧栏「能力中心」→ 专家 tab（settingsTabs.ts 的 roles → experts 重定向同源）。
//   - 详情页从「四区块平铺」改成六个 tab（基本信息/个性化/技能/模型/安全/记录），
//     主动性 + 角色记忆 + 工作履历在「记录」，角色定义在「个性化」。
// ============================================================================

import { test, expect, type Page } from './fixtures/axeTest';
import { dismissFirstRunDialogs } from './firstRunDialogs';

test.setTimeout(60_000);

/** 打开侧栏「能力中心」→ 专家 tab */
async function openExpertPanel(page: Page) {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissFirstRunDialogs(page);

  await page.getByTestId('sidebar-capability-hub').click();
  const hub = page.getByTestId('capability-hub-page');
  await expect(hub).toBeVisible({ timeout: 15_000 });
  await hub.getByTestId('capability-hub-tab-experts').click();
  await expect(hub.getByTestId('expert-panel')).toBeVisible({ timeout: 15_000 });
  return hub;
}

test('专家面板渲染预设角色卡片', async ({ page }) => {
  const hub = await openExpertPanel(page);

  // 预设角色卡片（installBuiltinRoles 在 webServer 启动时安装，必然存在）。
  // 卡面显示的是 displayName（会改，如 数据分析师 → 知微），roleId 不会，用 testid 定位。
  await expect(hub.getByTestId('expert-card-溯真')).toBeVisible({ timeout: 15_000 });
  await expect(hub.getByTestId('expert-card-数据分析师')).toBeVisible();

  // 内置来源标记
  await expect(hub.getByTestId('expert-source-溯真')).toBeVisible();

  await page.screenshot({ path: 'screenshots/roles-tab-list.png', fullPage: false });
});

test('角色详情：记录 tab 的 主动性 / 记忆 / 履历 + 个性化 tab 的角色定义', async ({ page }) => {
  const hub = await openExpertPanel(page);

  await hub.getByTestId('expert-detail-溯真').click();
  const detail = page.getByTestId('role-detail-page-溯真');
  await expect(detail).toBeVisible({ timeout: 15_000 });

  // 记录 tab：主动性 + 角色记忆（N）+ 工作履历（记忆/履历可能为空 → 空态也算渲染成功）
  await detail.getByTestId('role-detail-tab-records').click();
  await expect(detail.getByText('主动性', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(detail.getByText(/角色记忆（\d+）/)).toBeVisible();
  await expect(detail.getByText('工作履历', { exact: true })).toBeVisible();

  // 主动性出厂默认为静默档，三档都在
  await expect(detail.getByText('静默', { exact: true })).toBeVisible();
  await expect(detail.getByText('每日简报', { exact: true })).toBeVisible();
  await expect(detail.getByText('实时介入', { exact: true })).toBeVisible();

  // 个性化 tab：角色定义正文编辑器
  await detail.getByTestId('role-detail-tab-personalization').click();
  await expect(detail.getByTestId('role-definition-body')).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: 'screenshots/roles-tab-detail.png', fullPage: false });

  // 常驻边界：硬约束块常驻在分段芯片之上，不属于任何一段正文——它由系统强制执行，
  // 而三段正文只进提示词。断言两者同屏且各自独立可见，防止有人再把它塞回某一段里。
  await expect(detail.getByRole('heading', { name: '常驻边界' })).toBeVisible();
  await expect(detail.getByText('不允许对外发送', { exact: true })).toBeVisible();
  await expect(detail.getByTestId('role-personalization-boundary-external-sending')).toBeVisible();
  await expect(detail.getByTestId('role-personalization-save-boundary')).toBeVisible();
  // 「行为准则」段保持原义，没有被边界占用。
  await detail.getByTestId('role-personalization-segment-soul').click();
  await expect(detail.getByRole('heading', { name: '行为准则' })).toBeVisible();
  await expect(detail.getByTestId('role-personalization-soul')).toBeVisible();
  await expect(detail.getByText(/不会让工具真的被挡下来/)).toBeVisible();
  await page.screenshot({ path: 'screenshots/roles-tab-standing-boundary.png', fullPage: false });

  // 返回能力中心
  await detail.getByRole('button', { name: '能力中心' }).click();
  await expect(hub.getByTestId('expert-card-数据分析师')).toBeVisible({ timeout: 10_000 });
});

test('主动性开关：开启每日简报 → 立即生效并持久化', async ({ page }) => {
  const hub = await openExpertPanel(page);
  await hub.getByTestId('expert-detail-溯真').click();
  const detail = page.getByTestId('role-detail-page-溯真');
  await detail.getByTestId('role-detail-tab-records').click();
  await expect(detail.getByText('主动性', { exact: true })).toBeVisible({ timeout: 10_000 });

  // 点击「每日简报」档
  await detail.getByText('每日简报', { exact: true }).click();
  await expect(detail.getByText(/每天 09:00 醒来巡检产物/)).toBeVisible({ timeout: 10_000 });

  // 退出再进入详情 → 配置已持久化（settings 写入 + detail 反映）
  await detail.getByRole('button', { name: '能力中心' }).click();
  await hub.getByTestId('expert-detail-溯真').click();
  await detail.getByTestId('role-detail-tab-records').click();
  await expect(detail.getByText('主动性', { exact: true })).toBeVisible({ timeout: 10_000 });
  // 选中态断言走 aria-pressed，不再靠 class 名（旧断言写死 border-emerald-600/70，
  // 该类名已改成 border-badge-success/70，断言从此静默腐烂）。
  const selectedOption = detail.locator('button[aria-pressed="true"]');
  await expect(selectedOption).toHaveCount(1, { timeout: 10_000 });
  await expect(selectedOption).toContainText('每日简报');

  await page.screenshot({ path: 'screenshots/roles-tab-proactivity.png', fullPage: false });

  // 收尾：改回静默（不污染后续测试/环境）
  await detail.getByText('静默', { exact: true }).click();
  await expect(detail.locator('button[aria-pressed="true"]')).toContainText('静默', { timeout: 10_000 });
});
