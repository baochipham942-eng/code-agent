import { test, expect, type APIRequestContext, type Page } from './fixtures/axeTest';
import fs from 'node:fs';
import path from 'node:path';
import type { Message } from '../../src/shared/contract';

const OUT = process.env.CHAT_RETURN_REPRO_OUT || path.resolve('test-results/chat-return-blank-log');

test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });
test.setTimeout(180_000);

async function dismissOverlays(page: Page): Promise<void> {
  for (const name of ['信任并加载', '跳过，稍后在设置里配置', '返回应用']) {
    const button = page.getByRole('button', { name });
    await button.first().waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
    if (await button.first().isVisible().catch(() => false)) {
      await button.first().click();
      await expect(button.first()).toBeHidden({ timeout: 10_000 });
    }
  }
}

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOverlays(page);
  await expect(page.getByTestId('sidebar-capability-zone')).toBeVisible({ timeout: 15_000 });
}

async function token(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __CODE_AGENT_TOKEN__: string }).__CODE_AGENT_TOKEN__);
}

async function createSession(request: APIRequestContext, auth: string, title: string): Promise<string> {
  const response = await request.post('/api/sessions', {
    data: { title }, headers: { Authorization: `Bearer ${auth}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data.id as string;
}

function messages(prefix: string, long: boolean): Message[] {
  const now = Date.now();
  const result: Message[] = [];
  for (let index = 0; index < 3; index += 1) {
    result.push(
      { id: `${prefix}-u${index}`, role: 'user', content: `第 ${index + 1} 轮问题 ${prefix}`, timestamp: now + index * 3 },
      {
        id: `${prefix}-a${index}`, role: 'assistant',
        content: long
          ? `第 ${index + 1} 轮长回复 ${prefix}\n\n${'持久化长消息用于撑出多屏并验证返回会话时的滚动位置。'.repeat(180)}\n\n末尾 ${prefix}-${index}`
          : `第 ${index + 1} 轮短回复 ${prefix}`,
        timestamp: now + index * 3 + 1,
      },
    );
  }
  return result;
}

async function seed(request: APIRequestContext, auth: string, sessionId: string, seeded: Message[]): Promise<void> {
  const response = await request.post('/api/dev/seed-messages', {
    data: { sessionId, messages: seeded }, headers: { Authorization: `Bearer ${auth}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function open(page: Page, sessionId: string): Promise<void> {
  const item = page.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 15_000 });
}

async function measure(page: Page, label: string) {
  await page.waitForTimeout(1_500);
  const log = page.locator('[role="log"]');
  const scroller = page.locator('.chat-scroll-fade');
  const lastTurn = log.locator('[data-trace-turn-id]').last();
  const [scrollerBox, lastTurnBox] = await Promise.all([
    scroller.boundingBox().catch(() => null),
    lastTurn.boundingBox().catch(() => null),
  ]);
  const result = {
    label,
    turnNodes: await log.locator('[data-trace-turn-id]').count(),
    logCount: await log.count(),
    buttonVisible: await page.getByRole('button', { name: /回到底部|Jump to bottom/ }).isVisible().catch(() => false),
    firstTurnId: await log.locator('[data-trace-turn-id]').first().getAttribute('data-trace-turn-id').catch(() => null),
    lastTurnId: await lastTurn.getAttribute('data-trace-turn-id').catch(() => null),
    scroll: await scroller.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      bottomGap: element.scrollHeight - element.scrollTop - element.clientHeight,
    })).catch(() => null),
    scrollerBox,
    lastTurnBox,
    lastTurnInViewport: Boolean(
      scrollerBox && lastTurnBox
      && lastTurnBox.y + lastTurnBox.height > scrollerBox.y
      && lastTurnBox.y < scrollerBox.y + scrollerBox.height,
    ),
    screenshot: path.join(OUT, `${label}.png`),
  };
  await page.screenshot({ path: result.screenshot });
  console.log(`REPRO ${JSON.stringify(result)}`);
  expect(result.turnNodes, `${label}: log must not be blank`).toBeGreaterThan(0);
  expect(result.lastTurnInViewport, `${label}: last turn must intersect the viewport`).toBe(true);
  expect(result.buttonVisible, `${label}: bottom button must be hidden`).toBe(false);
  return result;
}

