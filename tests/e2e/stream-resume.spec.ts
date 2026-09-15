// ============================================================================
// E2E: ADR-068 刀 4 断流续接 UI 信号 —— 真输入框起轮 + 刀 3 留的断流注入
// （E2E_STREAM_BREAK_RETRY：先流 PART1 再抛 loop 层认得的 socket hang up，network retry
// 兜住后续流 PART2）。验证链路：信号出现（同一 streaming 消息内嵌「连接中断，正在续接 n/N」）
// → B2 分段续接（断点段定格 + 续答段带一次性续接说明，不拼缝）→ 信号消除；重载后裸协议
// 标记不上屏、断点段/续答段两段正文都在、一次性说明不复现。
//
// 跑法：CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1（本地假模型跑真轮次，不进默认 e2e 批）。
// 走输入框而非裸 POST /api/run：直连轮的事件只在 /api/run 自己的响应流上，页面从那条流
// 消费（mirrorToBroadcast=false）；裸 POST 的事件不会进页面的全局 SSE（实测踩坑）。
// 模型未配的发送门用 settings/get 路由拦截过掉（first-turn-feedback.spec.ts 同款）。
// 注意：断流注入计数是 webServer 进程内一剂（CODE_AGENT_E2E_STREAM_BREAK_FAILURES 默认 1），
// 本 spec 全程只发一次带 marker 的消息；重跑要重启 webServer。
// ============================================================================
import { test, expect, type APIRequestContext, type Page } from './fixtures/axeTest';

test.setTimeout(120_000);
test.skip(process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL !== '1', '需要 CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1（本地假模型跑真轮次，不进默认 e2e 批）');

// 首启/ reload 遮罩（与 turn-rail.spec.ts 同一套）
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
  const ssePromise = page.waitForResponse(
    (response) => response.url().includes('/api/events'),
    { timeout: 20_000 },
  );
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;
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

async function openSession(page: Page, sessionId: string): Promise<void> {
  const item = page.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  // 🔴 必须等到会话真正成为 current（aria-current）：[data-chat-input] 在空态欢迎页
  // 也有，等它会在会话尚未挂载时就放行——随后发送的事件按「非当前会话」整批掉。
  await expect(item).toHaveAttribute('aria-current', 'true', { timeout: 10_000 });
}

