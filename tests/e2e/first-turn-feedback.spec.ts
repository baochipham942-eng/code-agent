import path from 'node:path';
import { expect, test, type Route } from './fixtures/axeTest';
import { dismissFirstRunDialogs } from './firstRunDialogs';

test('排队发送只按真实事件推进发送、启动、等待模型和首 token', async ({ page, request }) => {
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
  await settingsDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await settingsDialog.isVisible().catch(() => false)) {
    await settingsDialog.getByRole('button', { name: '关闭' }).click();
    await expect(settingsDialog).toBeHidden();
  }
  const composer = page.locator('[data-testid="chat-composer-textarea"]');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  let heldRunRoute: Route | null = null;
  let clientMessageId = '';
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
  await page.route('**/api/run', async (route) => {
    const payload = route.request().postDataJSON() as { clientMessageId?: string };
    clientMessageId = payload.clientMessageId ?? '';
    heldRunRoute = route;
  });
  await page.route('**/api/interrupt', async (route) => {
    const payload = route.request().postDataJSON() as { clientMessageId?: string };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          outcome: 'queued',
          queuedInputId: payload.clientMessageId,
          code: 'RUN_SETTLED',
          message: 'queued by e2e route',
        },
      }),
    });
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

  const screenshotDir = process.env.NQL_SCREENSHOT_DIR;
  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, 'N-QUEUEDRAIN-LATENCY-send-200ms.png'),
      fullPage: true,
    });
  }

  expect(heldRunRoute).not.toBeNull();
  await heldRunRoute!.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'SESSION_BUSY', message: 'session is settling' } }),
  });
  await expect(placeholder).toHaveText('已排队，正在启动…');
  await expect(page.locator('[data-testid="assistant-send-placeholder"]')).toHaveCount(1);
  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, 'N-QUEUEDRAIN-LATENCY-queued.png'),
      fullPage: true,
    });
  }

  const token = await page.evaluate(() => (
    window as unknown as { __CODE_AGENT_TOKEN__?: string }
  ).__CODE_AGENT_TOKEN__);
  const sessionId = await page.locator('[data-session-id][aria-current="true"]').first().getAttribute('data-session-id');
  expect(token).toBeTruthy();
  expect(sessionId).toBeTruthy();
  expect(clientMessageId).toBeTruthy();
  const activationResponse = await request.post('/api/dev/emit-queued-input-activated', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      sessionId,
      id: clientMessageId,
      runId: `nql-run-${Date.now()}`,
      activatedAt: Date.now(),
    },
  });
  expect(activationResponse.ok()).toBe(true);
  await expect(placeholder).toHaveText('信号传输中，正在等待模型回响…');
  await expect(page.locator('[data-testid="assistant-send-placeholder"]')).toHaveCount(1);
  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, 'N-QUEUEDRAIN-LATENCY-waiting-model.png'),
      fullPage: true,
    });
  }

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
      path: path.join(screenshotDir, 'N-QUEUEDRAIN-LATENCY-first-token.png'),
      fullPage: true,
    });
  }
});