async function runRealTurn(page: Page, request: APIRequestContext, auth: string, sessionId: string, prompt: string, turnCount: number): Promise<void> {
  const readPersisted = async (): Promise<Message[]> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await request.get(`/api/sessions/${sessionId}/messages`, {
          headers: { Authorization: `Bearer ${auth}` },
        });
        if (response.ok()) return (await response.json()).data as Message[];
        lastError = new Error(`messages HTTP ${response.status()}`);
      } catch (error) {
        lastError = error;
      }
      await page.waitForTimeout(500);
    }
    throw lastError;
  };
  const composer = page.locator('[data-chat-input]');
  await composer.fill(prompt);
  await composer.press('Enter');
  await expect.poll(async () => {
    const persisted = await readPersisted();
    return {
      messages: persisted.filter((message) => message.role === 'user' || message.role === 'assistant').length,
      tail: persisted.at(-1)?.content ?? '',
    };
  }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toEqual({
    messages: turnCount * 2,
    tail: expect.any(String),
  });
  const tail = (await readPersisted()).at(-1);
  expect(tail?.role).toBe('assistant');
  expect(tail?.content.length).toBeGreaterThan(0);
  console.log(`REAL_TURN session=${sessionId} turn=${turnCount} chars=${tail?.content.length}`);
}

test('return from Automation blank log reproduction with persisted messages', async ({ page, request }) => {
  test.setTimeout(process.env.CHAT_RETURN_REAL_TURNS === '1' ? 900_000 : 180_000);
  fs.mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  const auth = await token(page);
  const reuse = process.env.CHAT_RETURN_REUSE_SESSIONS === '1';
  const longId = reuse
    ? process.env.CHAT_RETURN_LONG_ID!
    : await createSession(request, auth, 'N-CHAT long persisted');
  const shortId = reuse
    ? process.env.CHAT_RETURN_SHORT_ID!
    : await createSession(request, auth, 'N-CHAT short persisted');
  if (process.env.CHAT_RETURN_REAL_TURNS === '1') {
    await ready(page);
    await open(page, longId);
    await runRealTurn(page, request, auth, longId, '请直接输出 50 个编号段落，每段至少 45 个汉字，解释为什么返回历史会话时应展示最后一轮。不要使用工具，不要省略段落，结尾写 LONG_REPLY_END。', 1);
    await runRealTurn(page, request, auth, longId, '请用一句简短中文回答：历史会话返回时应该显示哪里？不要使用工具。', 2);
    await runRealTurn(page, request, auth, longId, '请只回复 FINAL_TURN_VISIBLE，不要使用工具。', 3);
    await open(page, shortId);
    await runRealTurn(page, request, auth, shortId, '请只回复 SHORT_SESSION_OK，不要使用工具。', 1);
  } else if (!reuse) {
    await seed(request, auth, longId, messages('long', true));
    await seed(request, auth, shortId, messages('short', false));
    await ready(page);
  }
  await open(page, longId);
  await measure(page, 'initial-long');

  await open(page, shortId);
  const shortResult = await measure(page, 'short-initial');
  expect(shortResult.scroll?.scrollTop).toBe(0);
  const results = [];
  const automationLoops = Number(process.env.CHAT_RETURN_AUTOMATION_LOOPS ?? 5);
  for (let iteration = 1; iteration <= automationLoops; iteration += 1) {
    await page.getByTestId('sidebar-capability-automation').click();
    await expect(page.getByTestId('cron-center-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[role="log"]')).toHaveCount(0);
    await open(page, longId);
    results.push(await measure(page, `automation-long-${iteration}`));
    await page.getByTestId('sidebar-capability-automation').click();
    await expect(page.getByTestId('cron-center-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[role="log"]')).toHaveCount(0);
    await open(page, shortId);
    const automationShortResult = await measure(page, `automation-short-${iteration}`);
    expect(automationShortResult.scroll?.scrollTop).toBe(0);
    results.push(automationShortResult);
  }

  const switchLoops = Number(process.env.CHAT_RETURN_SWITCH_LOOPS ?? 1);
  for (let iteration = 1; iteration <= switchLoops; iteration += 1) {
    await open(page, longId);
    await open(page, shortId);
    await open(page, longId);
    results.push(await measure(page, `switch-other-back-long-${iteration}`));
  }

  await page.getByRole('button', { name: '用户菜单' }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.locator('[data-chat-input]')).toHaveCount(0);
  await page.getByRole('button', { name: '返回应用' }).click();
  await open(page, longId);
  results.push(await measure(page, 'settings-back-long'));

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ longId, shortId, results, shortResult }, null, 2));
});
