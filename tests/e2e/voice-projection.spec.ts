// ============================================================================
// E2E: 语音消息投影合流（方案 §7.5，防重影）
//
// #706/#713 教训：组件单测 mock 掉 model 层后，同一份产物投影两遍也看不见。
// 本套件在真浏览器里走完整链路：
//   dev seed（真实 sessionManager.addMessageToSession 落库）
//   → 页面重载 → 真实 GET /api/sessions/:id → sessionStore
//   → 真 projectTurns → DOM
// 断言：摘要卡恰好一张、字幕气泡各一条、语音来源标恰好两个、无重影。
//
// 截图落 tests/e2e/screenshots/（gitignore 目录，测试产物不进仓）。
// ============================================================================

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QWEN_OMNI_REALTIME_MODEL } from '../../src/shared/constants/voice';

test.setTimeout(60_000);

// e2e 截图是测试产物不是代码：落仓库 gitignore 的 .screenshots/，禁止进仓（批 A 教训）。
const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(SPEC_DIR, '..', '..', '.screenshots', 'e2e');

async function waitForAppReady(page: Page): Promise<void> {
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;
}

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
  );
  expect(token, 'window.__CODE_AGENT_TOKEN__ missing — static.ts token injection broke').toBeTruthy();
  return token!;
}

async function ensureActiveSession(page: Page): Promise<string> {
  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  if (!(await activeSession.isVisible())) {
    const newSessionBtn = page.getByRole('button', { name: '新会话' });
    await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
    await newSessionBtn.click();
  }
  await expect(activeSession).toBeVisible({ timeout: 10_000 });
  const sessionId = await activeSession.getAttribute('data-session-id');
  expect(sessionId, 'active session id missing').toBeTruthy();
  return sessionId!;
}

/** 与 host voiceSessionService 落库形状逐字段对齐（字幕 / 摘要）。 */
function voiceMessages() {
  const startedAt = Date.now() - 75_000;
  return [
    {
      id: `voice-user-${startedAt}`,
      role: 'user',
      content: '帮我看下登录页的文案',
      timestamp: startedAt + 5_000,
      metadata: { source: 'voice' },
    },
    {
      id: `voice-assistant-${startedAt}`,
      role: 'assistant',
      content: '好的，我先看一下登录页。',
      timestamp: startedAt + 20_000,
      metadata: { source: 'voice' },
    },
    {
      id: `voice-summary-${startedAt}`,
      role: 'system',
      content: '语音通话结束，时长 1 分 15 秒',
      timestamp: startedAt + 75_000,
      metadata: {
        source: 'voice',
        voiceCallSummary: {
          durationSec: 75,
          provider: 'qwen-omni',
          conversationModel: QWEN_OMNI_REALTIME_MODEL,
          workItemCount: 1,
          startedAt,
          endedAt: startedAt + 75_000,
        },
      },
    },
  ];
}

test('语音字幕与摘要经真实 model 层投影：恰好各一份，无重影', async ({ page, request, baseURL }) => {
  await waitForAppReady(page);
  const sessionId = await ensureActiveSession(page);
  const token = await getAuthToken(page);

  const seed = await request.post(`${baseURL}/api/dev/seed-messages?token=${encodeURIComponent(token)}`, {
    data: { sessionId, messages: voiceMessages() },
  });
  expect(seed.status(), await seed.text()).toBe(200);

  // 重新加载让消息经真实「load → sessionStore → projectTurns」路径进流
  await waitForAppReady(page);
  const row = page.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });

  // 摘要卡恰好一张（单一生产者；#706/#713 防重影门）
  const summaryCard = page.locator('[data-testid="voice-call-summary-card"]');
  await expect(summaryCard).toHaveCount(1, { timeout: 10_000 });
  await expect(summaryCard).toContainText('qwen3.5-omni-flash-realtime');

  // 字幕气泡各一条 + 语音来源标恰好两个
  await expect(page.getByText('帮我看下登录页的文案')).toHaveCount(1);
  await expect(page.getByText('好的，我先看一下登录页。')).toHaveCount(1);
  await expect(page.locator('[data-testid="voice-source-badge"]')).toHaveCount(2);

  // 默认配置下 Live 入口不可见（总开关关；§9.3）
  await expect(page.locator('[data-testid="live-voice-button"]')).toHaveCount(0);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'voice-projection.png'), fullPage: false });
});
