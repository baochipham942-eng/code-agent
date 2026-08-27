import path from 'node:path';
import { expect, test } from '@playwright/test';
import { dismissFirstRunDialogs } from './firstRunDialogs';

test('发送后 200ms 内出现助手侧本地反馈，不等待 SSE', async ({ page, request }) => {
  const sseReady = page.waitForResponse(
    (response) => response.url().includes('/api/events'),
    { timeout: 20_000 },
  );
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await sseReady;
  await dismissFirstRunDialogs(page);
  const settingsDialog = page.getByRole('dialog', { name: '设置' });
  await settingsDialog.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
  if (await settingsDialog.isVisible().catch(() => false)) {
    await settingsDialog.getByRole('button', { name: '关闭' }).click();
    await expect(settingsDialog).toBeHidden();
  }

  await page.getByRole('button', { name: '新建快速对话' }).click();
  const composer = page.locator('[data-testid="chat-composer-textarea"]');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => {
    const api = window.codeAgentDomainAPI;
    if (!api) throw new Error('domain API unavailable');
    const originalInvoke = api.invoke.bind(api);
    api.invoke = ((domain: string, action: string, payload?: unknown) => {
      if (domain === 'domain:settings' && action === 'get') {
        return new Promise(() => {});
      }
      return originalInvoke(domain, action, payload);
    }) as typeof api.invoke;
  });
  await composer.fill('验证发送后的第一帧反馈');

  const startedAt = await page.evaluate(() => performance.now());
  await composer.press('Enter');
  const placeholder = page.locator('[data-testid="assistant-send-placeholder"]');
  await expect(placeholder).toBeVisible({ timeout: 200 });
  await expect(placeholder).toHaveText('正在发送消息…');
  const elapsed = await page.evaluate((start) => performance.now() - start, startedAt);

  expect(elapsed).toBeLessThanOrEqual(200);
  await expect(page.locator('[data-testid="assistant-send-placeholder"]')).toHaveCount(1);

  const screenshotDir = process.env.NFF_SCREENSHOT_DIR;
  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, 'N-FIRSTTURN-FEEDBACK-send-200ms.png'),
      fullPage: true,
    });
  }

  const token = await page.evaluate(() => (
    window as unknown as { __CODE_AGENT_TOKEN__?: string }
  ).__CODE_AGENT_TOKEN__);
  const sessionId = await page.locator('[data-session-id][aria-current="true"]').first().getAttribute('data-session-id');
  expect(token).toBeTruthy();
  expect(sessionId).toBeTruthy();
  const turnId = `nff-first-token-${Date.now()}`;
  const firstToken = `首 token ${Date.now()}`;
  const response = await request.post('/api/dev/emit-agent-events', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      events: [
        { type: 'turn_start', sessionId, data: { turnId } },
        {
          type: 'message_delta',
          sessionId,
          data: {
            role: 'assistant',
            path: 'content',
            op: 'append',
            text: firstToken,
            turnId,
            messageId: turnId,
          },
        },
      ],
    },
  });
  expect(response.ok()).toBe(true);
  await expect(page.getByText(firstToken)).toBeVisible({ timeout: 10_000 });
  await expect(placeholder).toHaveCount(0);
  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, 'N-FIRSTTURN-FEEDBACK-first-token.png'),
      fullPage: true,
    });
  }
});
