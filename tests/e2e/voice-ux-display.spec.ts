// ============================================================================
// N-L7-VOICEUX — Web Server 展示层验收
//
// 用隔离数据目录 + dev seed 验证真实 load → projection → DOM 链路。
// 拨号阶段由运行命令注入无效临时 Key，不读写系统 Key，不会产生成功语音/TTS 计费。
// ============================================================================

import { test, expect, type Page } from './fixtures/axeTest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test.setTimeout(90_000);

const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(SPEC_DIR, '..', '..', '.screenshots', 'e2e');

async function waitForAppReady(page: Page): Promise<void> {
  const ssePromise = page.waitForResponse((response) => response.url().includes('/api/events'), { timeout: 20_000 });
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;
}

async function dismissFirstRunDialogs(page: Page): Promise<void> {
  const trustDialog = page.getByRole('dialog', { name: '信任这个项目文件夹？' });
  await trustDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await trustDialog.isVisible().catch(() => false)) {
    await trustDialog.getByRole('button', { name: '阻止项目配置' }).click();
  }
  const onboarding = page.getByRole('dialog', { name: '初始化 Neo' });
  await onboarding.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await onboarding.isVisible().catch(() => false)) {
    await onboarding.getByRole('button', { name: '跳过，稍后在设置里配置' }).click();
  }
}

async function authToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => (
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined
  ));
  expect(token).toBeTruthy();
  return token!;
}

async function openSettings(page: Page) {
  const dialog = page.getByTestId('settings-panel');
  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '用户菜单' }).click();
    await dialog.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => {});
    if (!(await dialog.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
    }
  }
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

test('语音派单终态消息把工具账本文件渲染成可点产物卡', async ({ page, request, baseURL }) => {
  await waitForAppReady(page);
  await dismissFirstRunDialogs(page);
  const token = await authToken(page);
  const runTag = Date.now().toString(36);
  const workItemId = `artifact-work-${runTag}`;

  const created = await request.post(`${baseURL}/api/sessions?token=${encodeURIComponent(token)}`, {
    data: { title: `voice-artifact-${runTag}` },
  });
  expect(created.status(), await created.text()).toBe(200);
  const sessionId = ((await created.json()) as { data?: { id?: string } }).data?.id;
  expect(sessionId).toBeTruthy();

  const startedAt = Date.now();
  const seed = await request.post(`${baseURL}/api/dev/seed-messages?token=${encodeURIComponent(token)}`, {
    data: {
      sessionId,
      sessionMetadata: { hadLiveVoice: true },
      messages: [
        {
          id: `artifact-dispatch-${runTag}`,
          role: 'assistant',
          content: '创建 12.md 文件',
          timestamp: startedAt,
          metadata: { source: 'voice', voiceDispatch: { title: '创建 12.md 文件', workItemId } },
        },
        {
          id: `artifact-result-${runTag}`,
          role: 'system',
          content: '[任务结果] 创建 12.md 文件｜completed｜文件已创建。',
          timestamp: startedAt + 1_000,
          metadata: {
            source: 'voice',
            backgroundTaskResult: {
              source: 'agent-result',
              taskId: workItemId,
              shortName: '创建 12.md 文件',
              status: 'completed',
              summary: '文件已创建。',
              artifacts: [{
                artifactId: `artifact-${runTag}`,
                kind: 'document',
                role: 'deliverable',
                sourceTool: 'Write',
                label: '12.md',
                path: '/tmp/voice-artifact/12.md',
              }],
            },
            voiceWorkSettled: { workItemId, title: '创建 12.md 文件', outcome: 'done' },
          },
        },
      ],
    },
  });
  expect(seed.status(), await seed.text()).toBe(200);

  await waitForAppReady(page);
  const sessionRow = page.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(sessionRow).toBeVisible({ timeout: 10_000 });
  await sessionRow.click();

  const fileCard = page.getByRole('button', { name: '打开文件预览: 12.md' });
  await expect(fileCard).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('12.md', { exact: true })).toHaveCount(1);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'voice-task-artifact-card.png'), fullPage: false });
});

