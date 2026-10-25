// ============================================================================
// 「新邮件」触发创建入口 —— 真 app 截图验收（N-TRIGGER-MAIL-CREATE-ENTRY-K1 ⑤）
//
// 夹具：tests/e2e/fakeMailWebServer.ts（源码同款 esbuild 选项打包，经
// getConnectorRegistry().register() 注入假 mail 连接器，不触碰真实 Mail.app）。
// 形态由 NEO_FAKE_MAIL_STATE 驱动（每次 playwright 进程跑一种）：
//   ready / not-authorized / unsupported / not-enabled
// ready 跑编辑器 + /schedule 确认卡两组截图；三种不可用态各出一张状态截图。
// /schedule 的 generateFromPrompt 在 HTTP 层固定回放一份 mail 草案（被验的是
// 确认卡与卡内选择，不是模型；真模型真跑见证据档 ⑦）。
// ============================================================================

import { expect, test, type Page } from './fixtures/axeTest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 900 } });

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOT_DIR = path.join(process.cwd(), 'test-results');
const STATE = process.env.NEO_FAKE_MAIL_STATE ?? 'ready';

/** generateFromPrompt 的固定回放草案（不编造账号：卡内选）。 */
const MAIL_DRAFT_FROM_MODEL = {
  name: '新邮件变待办',
  description: '有新邮件就整理成待办',
  enabled: true,
  scheduleType: 'event',
  schedule: { type: 'event', source: 'connector', connector: 'mail', eventName: 'message' },
  action: { type: 'agent', agentType: 'default', prompt: '把新邮件整理成待办清单' },
  restatement: { what: '盯着收件箱的新邮件', notifyWhen: '有新邮件到达时' },
};

async function waitForAppReady(page: Page): Promise<void> {
  const ssePromise = page.waitForResponse((resp) => resp.url().includes('/api/events'), { timeout: 20_000 });
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;
  for (const name of ['信任并加载', '跳过，稍后在设置里配置', '返回应用']) {
    const btn = page.getByRole('button', { name });
    await btn.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await btn.first().isVisible().catch(() => false)) {
      await btn.first().click();
      await expect(btn.first()).toBeHidden({ timeout: 10_000 });
    }
  }
  await expect(page.getByTestId('sidebar-capability-zone')).toBeVisible({ timeout: 15_000 });
}

/** 打开自动化中心 → 新建 → 手动配置 → 调度类型选「新邮件」，停在 mail 字段组。 */
async function openEditorOnMailSchedule(page: Page): Promise<void> {
  await page.getByTestId('sidebar-capability-automation').click();
  await expect(page.getByTestId('cron-center-panel')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('cron-center-panel').getByText('新建', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByText('手动配置', { exact: true }).click();
  // 调度类型 select：FormField 的 label 文本 → 同级包裹 div 里的 select（同
  // cronBudgetEditorFields 的 budgetField 取法）。
  const scheduleTypeField = dialog.getByText('调度类型', { exact: true }).locator('xpath=..');
  await expect(scheduleTypeField.locator('select')).toBeVisible({ timeout: 10_000 });
  await scheduleTypeField.locator('select').selectOption('event-mail');
  await expect(dialog.locator('#cron-event-mail-account')).toBeVisible({ timeout: 10_000 });
}

test('编辑器：新邮件类型 + 账号/邮箱下拉（ready 态）', async ({ page }) => {
  test.skip(STATE !== 'ready', '仅 ready 态跑');
  await waitForAppReady(page);
  await openEditorOnMailSchedule(page);

  const accountSelect = page.locator('#cron-event-mail-account');
  await expect(accountSelect).toBeEnabled({ timeout: 10_000 });
  const accountLabels = await accountSelect.locator('option').allTextContents();
  expect(accountLabels.some((label) => label.includes('iCloud'))).toBe(true);
  expect(accountLabels.some((label) => label.includes('Gmail'))).toBe(true);

  // 选账号 → 邮箱下拉出该账号的目录；「只有保存后到达的新邮件触发」提示可见。
  await accountSelect.selectOption({ label: 'iCloud · 艾达' });
  const mailboxSelect = page.locator('#cron-event-mailbox');
  await expect(mailboxSelect).toBeEnabled();
  const mailboxLabels = await mailboxSelect.locator('option').allTextContents();
  expect(mailboxLabels.some((label) => label.includes('INBOX'))).toBe(true);
  expect(mailboxLabels.some((label) => label.includes('归档'))).toBe(true);
  await expect(page.getByTestId('cron-event-mail-seed-hint')).toBeVisible();

  // 预算填上（选完账号会亮 requires-budget 内联提示，与通道分支同一道闸门；
  // 截图取合规态，红框形态由 jsdom 测试钉）。
  const budget = page.getByRole('dialog').locator('#cron-event-mail-budget');
  await budget.fill('0.5');
  await expect(page.getByTestId('cron-event-mail-validation')).toHaveCount(0);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // modal 体是 overflow-y-auto：mail 字段组在折叠线以下，先滚进视口再截
  //（用原生 scrollIntoView：scrollIntoViewIfNeeded 的可作用性等待在 modal 里会挂）。
  await page.getByTestId('cron-event-mail-seed-hint').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(SHOT_DIR, 'mail-entry-editor-ready.png') });
});

