import { expect, test, type APIRequestContext, type Page } from './fixtures/axeTest';
import type { AgentEvent } from '../../src/shared/contract';

// N-HTTPREQ-CONNECTOR-CARD-DISCLOSE：http_request 携带已连接连接器令牌的写调用，
// 审批卡必须让用户在放行前看出「Neo 要用我的飞书账号发这条消息」——问句点名连接器
// 与「以你的身份」，卡身出 METHOD/路径 + 可展开的请求内容 + 隐私边界。zh/en 各截一张
// 真实 web 构建截图（非视觉基线比对；无 Dev 槽，走 e2e config 自带 webServer）。
//
// 语言切换走「首载前 PUT /api/settings」而不是加载后 reload：reload 会让 App 重新
// auto-resume 上一会话，与新开会话的 switchSession 相互竞争（实测 stale response
// discarded ×3，事件到了卡不出）。token 由 GET / 的 index.html 注入，无需先开页面。

type RendererAgentEvent = AgentEvent & { sessionId?: string };

const FEISHU_MESSAGE_BODY = '{"receive_id":"oc_x","msg_type":"text","content":"{\\"text\\":\\"明天 10 点开会\\"}"}';

test.setTimeout(90_000);
test.use({ viewport: { width: 1440, height: 900 } });

/** token 随启动文档注入（static.ts），不开页面也能拿到 —— 语言可在首载前写进 settings。 */
async function acquireToken(request: APIRequestContext): Promise<string> {
  const index = await request.get('/');
  expect(index.ok(), `GET / failed: ${index.status()}`).toBe(true);
  const match = /window\.__CODE_AGENT_TOKEN__=("(?:[^"\\]|\\.)*")/.exec(await index.text());
  expect(match, '__CODE_AGENT_TOKEN__ missing from index.html').toBeTruthy();
  return JSON.parse(match![1]) as string;
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

/** 清空会话列表：上一用例留下的会话会触发首载 auto-resume，与新会话 switchSession 竞争。 */
async function clearSessions(request: APIRequestContext, token: string): Promise<void> {
  const list = await request.get('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
  expect(list.ok(), `GET /api/sessions failed: ${list.status()}`).toBe(true);
  const body = (await list.json()) as { data?: Array<{ id?: string }> };
  for (const session of body.data ?? []) {
    if (typeof session.id !== 'string') continue;
    const removed = await request.delete(`/api/sessions/${session.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(removed.ok(), `DELETE /api/sessions/${session.id} failed: ${removed.status()}`).toBe(true);
  }
}

/** 「初始化 Neo」跳过不落盘（firstRunDialogs.ts 头注）；弹窗 title 硬编码 zh，按钮文案随语言。 */
async function dismissOnboarding(page: Page, skipLabel: string): Promise<void> {
  const onboarding = page.getByRole('dialog', { name: '初始化 Neo' });
  await onboarding.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (await onboarding.isVisible().catch(() => false)) {
    await onboarding.getByRole('button', { name: skipLabel }).click();
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
      skipButton: '跳过，稍后在设置里配置',
      question: 'Neo 将以你的飞书身份写入，允许吗？',
      bodyToggle: '请求内容',
      boundary: '数据会离开本机并写入飞书',
    },
    en: {
      skipButton: 'Skip for now, set up later in Settings',
      question: 'Neo will write to 飞书 as you. Allow?',
      bodyToggle: 'Request content',
      boundary: 'Data leaves this device and is written to 飞书',
    },
  }[language];

  test(`连接器令牌写审批卡披露 · ${language}`, async ({ page, request }, testInfo) => {
    const token = await acquireToken(request);
    await switchUiLanguage(request, token, language);
    await clearSessions(request, token);
    await page.goto('/');
    await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
    await dismissOnboarding(page, copy.skipButton);
    const backToApp = page.getByRole('button', { name: '返回应用' });
    await backToApp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await backToApp.isVisible().catch(() => false)) {
      await backToApp.click();
      await expect(backToApp).toBeHidden({ timeout: 10_000 });
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
        // 注意：审批事件的 envelope sessionId 用 'global'（appStore 的全局待审哨兵）——
        // 全局卡不进「pending 会话 ≠ 当前会话」的隐藏门，也不会被 reconcile 在会话切换
        // 竞态里弹回队列（dev 路由要求每事件都带字符串 sessionId，不能省略；turn 事件
        // 仍带真实 sessionId 渲染时间线；data.sessionId 保留供应答路由）。
        type: 'permission_request',
        sessionId: 'global',
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
    // 首载 auto-resume 与新会话的 switchSession 有一次性的 reconcile 抖动（卡可能瞬时空、
    // 随即回来）——断言统一给足重试窗口，穿过抖动期。
    await expect(permissionCard).toBeVisible({ timeout: 15_000 });
    // 放行前用户能看出「以我的飞书身份写入这条消息」：问句 + 方法路径 + 隐私边界。
    await expect(permissionCard).toContainText(copy.question, { timeout: 15_000 });
    await expect(permissionCard).toContainText('POST /open-apis/im/v1/messages', { timeout: 15_000 });
    await expect(permissionCard).toContainText(copy.boundary, { timeout: 15_000 });
    // 展开请求内容：消息正文可见（截图存证，证据落 test-results 产物目录）。
    // 截图前先补一发同 turn keepalive：新会话的 idle session snapshot 迟到会把运行态
    // 撤回 idle、连带清掉待审卡（visual-shotbase.spec.ts 同款防御），断言与截图要挤在
    // keepalive 后的窄窗口里完成。
    await emitAgentEvents(request, token, [
      { type: 'stream_chunk', sessionId, data: { turnId, content: '等待你的确认。' } },
    ]);
    await expect(permissionCard).toBeVisible({ timeout: 5_000 });
    await permissionCard.getByRole('button', { name: copy.bodyToggle }).click();
    await expect(permissionCard.getByTestId('connector-write-body')).toContainText('明天 10 点开会');

    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
    await expect(permissionCard).toBeVisible({ timeout: 5_000 });
    await page.screenshot({
      path: testInfo.outputPath(`connector-write-card-${language}.png`),
      animations: 'disabled',
      fullPage: true,
    });
  });
}
