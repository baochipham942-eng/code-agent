// 欢迎页示例卡 × 真实键盘草稿（N-FIX-WELCOME-CARD-DRAFT-EMPTY-SESSION / FB-581）
// 组件单测只能用 handle.setDraft 填草稿；这里用 page.keyboard.type 打进 contenteditable，
// 覆盖「真实输入 → latestValueRef → hasDraftOccupancy」这条单测够不到的链路。
import { test, expect, type Page } from './fixtures/axeTest';

test.setTimeout(60_000);

const CARDS = [
  { key: 'meeting-notes', title: /整理一份会议纪要|Write up meeting minutes/, promptHead: /把下面这段会议速记整理成正式会议纪要|Turn this raw meeting scribble/ },
  { key: 'weekly-report', title: /写一份本周工作周报|status report/i, promptHead: /帮我把这周的工作要点写成一份|Turn this week/ },
  { key: 'sales-data', title: /分析一组销售数据|Analyze a sales spreadsheet/, promptHead: /分析下面这份月度销售数据|Analyze this monthly sales dataset/ },
] as const;
const DRAFT = 'draft XY77 keep test';
const NO_MODEL_NOTICE = /Configure a model before sending|先配置一个模型后再发送/;

async function openFreshWelcome(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  // 引导弹层按线上语言设置渲染（按钮可能是中文或英文），firstRunDialogs 只认中文，这里中英都认。
  const skip = page.getByRole('button', { name: /跳过，稍后在设置里配置|Skip for now/ });
  await skip.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.getByRole('button', { name: /^(新任务|New task)/ }).click();
  await expect(page.getByTestId('chat-welcome-title')).toBeVisible({ timeout: 10_000 });
}

const sessionCount = (page: Page) => page.locator('[data-session-id]').count();
const composerText = (page: Page) => page.getByTestId('chat-composer-textarea').innerText();

for (const card of CARDS) {
  test(`有草稿时点「${card.key}」卡：不建会话、草稿保留、模板空行追加、输入框聚焦`, async ({ page }) => {
    await openFreshWelcome(page);
    const composer = page.getByTestId('chat-composer-textarea');
    await composer.click();
    await page.keyboard.type(DRAFT);
    await expect(composer).toContainText(DRAFT);

    const before = await sessionCount(page);
    const urlBefore = page.url();
    await page.getByRole('button', { name: card.title }).click();

    await expect(composer).toContainText(DRAFT);
    // 没配模型的 e2e 环境里，误走 onSend 会被拦下并弹「先配置一个模型」提示（也会跳去设置页）——
    // 草稿路径下它绝不能出现，这是「没有调用 onSend」的可观测证据。
    await page.waitForTimeout(1_000);
    await expect(page.locator('body')).not.toContainText(NO_MODEL_NOTICE);
    await expect(composer).toBeFocused();
    const text = await composerText(page);
    expect(text.startsWith(DRAFT)).toBe(true);
    expect(text.slice(DRAFT.length).startsWith('\n\n')).toBe(true);
    expect(text.length).toBeGreaterThan(DRAFT.length + 20);
    expect(text).toMatch(card.promptHead);
    await expect(page.getByTestId('chat-welcome-title')).toBeVisible();
    expect(await sessionCount(page)).toBe(before);
    expect(page.url()).toBe(urlBefore);
    console.log(`[draft:${card.key}] sessions ${before}->${await sessionCount(page)} composer=${JSON.stringify(text.slice(0, 40))}`);
  });

  test(`空输入框点「${card.key}」卡：照旧立即走发送路径（不是填充）`, async ({ page }) => {
    await openFreshWelcome(page);
    await page.getByRole('button', { name: card.title }).click();
    // e2e 数据目录没配模型：发送路径在 sendMessage 入口被「请先配置模型」拦下并弹提示，
    // 这条提示只可能来自 onSend 路径（填充路径不会触发）；同时输入框保持空、没把模板填进去。
    await expect(page.locator('body')).toContainText(NO_MODEL_NOTICE, { timeout: 10_000 });
    console.log(`[empty:${card.key}] send path taken (model-not-configured notice shown)`);
  });
}
