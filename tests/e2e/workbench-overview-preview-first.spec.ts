import { test, expect, type Page } from '@playwright/test';

test.setTimeout(60_000);

// 首启三层遮罩（信任文件夹 → 连接模型 onboarding → 跳过后落在设置页），出现才点。
// 与 design-canvas-conversational.e2e.spec.ts 同款，不复制会静默扑空。
async function waitForAppReady(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  for (const name of ['信任并加载', '跳过，稍后在设置里配置']) {
    const btn = page.getByRole('button', { name });
    await btn.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await expect(btn).toBeHidden({ timeout: 10_000 });
    }
  }
  const backToApp = page.getByRole('button', { name: '返回应用' });
  await backToApp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await backToApp.isVisible().catch(() => false)) {
    await backToApp.click();
    await expect(backToApp).toBeHidden({ timeout: 10_000 });
  }
}

// 右栏概览面板改成预览优先后，在真实渲染路径上确认：面板挂得上、旧的清单外壳确实没了。
// 组件单测覆盖不到「外层还在不在」（App 门控只有 e2e 会红），这条补的就是那一层。
//
// 覆盖边界（写明而不是假装覆盖了）：fresh-home 没有产物，所以这里验的是空态 + 旧外壳
// 已移除；「有产物时内容占满、元数据在详情里」由 workspacePreviewContentFirst 单测钉。
test('右栏概览是预览优先的形态，旧的清单外壳已移除', async ({ page }) => {
  await waitForAppReady(page);

  // 右栏默认收起（#700 的 workbenchCollapsed），先从标题栏展开
  const expandPanel = page.getByRole('button', { name: '展开面板' });
  await expandPanel.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (await expandPanel.isVisible().catch(() => false)) {
    await expandPanel.click();
  }

  // 空栏时是 workbench-empty-launcher，已有视图时走左上角的视图选择器
  const emptyLauncher = page.getByTestId('workbench-empty-launcher');
  const viewSelector = page.getByRole('button', { name: '选择当前视图' });
  await expect(emptyLauncher.or(viewSelector)).toBeVisible({ timeout: 15_000 });
  if (await viewSelector.isVisible().catch(() => false)) {
    await viewSelector.click();
  }
  await page.getByTestId('open-workbench-view-overview').click();

  const overview = page.getByTestId('workbench-overview-view');
  await expect(overview).toBeVisible({ timeout: 10_000 });

  // 空态：说清楚没有产物，而不是给一堆按钮
  await expect(overview.getByText('暂无可预览文件')).toBeVisible({ timeout: 10_000 });

  // 旧外壳三件（会话产物折叠头 / 统计行 / 文件小标题）都不许再出现
  await expect(overview.getByText('本会话产物')).toHaveCount(0);
  await expect(overview.getByText(/\d+ 文件 · \d+ 图片/)).toHaveCount(0);

  // 没有产物时不该有切换器，也不该有详情开关
  await expect(page.getByTestId('workspace-artifact-switcher')).toHaveCount(0);
  await expect(page.getByTestId('workspace-preview-details-toggle')).toHaveCount(0);

  await overview.screenshot({ path: 'tests/e2e/screenshots/workbench-overview-preview-first.png' });
});