test('字幕、任务标题、模型、音色和费用空态都说人话', async ({ page, request, baseURL }) => {
  await waitForAppReady(page);
  await dismissFirstRunDialogs(page);
  const token = await authToken(page);
  const runTag = Date.now().toString(36);

  const created = await request.post(`${baseURL}/api/sessions?token=${encodeURIComponent(token)}`, {
    data: { title: `voice-ux-${runTag}` },
  });
  expect(created.status(), await created.text()).toBe(200);
  const body = (await created.json()) as { data?: { id?: string } };
  const sessionId = body.data?.id;
  expect(sessionId).toBeTruthy();

  const startedAt = Date.now();
  const seed = await request.post(`${baseURL}/api/dev/seed-messages?token=${encodeURIComponent(token)}`, {
    data: {
      sessionId,
      sessionMetadata: { hadLiveVoice: true },
      messages: [
        {
          id: `voice-ux-user-${runTag}`,
          role: 'user',
          content: '创建壹二点md',
          timestamp: startedAt,
          metadata: { source: 'voice' },
        },
        {
          id: `voice-ux-dispatch-${runTag}`,
          role: 'assistant',
          content: '创建 12.md 文件',
          timestamp: startedAt + 1_000,
          metadata: {
            source: 'voice',
            voiceDispatch: { title: '创建 12.md 文件', workItemId: `work-${runTag}` },
          },
        },
      ],
    },
  });
  expect(seed.status(), await seed.text()).toBe(200);

  await waitForAppReady(page);
  const sessionRow = page.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(sessionRow).toBeVisible({ timeout: 10_000 });
  await expect(sessionRow.getByTestId('session-live-voice-badge')).toBeVisible();
  await sessionRow.click();

  const userNode = page.locator('[data-trace-node-type="user"]');
  await expect(userNode).toContainText('创建12.md');
  await expect(userNode).not.toContainText('壹二点md');
  await expect(page.getByTestId('voice-task-card-header')).toContainText('创建 12.md 文件');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'voice-ux-chat.png'), fullPage: false });

  await dismissFirstRunDialogs(page);
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: '语音模型', exact: true }).click();
  const voiceList = settings.getByTestId('voice-model-voice-list');
  await expect(voiceList).toContainText('Tina· 普通话·甜暖');
  await expect(voiceList).toContainText('Ethan· 普通话·明亮朝气');
  await expect(voiceList).toContainText('Serena· 女声·温柔');
  await expect(voiceList.getByText('试听')).toHaveCount(3);
  await expect(settings.getByTestId('voice-live-key-masked')).toBeVisible();
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'voice-ux-settings.png'), fullPage: false });

  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await dismissFirstRunDialogs(page);
  const realtimeSettings = await openSettings(page);
  await realtimeSettings.getByRole('button', { name: '实时语音', exact: true }).click();
  const liveSwitch = realtimeSettings.getByRole('switch', { name: '启用实时语音' });
  if ((await liveSwitch.getAttribute('aria-checked')) !== 'true') await liveSwitch.click();
  await page.keyboard.press('Escape');
  await expect(realtimeSettings).toBeHidden();

  const liveButton = page.getByTestId('live-voice-button');
  await expect(liveButton).toBeVisible({ timeout: 10_000 });
  await liveButton.click();
  const startDialog = page.getByTestId('voice-start-dialog');
  await expect(startDialog).toBeVisible();
  await expect(startDialog.getByTestId('voice-start-model-identity')).toContainText('Qwen3.5 Omni Flash Realtime · DashScope');
  await expect(startDialog).toContainText('输入框显示的是文字对话模型');
  await expect(startDialog.locator('option')).toHaveText([
    'Tina · 普通话·甜暖',
    'Ethan · 普通话·明亮朝气',
    'Serena · 女声·温柔',
  ]);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'voice-ux-start-dialog.png'), fullPage: false });

  await page.getByRole('button', { name: '开始通话', exact: true }).click();
  const chrome = page.getByTestId('voice-chrome');
  await expect(chrome).toBeVisible({ timeout: 10_000 });
  await expect(chrome.getByTestId('voice-call-cost')).toContainText('暂无法预估费用');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'voice-ux-cost-empty.png'), fullPage: false });

  const endButton = chrome.getByTestId('voice-end');
  if (await endButton.isVisible().catch(() => false)) await endButton.click();
});
