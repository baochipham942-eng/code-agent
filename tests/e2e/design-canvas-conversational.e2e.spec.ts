// ============================================================================
// E2E: 设计 Surface 会话化改造（一期）— 聊天入口 → design-canvas tab → konva 渲染
// ============================================================================
//
// 目标: 验证「从聊天里点设计画布入口 → design-canvas workbench tab 激活 →
//        konva 画布在 tab 内真实渲染且尺寸非零」这条新接线。
//
//   click [data-testid=open-design-canvas]
//     → markSessionDesignActive(currentSessionId) + openWorkbenchTab('design-canvas')
//     → App.tsx 渲染 <DesignCanvasTab/> → <DesignCanvas/> (konva Stage)
//     → Stage 经 ResizeObserver 拿到 wrapper 像素宽高 → 渲染 <canvas>
//
// 本刀唯一的真集成风险: DesignCanvas 从全屏覆盖层挪进 workbench tab 后，
//   能否拿到非零尺寸正常渲染（konva Stage 需要显式像素宽高）。
//   断言 <canvas> 的 getBoundingClientRect() 宽高均 > 0 即证伪 T3 尺寸 concern。
//
// 不在本刀范围（已被组件内部测试覆盖, 随组件挂进 tab 自动跟来）:
//   真实 agent 出图 / proposeCanvasOps / 审批条 / 付费。这里不驱动任何模型。
//
// harness 完全跟随 new-session.e2e.spec.ts。
// ============================================================================

import { test, expect, type Page } from '@playwright/test';

// design-canvas tab label 走 i18n（zh.ts: '设计画布'）。E2E 默认中文 UI。
const CANVAS_TAB_LABEL = '设计画布';

test.setTimeout(60_000);

async function waitForAppReady(page: Page): Promise<void> {
  // SSE 连接在 goto 之前挂监听, 避免错过初始请求
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;
  // 全新环境（换目录跑、或新建 e2e 数据目录）会连弹两层遮罩，挡住底下所有交互：
  // ①「信任这个项目文件夹?」②「连接模型」onboarding。都是首启才有，出现才点。
  for (const name of ['信任并加载', '跳过，稍后在设置里配置']) {
    const btn = page.getByRole('button', { name });
    // 第二层要等：信任弹窗点掉之后 onboarding 才开始挂载，立刻查会扑空。
    await btn.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await expect(btn).toBeHidden({ timeout: 10_000 });
    }
  }
  // onboarding 的「跳过」会把人送进设置页，不是回聊天，得再退一步。
  const backToApp = page.getByRole('button', { name: '返回应用' });
  await backToApp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await backToApp.isVisible().catch(() => false)) {
    await backToApp.click();
    await expect(backToApp).toBeHidden({ timeout: 10_000 });
  }
}

// ----------------------------------------------------------------------------
// 进有会话的状态: 点「新会话」, 等 active session + chat 输入框出现。
// （复刻 new-session spec 的建会话路径。WorkbenchTabs 的设计画布入口只在有
//   currentSessionId 时可用，否则 disabled。）
// ----------------------------------------------------------------------------
async function enterSessionState(page: Page): Promise<void> {
  // 侧栏入口 2026-07 改名「新任务」，保留旧名兜底免得又静默腐烂。
  const newSessionBtn = page.getByRole('button', { name: /新任务|新会话/ }).first();
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();

  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  await expect(activeSession).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
}

test('从聊天点设计画布入口 → design-canvas tab 激活 + konva 画布非零尺寸渲染', async ({ page }) => {
  await waitForAppReady(page);
  await enterSessionState(page);

  // 1. 宽屏下右栏常驻，没打开任何面板时直接给空态启动器；有会话时设计画布可点。
  //    （旧写法先用 TitleBar 开一个 tab、再找 open-design-canvas —— 那个 testid 和
  //    「Show task panel」标签早已不存在，此 spec 不在 CI 内所以一直没被发现。）
  const entryBtn = page.locator('[data-testid="open-workbench-view-design-canvas"]');
  await expect(entryBtn).toBeVisible({ timeout: 10_000 });
  await expect(entryBtn).toBeEnabled();

  await entryBtn.click();

  // 2. design-canvas tab 激活: tab 标签可见（= t.design.canvasTabLabel）
  //    标签是 tab 工具条里的 <span class="truncate">，用文本定位避免误命中按钮 title/aria。
  const canvasTabLabel = page.locator('span.truncate', { hasText: CANVAS_TAB_LABEL });
  await expect(canvasTabLabel).toBeVisible({ timeout: 10_000 });

  // 3. DesignCanvasTab 外层容器出现（用专属 testid 区分全屏覆盖层的 design-canvas，M3 防重复）
  const canvasContainer = page.locator('[data-testid="design-canvas-tab"]');
  await expect(canvasContainer).toBeVisible({ timeout: 10_000 });

  // 4. konva 真渲染: tab 容器内出现 <canvas>，且 getBoundingClientRect 宽高均 > 0。
  //    konva Stage 仅在 size.w>0 && size.h>0 时挂载（ResizeObserver 跟随 wrapper），
  //    故 canvas 出现本身就证明 Stage 拿到了非零尺寸；再断言 rect 宽高坐实。
  //    在 tab 容器内查 canvas，去掉脆弱的全局 .first()。
  const konvaCanvas = canvasContainer.locator('canvas').first();
  await expect(konvaCanvas).toBeVisible({ timeout: 10_000 });

  const box = await konvaCanvas.boundingBox();
  expect(box, 'konva <canvas> 应有 boundingBox（已布局渲染）').not.toBeNull();
  expect(
    box!.width,
    `konva canvas 宽度应 > 0（T3 尺寸 concern 证伪），实测 ${box!.width}`,
  ).toBeGreaterThan(0);
  expect(
    box!.height,
    `konva canvas 高度应 > 0（T3 尺寸 concern 证伪），实测 ${box!.height}`,
  ).toBeGreaterThan(0);
});

// 注：「无当前会话时入口 disabled」未单独成测——本地启动会自动选中/恢复一个会话，
// 无法确定性进入 currentSessionId 为空的状态去断言 disabled。该 disabled 行为是
// 入口按钮上 `disabled={!currentSessionId}` 的静态属性，不需 E2E 守护。

// ----------------------------------------------------------------------------
// 右栏收起/展开是整栏级动作（App.tsx 的 showWorkbench 受 workbenchCollapsed 门控）。
// 那一行没有任何组件单测能覆盖——WorkbenchTabs 的单测只看得到自己，看不到外层
// Panel 到底还在不在。所以这条必须真跑。
// ----------------------------------------------------------------------------
test('右栏能整栏收起，再从标题栏展开回原来的面板', async ({ page }) => {
  await waitForAppReady(page);
  await enterSessionState(page);

  const launcher = page.locator('[data-testid="workbench-empty-launcher"]');
  await expect(launcher).toBeVisible({ timeout: 10_000 });

  await page.locator('[data-testid="open-workbench-view-overview"]').click();
  const selector = page.locator('[data-testid="workbench-view-selector"]');
  await expect(selector).toBeVisible({ timeout: 10_000 });

  // 收起：整栏消失，不只是关掉一个面板。
  await page.getByRole('button', { name: '收起面板' }).first().click();
  await expect(selector).toBeHidden({ timeout: 10_000 });
  await expect(launcher).toBeHidden();

  // 展开：回到收起前那个面板，不是回空态。
  await page.getByRole('button', { name: '展开面板' }).click();
  await expect(selector).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('span.truncate', { hasText: '概览' }).first()).toBeVisible();
});