/** DB 里带 marker 的 assistant 消息数（PART1 partial 与续答终稿各一条，轮收尾的判据）。 */
async function countStreamBreakAssistantMessages(
  request: APIRequestContext,
  token: string,
  sessionId: string,
): Promise<number> {
  const response = await request.get(`/api/sessions/${sessionId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) return -1;
  const body = await response.json();
  const messages = (body.data?.messages ?? body.data ?? body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  return messages.filter((message) => (
    message.role === 'assistant'
    && typeof message.content === 'string'
    && (message.content.includes('E2E_STREAM_BREAK_PART1') || message.content.includes('E2E_STREAM_BREAK_PART2'))
  )).length;
}

test('断流续接：信号出现 → B2 分段续接（断点段定格+续答段说明）→ 信号消除；重载裸标记不上屏', async ({ page, request }) => {
  await waitForAppReady(page);
  const token = await getAuthToken(page);
  const sessionId = await createSessionViaApi(request, token, '断流续接信号 e2e');
  await openSession(page, sessionId);

  // 模型未配的发送门：settings/get 拦截成已配（first-turn-feedback 同款）；实际推理被
  // E2E 本地假模型截住，不打真实 provider。
  await page.route('**/api/domain/settings/get', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          models: {
            default: 'openai',
            providers: {
              openai: { enabled: true, apiKey: 'e2e-placeholder', model: 'gpt-4o' },
            },
          },
        },
      }),
    });
  });

  const composer = page.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.fill('请分两段回答这件事：E2E_STREAM_BREAK_RETRY');
  await composer.press('Enter');

  // ① 信号出现：同一 streaming 消息内嵌状态行（n/N = loop 层预算 1/1），PART1 已可见
  const statusLine = page.getByTestId('stream-resume-status');
  await expect(statusLine).toBeVisible({ timeout: 20_000 });
  await expect(statusLine).toContainText('1/1');
  await expect(page.getByText('E2E_STREAM_BREAK_PART1')).toBeVisible({ timeout: 20_000 });
  // 证据快照（拷入证据档；test-results 不进 git）
  await page.screenshot({ path: 'test-results/stream-resume-evidence/01-signal.png', fullPage: false });

  // ② B2 分段续接：断点段定格为独立消息，续答段起头带一次性续接说明，PART2 落到新段。
  // 一次性说明是流中瞬态（轮收尾的 DB 消息刷新后由落库标记形态接管，重载不复现），
  // 假模型瞬发时它只存活几帧——toBeVisible 的轮询可能错过，用 MutationObserver 在页面
  // 内盯它出现（曾出现记 flag）；正文块断言等 PART1/PART2 两个段落都齐再抓现场——
  // smooth streaming 逐字揭示，note 先于完整 marker 渲染。两段必须是互不包含的两个
  // 正文块（续答不 append 进断点段冒充单次生成，D2）。
  const liveSplit = await page.evaluate(() => new Promise<{
    noteAppeared: boolean;
    part1Text: string | null;
    part2Text: string | null;
    separateNodes: boolean;
  }>((resolve) => {
    const NOTE = '[data-testid="stream-resume-note"]';
    let noteSeen = false;
    const snapshot = () => {
      if (document.querySelector(NOTE)) noteSeen = true;
      const blocks = [...document.querySelectorAll('p')];
      const part1 = blocks.find((b) => b.textContent?.includes('E2E_STREAM_BREAK_PART1')) ?? null;
      const part2 = blocks.find((b) => b.textContent?.includes('E2E_STREAM_BREAK_PART2')) ?? null;
      if (!part1 || !part2) return null;
      return {
        noteAppeared: noteSeen,
        part1Text: part1.textContent ?? null,
        part2Text: part2.textContent ?? null,
        separateNodes: Boolean(
          part1 !== part2
          && !part1.textContent!.includes('E2E_STREAM_BREAK_PART2')
          && !part2.textContent!.includes('E2E_STREAM_BREAK_PART1'),
        ),
      };
    };
    const found = snapshot();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const hit = snapshot();
      if (hit) { observer.disconnect(); resolve(hit); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // 兜底超时（spec 自身 120s）：没出现过就让下方断言红出可读信息
    setTimeout(() => { observer.disconnect(); resolve({ noteAppeared: noteSeen, part1Text: null, part2Text: null, separateNodes: false }); }, 60_000);
  }));
  expect(liveSplit.noteAppeared, '续答段的一次性续接说明应在流中出现').toBe(true);
  expect(liveSplit.part2Text, '续答正文应已流入续答段').toContain('E2E_STREAM_BREAK_PART2');
  expect(liveSplit.separateNodes, '断点段与续答段应是互不包含的两个正文块（不拼缝）').toBe(true);
  await expect(page.getByText('E2E_STREAM_BREAK_PART2')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: 'test-results/stream-resume-evidence/02-live-split.png', fullPage: false });
  // 两段正文同屏共存各一份，重发内容不 append 进断点段冒充单次生成（D2）
  await expect(page.getByText('E2E_STREAM_BREAK_PART1')).toHaveCount(1);
  await expect(page.getByText('E2E_STREAM_BREAK_PART2')).toHaveCount(1);

  // ③ 信号消除：轮次收尾（DB 两条 assistant：断点 partial + 续答终稿）后状态行更不许残留
  await expect
    .poll(() => countStreamBreakAssistantMessages(request, token, sessionId), { timeout: 45_000, intervals: [500, 1000] })
    .toBeGreaterThanOrEqual(2);
  await expect(statusLine).toHaveCount(0, { timeout: 10_000 });
  await page.screenshot({ path: 'test-results/stream-resume-evidence/03-final.png', fullPage: false });

  // ④ 重载视图：一次性说明不复现；裸协议标记不上屏（词表消费），断点段带样式行，两段正文都在
  await page.reload();
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOverlays(page);
  await openSession(page, sessionId);
  await expect(page.getByText('E2E_STREAM_BREAK_PART2')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('stream-resume-note')).toHaveCount(0);
  await expect(page.getByTestId('stream-break-kept-segment')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('[连接中断 — 部分回答已保留]')).toHaveCount(0);
  await expect(page.getByText('E2E_STREAM_BREAK_PART1')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: 'test-results/stream-resume-evidence/04-reload.png', fullPage: false });
});
