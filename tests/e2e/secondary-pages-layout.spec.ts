// ============================================================================
// 二级页架构 E2E（批 C / PR-C1）—— 真 webServer + 真 store + 真 DOM
//
// 钉三件事（改动是布局与路由面，组件单测看不见）：
//   1. 可达：侧栏三个入口分别打开能力中心 / 资料库 / 自动化
//   2. 不接管整窗：二级页在位时**左侧边栏仍然可见可点**（这是本批的核心改动，
//      改回 fixed inset-0 会当场红）；侧栏对应行 aria-current="page"
//   3. 可返回 + 深链不死：侧栏横向切换三页互不残留；点会话回到聊天区；
//      能力中心页内 tab 深链（capability-hub-tab-*）仍可切换
// ============================================================================

import { test, expect, type Page } from '@playwright/test';

test.setTimeout(90_000);

const PAGES = [
  { entry: 'sidebar-capability-hub', page: 'capability-hub-page' },
  { entry: 'sidebar-capability-library', page: 'library-panel' },
  { entry: 'sidebar-capability-automation', page: 'cron-center-panel' },
] as const;

async function waitForAppReady(page: Page): Promise<void> {
  const ssePromise = page.waitForResponse((resp) => resp.url().includes('/api/events'), { timeout: 20_000 });
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;
  // 首启浮层会吃掉侧栏点击：①文件夹信任 ②连接模型 onboarding ③被 onboarding「跳过」送进的设置页
  for (const name of ['信任并加载', '跳过，稍后在设置里配置', '返回应用']) {
    const btn = page.getByRole('button', { name });
    await btn.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await btn.first().isVisible().catch(() => false)) {
      await btn.first().click();
      await expect(btn.first()).toBeHidden({ timeout: 10_000 });
    }
  }
  await expect(page.getByTestId('sidebar-capability-zone')).toBeVisible({ timeout: 15_000 });
}

test('三个二级页可达，且都不接管整窗——侧栏常驻可见', async ({ page }) => {
  await waitForAppReady(page);
  const sidebar = page.getByTestId('sidebar-capability-zone');

  for (const { entry, page: pageTestId } of PAGES) {
    await page.getByTestId(entry).click();
    const secondary = page.getByTestId(pageTestId);
    await expect(secondary).toBeVisible({ timeout: 15_000 });

    // 核心契约：inline 而非 fixed 整窗覆盖
    await expect(secondary).toHaveAttribute('data-page-variant', 'inline');
    // 侧栏没被盖住：仍可见，且三个入口都还点得到（横向切换就靠它们）
    await expect(sidebar).toBeVisible();
    for (const { entry: other } of PAGES) {
      await expect(page.getByTestId(other)).toBeVisible();
    }
    // 当前页在侧栏读得出来
    await expect(page.getByTestId(entry)).toHaveAttribute('aria-current', 'page');
    // 页内不再画「返回应用」——返回语义已交给侧栏
    await expect(secondary.getByTestId('full-screen-page-back')).toHaveCount(0);
  }

  // 横向切换互斥：停在自动化时，前两页已卸载
  await expect(page.getByTestId('capability-hub-page')).toHaveCount(0);
  await expect(page.getByTestId('library-panel')).toHaveCount(0);
});

test('侧栏会话列表的滚动条不挤内容轨——右轨与账号区箭头同轴的前提', async ({ page }) => {
  await waitForAppReady(page);
  const scroll = page.getByTestId('sidebar-session-scroll');
  await expect(scroll).toBeVisible({ timeout: 15_000 });
  const sibling = page.getByTestId('sidebar-capability-zone');
  await expect(sibling).toBeVisible({ timeout: 15_000 });

  // 全局 ::-webkit-scrollbar 是 6px 占位式滚动条。它**可以存在**（产品负责人 2026-07-28
  // 对着 Codex 拍板：滚动条要看得见，只是不能挤内容），关键是别让它把列表内的右轨
  // 相对不滚动的兄弟块左移——那正是 206 vs 212 错轴的成因。
  // 做法是侧栏根让出一条同宽窄带、列表用等宽负 margin 要回去，于是：
  //   列表**内容盒**宽度 === 不滚动兄弟块（能力区）的宽度。
  // 这条不变量对「溢出 / 不溢出」都成立，所以先强制溢出再比。
  const widths = await scroll.evaluate((node) => {
    const el = node as HTMLElement;
    el.style.maxHeight = '40px'; // 与会话数无关地制造溢出
    return {
      overflowing: el.scrollHeight > el.clientHeight,
      clientWidth: el.clientWidth,
      offsetWidth: el.offsetWidth,
    };
  });
  const siblingWidth = await sibling.evaluate((node) => (node as HTMLElement).offsetWidth);
  expect(widths.overflowing).toBe(true);
  // 滚动条确实还在（占了自己那条窄带），没有被藏掉
  expect(widths.offsetWidth).toBeGreaterThan(widths.clientWidth);
  // 但内容轨与兄弟块同宽 ⇒ 右轨不左移
  expect(widths.clientWidth).toBe(siblingWidth);
});

test('点会话回到聊天区，二级页让位', async ({ page }) => {
  await waitForAppReady(page);

  const newTaskBtn = page.getByTestId('sidebar-new-task');
  await expect(newTaskBtn).toBeVisible({ timeout: 15_000 });
  await newTaskBtn.click();
  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  await expect(activeSession).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('sidebar-capability-hub').click();
  await expect(page.getByTestId('capability-hub-page')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-chat-input]')).toHaveCount(0);

  // 点的是**当前**会话（switchSession 早退分支）——照样必须回得来
  await activeSession.click();
  await expect(page.getByTestId('capability-hub-page')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
});

test('能力中心页内 tab 深链仍可切换', async ({ page }) => {
  await waitForAppReady(page);
  await page.getByTestId('sidebar-capability-hub').click();
  await expect(page.getByTestId('capability-hub-page')).toBeVisible({ timeout: 15_000 });

  for (const tab of ['skills', 'connectors', 'experts']) {
    const tabBtn = page.getByTestId(`capability-hub-tab-${tab}`);
    await expect(tabBtn).toBeVisible({ timeout: 10_000 });
    await tabBtn.click();
    await expect(tabBtn).toHaveAttribute('aria-selected', 'true');
  }
});
