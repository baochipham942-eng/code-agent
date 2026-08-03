import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AgentEvent, Artifact } from '../../src/shared/contract';

type RendererAgentEvent = AgentEvent & { sessionId?: string };

test.setTimeout(90_000);

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
  );
  expect(token, 'window.__CODE_AGENT_TOKEN__ missing — static.ts token injection broke').toBeTruthy();
  return token!;
}

// 产物注入不另开测试缝：`POST /api/dev/emit-agent-events`（dev API 门控，生产构建拿不到）
// 已经是走完整生产链路的那条缝——SSE → httpTransport → useAgent → sessionStore.messages
// → useWorkspacePreviewModel → 右栏。给生产多开一个后门不如复用这一个。
async function emitAgentEvents(
  request: APIRequestContext,
  token: string,
  events: RendererAgentEvent[],
): Promise<void> {
  const response = await request.post('/api/dev/emit-agent-events', {
    data: { events },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(
    response.ok(),
    `emit-agent-events failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);
}

// turn_start 先建出 assistant 占位消息（id = turnId），'message' 事件才有落点挂 artifacts——
// 只发 'message' 会被 handler 静默丢弃（它只更新已存在的 assistant 消息）。
function artifactTurnEvents(sessionId: string, turnId: string, artifact: Artifact): RendererAgentEvent[] {
  return [
    { type: 'turn_start', sessionId, data: { turnId } },
    { type: 'stream_chunk', sessionId, data: { turnId, content: `已产出 ${artifact.title}。` } },
    {
      type: 'message',
      sessionId,
      // Message 契约要求 role/timestamp；turnId 是 renderer 侧用来找落点的额外字段。
      data: {
        id: turnId,
        role: 'assistant',
        content: `已产出 ${artifact.title}。`,
        timestamp: Date.now(),
        artifacts: [artifact],
        ...({ turnId } as Record<string, string>),
      },
    },
    { type: 'turn_end', sessionId, data: { turnId } },
    { type: 'agent_complete', sessionId, data: null },
  ];
}

async function createSessionAndGetId(page: Page): Promise<string> {
  const newTask = page.getByTestId('sidebar-new-task');
  await expect(newTask).toBeVisible({ timeout: 15_000 });
  await newTask.click();
  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  await expect(activeSession).toBeVisible({ timeout: 15_000 });
  const sessionId = await activeSession.getAttribute('data-session-id');
  expect(sessionId, 'active session id missing after creating an E2E session').toBeTruthy();
  return sessionId!;
}

async function openOverviewView(page: Page): Promise<void> {
  // 右栏默认收起（2026-07-27 审美关把 appStore 初值 workbenchCollapsed 改为 true；
  // #700 引入该字段时默认是 false=展开，本行原注释与当时实现不符），先从标题栏展开
  const expandPanel = page.getByRole('button', { name: '展开面板' });
  await expandPanel.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (await expandPanel.isVisible().catch(() => false)) {
    await expandPanel.click();
  }

  // D6 tab 形态（2026-07-26 打磨批 D）：空栏时是 workbench-empty-launcher；已有视图时
  // 概览要么已平铺成 tab（点击即切），要么从「＋」的可打开视图列表里加。
  const emptyLauncher = page.getByTestId('workbench-empty-launcher');
  const overviewTab = page.getByTestId('workbench-tab-overview');
  await expect(emptyLauncher.or(overviewTab)).toBeVisible({ timeout: 15_000 });
  if (await overviewTab.isVisible().catch(() => false)) {
    await overviewTab.click();
  } else {
    const openOverview = page.getByTestId('open-workbench-view-overview');
    if (!(await openOverview.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: '打开新面板' }).click();
    }
    await openOverview.click();
  }
  await expect(page.getByTestId('workbench-overview-view')).toBeVisible({ timeout: 10_000 });
}

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

// 右栏概览面板改成任务工作台后，在真实渲染路径上确认：空态仍然轻，旧清单外壳不复活。
// 组件单测覆盖不到「外层还在不在」（App 门控只有 e2e 会红），这条补的就是那一层。
//
// 覆盖边界（写明而不是假装覆盖了）：这条只验空态 + 旧外壳已移除；有产物那一屏由下面
// 那条 spec 在真实链路上验（组件单测 workspacePreviewContentFirst 仍是判据的主力）。
test('右栏概览空态保持轻量，旧的清单外壳已移除', async ({ page }) => {
  await waitForAppReady(page);
  await openOverviewView(page);

  const overview = page.getByTestId('workbench-overview-view');

  // 空态：任务现场叙事（运行中的任务会实时显示在这里），而不是一个空产物壳或一堆按钮
  await expect(overview.getByText('运行中的任务会实时显示在这里')).toBeVisible({ timeout: 10_000 });

  // 旧外壳三件（会话产物折叠头 / 统计行 / 文件小标题）都不许再出现
  await expect(overview.getByText('本会话产物')).toHaveCount(0);
  await expect(overview.getByText(/\d+ 文件 · \d+ 图片/)).toHaveCount(0);

  // 没有产物时不该有切换器，也不该有详情开关
  await expect(page.getByTestId('workspace-artifact-switcher')).toHaveCount(0);
  await expect(page.getByTestId('workspace-preview-details-toggle')).toHaveCount(0);

  await overview.screenshot({ path: 'tests/e2e/screenshots/workbench-overview-preview-first.png' });
});

// 有产物那一屏：概览主视线固定展示 Todo / 产物（诊断在二级折叠区）；点产物后直接进入专注预览。
// 产物由 sessionStore.messages 推导，e2e 跑生产构建（window.__neoAppStore 只在 DEV 挂），
// 所以从外部按真实事件链注入带 artifacts 的 assistant 消息，而不是往 store 里塞。
test('右栏概览有产物时：工作台分区稳定，点击后直接预览且不带旧详情区', async ({ page, request }) => {
  await waitForAppReady(page);
  const token = await getAuthToken(page);
  const sessionId = await createSessionAndGetId(page);
  await openOverviewView(page);

  const overview = page.getByTestId('workbench-overview-view');
  const firstMarker = `E2E_OVERVIEW_ARTIFACT_${Date.now()}`;
  await emitAgentEvents(request, token, artifactTurnEvents(sessionId, `e2e-overview-turn-1-${Date.now()}`, {
    id: 'e2e-artifact-alpha',
    type: 'mermaid',
    title: '第一版流程图',
    content: `graph TD;\n  A[${firstMarker}] --> B[产物内容占满右栏];`,
    version: 1,
  }));

  // ① 默认工作台：主视线分区固定存在，产物正文不抢占概览。
  // T1 起上下文行/AgentTree 下沉进「诊断详情」二级折叠区，主视线只剩 Todo + 产物。
  const workspace = overview.getByTestId('task-workspace-overview');
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect(workspace.getByRole('button', { name: 'Todo', exact: true })).toBeVisible();
  await expect(workspace.getByRole('button', { name: /产物/ })).toBeVisible();
  await expect(workspace.getByText(firstMarker)).toHaveCount(0);

  // ①b 诊断下沉：入口留在主视线，内容默认不占位；展开后上下文一条不少（内容只下沉不删除）。
  const diagnostics = workspace.getByRole('button', { name: /诊断详情/ });
  await expect(diagnostics).toBeVisible();
  await expect(workspace.getByTestId('overview-diagnostics-body')).toHaveCount(0);
  await diagnostics.click();
  const diagnosticsBody = workspace.getByTestId('overview-diagnostics-body');
  await expect(diagnosticsBody).toBeVisible();
  await expect(diagnosticsBody.getByText('上下文', { exact: true })).toBeVisible();

  // ② 点击产物就是打开，直接进入专注预览。
  await workspace.getByRole('button', { name: '在工作区预览中打开: 第一版流程图', exact: true }).click();
  await expect(page.getByTestId('workbench-overview-preview')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(firstMarker)).toBeVisible();

  // ③ 概览入口的预览不带详情/版本和项目历史；动作仍收在 ⋯。
  await expect(page.getByRole('button', { name: '复制预览' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '归档到资料库: 第一版流程图' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '更多操作' })).toBeVisible();
  await expect(page.getByTestId('workspace-preview-overflow')).toHaveCount(0);
  await expect(page.getByTestId('workspace-preview-details-toggle')).toHaveCount(0);
  await expect(page.getByText(/项目全部产物/)).toHaveCount(0);

  // ④ 第二个产物到了才出现切换器，返回概览后三个分区仍在。
  await emitAgentEvents(request, token, artifactTurnEvents(sessionId, `e2e-overview-turn-2-${Date.now()}`, {
    id: 'e2e-artifact-beta',
    type: 'mermaid',
    title: '第二版流程图',
    content: 'graph TD;\n  C[第二个产物] --> D[切换器出现];',
    version: 1,
  }));
  const switcher = page.getByTestId('workspace-artifact-switcher');
  await expect(switcher).toBeVisible({ timeout: 20_000 });
  await expect(switcher).toContainText('共 2 个');

  await page.getByRole('button', { name: '返回概览', exact: true }).click();
  await expect(page.getByTestId('task-workspace-overview')).toBeVisible();

  await overview.screenshot({ path: 'tests/e2e/screenshots/workbench-overview-with-artifacts.png' });
});
