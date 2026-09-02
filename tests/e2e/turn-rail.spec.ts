// ============================================================================
// 轮次导航（N-TURNRAIL）全链路：真会话 + 真 AgentLoop 跑满 10 轮（HTTP /api/run，E2E 本地假模型，
// 零付费；每轮真调一次 Read 工具再给结论）→ 打开会话 → 右缘出现导航条 → 点第 2 格 →
// 聊天滚到第 2 轮且导航高亮落到它。历史整段加载，跳转不需要分页。
// 跑法：CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1（本地模型只对带 E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE
// 标记的消息回话）。走 HTTP 而不走输入框，是因为 e2e 数据目录没有配模型 key，输入框首发会被
// 引到「通用模型」设置页；HTTP 路径在 modelRouter 层被本地模型截住，不需要 key。
// ============================================================================
import { test, expect, type APIRequestContext, type Page } from './fixtures/axeTest';

const TURNS = 10;
const FIXTURE_MARKER = 'E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE';

test.setTimeout(240_000);
test.skip(process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL !== '1', '需要 CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1（本地假模型跑真轮次，不进默认 e2e 批）');

// 首启/每次 reload 都会重弹的遮罩（信任文件夹 → 连接模型 onboarding → 跳过后落在设置页 → 返回应用），
// 出现才点；本机 web 版还可能先弹「注册」（有「关闭」）。与 chat-short-content-top-align.spec.ts 同一套。
async function dismissOverlays(page: Page): Promise<void> {
  for (const name of ['关闭', '信任并加载', '跳过，稍后在设置里配置']) {
    const btn = page.getByRole('dialog').getByRole('button', { name }).first();
    await btn.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
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

async function createSessionViaApi(request: APIRequestContext, token: string, title: string): Promise<string> {
  const response = await request.post('/api/sessions', {
    data: { title },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok(), `create session failed: ${response.status()} ${await response.text()}`).toBe(true);
  const body = await response.json();
  expect(body.data?.id).toBeTruthy();
  return body.data.id as string;
}

async function countAssistantMessages(request: APIRequestContext, token: string, sessionId: string): Promise<number> {
  const response = await request.get(`/api/sessions/${sessionId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) return -1;
  const body = await response.json();
  const messages = (body.data?.messages ?? body.data ?? body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  return messages.filter((message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.includes('smoke completed')).length;
}

/** 一轮 = 用户一句 → 本地模型真调 Read → 结论文本（含 smoke completed）；等结论落库再发下一句。 */
async function runTurn(request: APIRequestContext, token: string, sessionId: string, n: number): Promise<void> {
  const response = await request.post('/api/run', {
    data: { sessionId, prompt: `第 ${n} 件事：把第 ${n} 页的标题改一下 ${FIXTURE_MARKER}` },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 60_000,
  });
  expect(response.ok(), `run ${n} failed: ${response.status()} ${(await response.text()).slice(0, 300)}`).toBe(true);
  await expect.poll(() => countAssistantMessages(request, token, sessionId), { timeout: 45_000, intervals: [500, 1000] }).toBeGreaterThanOrEqual(n);
}

async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.reload();
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOverlays(page);
  const item = page.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
}

test('长会话右缘出现轮次导航，点第 2 格聊天滚到第 2 轮且高亮同步', async ({ page, request }) => {
  await waitForAppReady(page);
  const token = await getAuthToken(page);
  const sessionId = await createSessionViaApi(request, token, '轮次导航 e2e');

  for (let n = 1; n <= TURNS; n += 1) {
    await runTurn(request, token, sessionId, n);
  }

  await openSession(page, sessionId);
  await expect(page.locator('[data-trace-turn-id]').first()).toBeVisible({ timeout: 15_000 });

  const rail = page.getByTestId('turn-rail-ticks');
  await expect(rail).toBeVisible({ timeout: 10_000 });
  const ticks = rail.getByRole('button', { name: /^(回到第 \d+ 轮|Back to turn \d+)$/ });
  await expect(ticks).toHaveCount(TURNS);

  // 进入落底：当前轮 = 最后一轮；点第 2 格
  await ticks.nth(1).click();

  const target = page.locator('[data-trace-turn-id]').nth(1);
  await expect(target).toBeVisible({ timeout: 5_000 });
  const inView = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.top < window.innerHeight * 0.5;
  });
  expect(inView, 'second turn should be aligned near the top of the viewport').toBe(true);
  await expect(ticks.nth(1)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });
});
