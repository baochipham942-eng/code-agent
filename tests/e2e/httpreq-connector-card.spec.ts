import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AgentEvent } from '../../src/shared/contract';
import { dismissFirstRunDialogs } from './firstRunDialogs';

// N-HTTPREQ-CONNECTOR-CARD-DISCLOSE：http_request 携带已连接连接器令牌的写调用，
// 审批卡必须让用户在放行前看出「Neo 要用我的飞书账号发这条消息」——问句点名连接器
// 与「以你的身份」，卡身出 METHOD/路径 + 可展开的请求内容 + 隐私边界。zh/en 各截一张
// 真实 web 构建截图（非视觉基线比对；无 Dev 槽，走 e2e config 自带 webServer）。

type RendererAgentEvent = AgentEvent & { sessionId?: string };

const FEISHU_MESSAGE_BODY = '{"receive_id":"oc_x","msg_type":"text","content":"{\\"text\\":\\"明天 10 点开会\\"}"}';

test.setTimeout(90_000);
test.use({ viewport: { width: 1440, height: 900 } });

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
  );
  expect(token, 'window.__CODE_AGENT_TOKEN__ missing').toBeTruthy();
  return token!;
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
  expect(
    response.ok(),
    `emit-agent-events failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);
}

async function switchUiLanguage(
  request: APIRequestContext,
  token: string,
  language: 'zh' | 'en',
): Promise<void> {
  const current = await request.get('/api/settings', { headers: { Authorization: `Bearer ${token}` } });
  expect(current.ok(), `GET /api/settings failed: ${current.status()}`).toBe(true);
  const settings = (await current.json()) as { ui?: Record<string, unknown> };
  const updated = await request.put('/api/settings', {
    data: { ...settings, ui: { ...(settings.ui ?? {}), language } },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(updated.ok(), `PUT /api/settings failed: ${updated.status()} ${await updated.text()}`).toBe(true);
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissFirstRunDialogs(page);
  const backToApp = page.getByRole('button', { name: '返回应用' });
  await backToApp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await backToApp.isVisible().catch(() => false)) {
    await backToApp.click();
    await expect(backToApp).toBeHidden({ timeout: 10_000 });
  }
}

async function createCleanSession(page: Page): Promise<string> {
  const newTask = page.getByTestId('sidebar-new-task');
  await expect(newTask).toBeVisible({ timeout: 15_000 });
  await newTask.click();
  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  await expect(activeSession).toBeVisible({ timeout: 15_000 });
  const sessionId = await activeSession.getAttribute('data-session-id');
  expect(sessionId, 'active session id missing').toBeTruthy();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
  return sessionId!;
}

for (const language of ['zh', 'en'] as const) {
  const copy = {
    zh: {
      question: 'Neo 将以你的飞书身份写入，允许吗？',
      bodyToggle: '请求内容',
      boundary: '数据会离开本机并写入飞书',
    },
    en: {
      question: 'Neo will write to 飞书 as you. Allow?',
      bodyToggle: 'Request content',
      boundary: 'Data leaves this device and is written to 飞书',
    },
  }[language];

  test(`连接器令牌写审批卡披露 · ${language}`, async ({ page, request }, testInfo) => {
    await openApp(page);
    const token = await getAuthToken(page);
    if (language === 'en') {
      await switchUiLanguage(request, token, 'en');
      await page.reload();
      await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
    }
    const sessionId = await createCleanSession(page);
    const turnId = `httpreq-connector-${language}-${Date.now()}`;
    const requestId = `httpreq-connector-card-${language}-${Date.now()}`;

    await emitAgentEvents(request, token, [
      { type: 'turn_start', sessionId, data: { turnId } },
      {
        type: 'stream_chunk',
        sessionId,
        data: { turnId, content: '正在准备向项目群发送会议通知。' },
      },
      {
        type: 'permission_request',
        sessionId,
        data: {
          id: requestId,
          sessionId,
          forceConfirm: true,
          type: 'network',
          tool: 'http_request',
          details: {
            url: 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
            method: 'POST',
            body: FEISHU_MESSAGE_BODY,
            connectorTokenAttached: true,
          },
          reason: '要向 飞书 发起写入请求，你的授权将附加到本次请求上，需要你确认',
          timestamp: Date.now(),
          boundary: {
            id: 'connector.external_write',
            reason: '要向 飞书 发起写入请求，你的授权将附加到本次请求上，需要你确认',
            reasonEn: 'A write request to 飞书 will attach your authorization to this request; confirmation required',
            connectorName: '飞书',
            connectorNameEn: '飞书',
          },
        },
      },
    ]);

    const permissionCard = page.getByTestId('permission-card');
    await expect(permissionCard).toBeVisible({ timeout: 15_000 });
    // 放行前用户能看出「以我的飞书身份写入这条消息」：问句 + 方法路径 + 隐私边界。
    await expect(permissionCard).toContainText(copy.question);
    await expect(permissionCard).toContainText('POST /open-apis/im/v1/messages');
    await expect(permissionCard).toContainText(copy.boundary);
    // 展开请求内容：消息正文可见（截图存证，证据落 test-results 产物目录）。
    await permissionCard.getByRole('button', { name: copy.bodyToggle }).click();
    await expect(permissionCard.getByTestId('connector-write-body')).toContainText('明天 10 点开会');

    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.screenshot({
      path: testInfo.outputPath(`connector-write-card-${language}.png`),
      animations: 'disabled',
      fullPage: true,
    });
  });
}
