// ============================================================================
// Capability Productization E2E - P2-1 角色视觉化 + P2-2 内置 skill 分类分组
// Web Server 模式（无需 Tauri/Electron），系统 Chrome
//
// 验证（UI 真挂载，非 vitest 静态）：
//   P2-1：专家页按产物分类给出过滤 chips，选中后只留该分类的专家卡
//   P2-1：专家卡片渲染图标（lucide svg，非纯文字）
//   P2-2：已安装 Skills 的内置组按产物分类二次分组（development 等分类小节渲染）
//
// 前置：webServer 启动时 installBuiltinRoles 安装预设角色 + loadBuiltinSkills 加载内置 skill。
//
// 2026-08-18 入口迁移（ADR-049，07-23 拍、07-27 修订）：能力的唯一的家是侧栏「能力中心」。
// 原剧本走的「打开面板」→ Skills 面板 →「在设置中管理 Skill 库」→ 设置弹窗这条路，
// 三个环节都已下线（「打开面板」按钮在 src 里已不存在，SkillsPanel 在 renderer 里已无
// 挂载点，设置页 skills tab 已删）。对用户零可见、不改产品，只改测试。
//
// 同批实地核出的第二处口径变化：data-role-category 已不是「分组容器」，
// 而是 HubTabHeader 上的**过滤 chip**（带计数，点了才过滤专家货架）。
// 断言随之从「分组容器里含某角色」改成「点该分类 chip 后货架只剩它」。
// ============================================================================

import { test, expect, type Page } from './fixtures/axeTest';
import { dismissFirstRunDialogs } from './firstRunDialogs';

test.setTimeout(60_000);

/** 打开侧栏「能力中心」，切到指定 tab */
async function openCapabilityHub(page: Page, tab: 'experts' | 'skills') {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissFirstRunDialogs(page);

  await page.getByTestId('sidebar-capability-hub').click();
  const hub = page.getByTestId('capability-hub-page');
  await expect(hub).toBeVisible({ timeout: 15_000 });
  await hub.getByTestId(`capability-hub-tab-${tab}`).click();
  return hub;
}

test('P2-1 专家页按产物分类过滤 + 卡片渲染图标', async ({ page }) => {
  const hub = await openCapabilityHub(page, 'experts');

  // 预设角色卡片仍渲染（回归）。displayName 会变（数据分析师 → 知微），roleId 不会，用它定位。
  const dataAnalyst = hub.getByTestId('expert-card-数据分析师');
  const researcher = hub.getByTestId('expert-card-溯真');
  await expect(dataAnalyst).toBeVisible({ timeout: 15_000 });
  await expect(researcher).toBeVisible();

  // 分类 chips：数据分析师 → data-analysis，溯真 → research
  const dataChip = hub.getByTestId('expert-category-chip-data-analysis');
  const researchChip = hub.getByTestId('expert-category-chip-research');
  await expect(dataChip).toBeVisible();
  await expect(researchChip).toBeVisible();

  // 选中 data-analysis：只留该分类的专家，research 的被过滤掉
  await dataChip.click();
  await expect(dataChip).toHaveAttribute('aria-pressed', 'true');
  await expect(dataAnalyst).toBeVisible();
  await expect(researcher).toHaveCount(0);

  // 卡片图标：分类内的专家卡含 lucide svg（非兜底 UserCircle 纯文字）
  await expect(dataAnalyst.locator('svg').first()).toBeVisible();

  // 切到 research：反过来
  await researchChip.click();
  await expect(researcher).toBeVisible();
  await expect(dataAnalyst).toHaveCount(0);

  await page.screenshot({ path: 'screenshots/capprod-roles-grouped.png', fullPage: false });
});

test('P2-2 已安装内置 Skills 按产物分类二次分组', async ({ page }) => {
  const hub = await openCapabilityHub(page, 'skills');

  // 技能页默认落「发现安装」（市场），分类小节在「已安装 (N)」子 tab 下。
  await hub.getByText(/已安装 \(\d+\)/).click();

  // 内置组按分类拆出 development 等小节
  const devSub = hub.locator('[data-skill-category="development"]');
  await expect(devSub).toBeVisible({ timeout: 15_000 });
  // development 小节标题 + 至少一个内置 dev skill 行（commit/review/test/...）
  await expect(devSub.getByText('开发工程', { exact: false })).toBeVisible();

  // research 分类小节也应存在（literature-review / paper-distillation / research-monitor）
  await expect(hub.locator('[data-skill-category="research"]')).toBeVisible();

  await page.screenshot({ path: 'screenshots/capprod-skills-grouped.png', fullPage: false });
});