test('/schedule：mail 草案确认卡（行值 + 卡内选择 + 确认门）', async ({ page }) => {
  test.skip(STATE !== 'ready', '仅 ready 态跑');
  await waitForAppReady(page);

  // 模型调用在 HTTP 层固定回放（被验的是确认卡，不是模型）。
  await page.route('**/api/domain/cron/generateFromPrompt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MAIL_DRAFT_FROM_MODEL }),
    });
  });

  const newSessionBtn = page.getByRole('button', { name: '新任务' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();
  const chatInput = page.locator('[data-chat-input]');
  await expect(chatInput).toBeVisible({ timeout: 10_000 });
  await chatInput.fill('/schedule 有新邮件就整理成待办');
  await chatInput.press('Enter');

  const card = page.locator('[data-schedule-confirm]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  // 人话行：账号未选时的兜底文案；确认按钮被共享校验器禁用。
  const mailRow = page.locator('[data-schedule-row="mail"]');
  await expect(mailRow).toContainText('还没选');
  const confirmBtn = page.locator('[data-schedule-confirm-submit]');
  await expect(confirmBtn).toBeDisabled();

  // 卡内选账号：行值陈述实际绑定（新邮件 · 账号 · INBOX），确认启用。
  const accountSelect = card.locator('#cron-event-mail-account');
  await expect(accountSelect).toBeEnabled({ timeout: 10_000 });
  await accountSelect.selectOption({ label: 'iCloud · 艾达' });
  await expect(confirmBtn).toBeEnabled({ timeout: 10_000 });
  await expect(mailRow).toContainText('新邮件 · iCloud · 艾达 · INBOX');

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // 确认卡在聊天流里：滚到卡可见位置再截。
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(SHOT_DIR, 'mail-entry-confirm-card.png') });
});

test('编辑器：连接器不可用三态的可区分提示', async ({ page }) => {
  test.skip(!['not-authorized', 'unsupported', 'not-enabled'].includes(STATE), '仅不可用态跑');
  await waitForAppReady(page);
  await openEditorOnMailSchedule(page);

  const expected = {
    'not-authorized': '还没有通过授权',
    unsupported: '只在 macOS',
    'not-enabled': '还没有启用邮件连接器',
  }[STATE] ?? '';
  await expect(page.getByTestId('cron-event-mail-unavailable')).toContainText(expected, { timeout: 10_000 });

  if (STATE === 'not-authorized' || STATE === 'not-enabled') {
    await expect(page.getByRole('dialog').getByRole('button', { name: '去设置' })).toBeVisible();
  } else {
    // 平台不支持：无可修复动作，不出去设置按钮。
    await expect(page.getByRole('dialog').getByRole('button', { name: '去设置' })).toHaveCount(0);
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // 不可用提示在 modal 滚动区内：滚进视口再截（否则截到的只有上半段任务信息）。
  await page.getByTestId('cron-event-mail-unavailable').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(SHOT_DIR, `mail-entry-editor-${STATE}.png`) });
});
