// ============================================================================
// E2E: B1-R · R4 — 会话内容不满一屏顶对齐；长内容跟随滚底不回归
//
// 覆盖边界（写明而不是假装覆盖）：emit-agent-events 只走 SSE 广播、不落 DB，
// 因此「重新进入已持久化的长会话落底」这条没法用 e2e 构造——它由
// turnBasedTraceView.test.ts 对 initialTopMostItemIndex=LAST/end 的断言覆盖。
// 这里验的是真实 DOM 上的另外两条：短内容顶对齐（本次修的 bug）、
// 长内容流式期间跟随滚底（alignToBottom 移除后 followOutput 路径不回归）。
// ============================================================================

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AgentEvent } from '../../src/shared/contract';

type RendererAgentEvent = AgentEvent & { sessionId?: string };

test.setTimeout(90_000);

// 首启/每次 reload 都会重弹的遮罩（信任文件夹 → 连接模型 onboarding → 跳过后落在设置页），
// 出现才点。onboarding 的完成标记是 renderer 内存 ref，reload 即重置，所以每次进页都要再过一遍。
async function dismissOverlays(page: Page): Promise<void> {
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

async function waitForAppReady(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOverlays(page);
}

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
  );
  expect(token, 'window.__CODE_AGENT_TOKEN__ missing').toBeTruthy();
  return token!;
}

// 「新任务」按钮在新 UI 里是懒建会话（首发消息才落库），拿不到 sessionId；
// 直接走 POST /api/sessions 建真会话，再 reload 让侧栏刷新后点进去。
async function createSessionViaApi(
  request: APIRequestContext,
  token: string,
  title: string,
): Promise<string> {
  const response = await request.post('/api/sessions', {
    data: { title },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok(), `create session failed: ${response.status()} ${await response.text()}`).toBe(true);
  const body = await response.json();
  expect(body.data?.id).toBeTruthy();
  return body.data.id as string;
}

async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.reload();
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOverlays(page);
  const item = page.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator(`[data-session-id="${sessionId}"][aria-current="true"]`).first())
    .toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
}

async function emitAgentEvents(
  request: APIRequestContext,
  token: string,
  events: RendererAgentEvent[],
): Promise<void> {
  const response = await request.post('/api/dev/emit-agent-events', {
    data: { events },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok(), `emit-agent-events failed: ${response.status()} ${await response.text()}`).toBe(true);
}

function turnEvents(sessionId: string, turnId: string, content: string): RendererAgentEvent[] {
  return [
    { type: 'turn_start', sessionId, data: { turnId } },
    { type: 'stream_chunk', sessionId, data: { turnId, content } },
    { type: 'turn_end', sessionId, data: { turnId } },
  ];
}

test('R4: 一条消息的短会话内容顶对齐，不再压到底部', async ({ page, request }, testInfo) => {
  await waitForAppReady(page);
  const token = await getAuthToken(page);
  const sessionId = await createSessionViaApi(request, token, 'R4 短会话');
  await openSession(page, sessionId);

  const marker = `R4_SHORT_${Date.now()}`;
  await emitAgentEvents(request, token, [
    ...turnEvents(sessionId, `r4-short-${Date.now()}`, `短内容 ${marker}`),
    { type: 'agent_complete', sessionId, data: null },
  ]);

  const firstTurn = page.locator('[data-trace-turn-id]').first();
  await expect(firstTurn).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`text=${marker}`).first()).toBeVisible({ timeout: 15_000 });

  const scroller = page.locator('.chat-scroll-fade');
  const scrollerBox = await scroller.boundingBox();
  const turnBox = await firstTurn.boundingBox();
  expect(scrollerBox).toBeTruthy();
  expect(turnBox).toBeTruthy();
  // 顶对齐：第一条内容紧贴滚动容器顶部（pt-3 内边距量级），而非被 marginTop:auto 压到底
  expect(turnBox!.y - scrollerBox!.y).toBeLessThan(120);

  await page.screenshot({ path: testInfo.outputPath('r4-short-content-top-aligned.png') });
});

test('R4: 长内容流式期间跟随滚底，去掉 alignToBottom 不回归', async ({ page, request }, testInfo) => {
  await waitForAppReady(page);
  const token = await getAuthToken(page);
  const sessionId = await createSessionViaApi(request, token, 'R4 长会话');
  await openSession(page, sessionId);

  const bottomMarker = `R4_BOTTOM_${Date.now()}`;
  // 单个长 turn：连发多个 turn 会被流式链路坍缩成最后一轮（两轮真机截图实证，
  // 整批/逐轮 POST 都一样），但 R4 验的是「内容溢出视口后跟随滚底」这一布局行为，
  // 一轮超长内容走同一条 Virtuoso overflow + followOutput 路径，足够。
  const longContent = `${'长会话填充内容，撑出一屏又一屏。'.repeat(400)}\n\n末尾标记 ${bottomMarker}`;
  await emitAgentEvents(request, token, [
    ...turnEvents(sessionId, `r4-long-${Date.now()}`, longContent),
    { type: 'agent_complete', sessionId, data: null },
  ]);

  await expect(page.locator(`text=${bottomMarker}`).first()).toBeVisible({ timeout: 20_000 });

  const scroller = page.locator('.chat-scroll-fade');
  // 非空转断言：内容必须真的撑出视口（否则「在底部」恒真，整条用例空转）
  await expect.poll(async () => scroller.evaluate(
    (el) => el.scrollHeight / el.clientHeight,
  ), { timeout: 10_000 }).toBeGreaterThan(1.5);
  await expect.poll(async () => scroller.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
  ), { timeout: 10_000 }).toBeLessThan(100);
  // 已在底部时不应出现「回到底部」悬浮钮
  await expect(page.getByRole('button', { name: /回到底部|Jump to bottom/ })).toHaveCount(0);

  await page.screenshot({ path: testInfo.outputPath('r4-long-session-scrolled-to-bottom.png') });
});
