// ============================================================================
// 轮次导航（N-TURNRAIL）全链路：真会话、真输入框、真 AgentLoop（E2E 本地假模型，零付费）跑满
// 10 轮 → 右缘出现导航条 → 点第 2 格 → 聊天滚到第 2 轮且导航高亮落到它。
// 历史整段加载，跳转不需要分页。跑法：CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1（本地模型只对带
// E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE 标记的消息回话，每轮真调一次 Read 工具再给结论）。
// ============================================================================
import { test, expect, type Page } from './fixtures/axeTest';

const TURNS = 10;
const FIXTURE_MARKER = 'E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE';

test.setTimeout(180_000);
test.skip(process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL !== '1', '需要 CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1（本地假模型跑真轮次，不进默认 e2e 批）');

// 首启/每次 reload 都会重弹的遮罩（信任文件夹 → 连接模型 onboarding → 跳过后落在设置页 → 返回应用），
// 出现才点；本机 web 版还可能先弹「注册」（有「关闭」）。与 chat-short-content-top-align.spec.ts 同一套。
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

async function openNewSession(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOverlays(page);
  const newSessionBtn = page.getByRole('button', { name: /新任务|New task/ }).first();
  if (await newSessionBtn.isVisible().catch(() => false)) await newSessionBtn.click();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
}

/** 一轮 = 用户一句（真输入框 Enter）→ 本地模型真调 Read → 结论文本；等这一轮的结论落地再发下一句。 */
async function runTurn(page: Page, n: number): Promise<void> {
  const chatInput = page.locator('[data-chat-input]');
  await chatInput.fill(`第 ${n} 件事：把第 ${n} 页的标题改一下 ${FIXTURE_MARKER}`);
  await chatInput.press('Enter');
  await expect(page.locator('[data-trace-turn-id]')).toHaveCount(n, { timeout: 20_000 });
  await expect(page.getByText(/smoke completed/).nth(n - 1)).toBeVisible({ timeout: 30_000 });
}

test('长会话右缘出现轮次导航，点第 2 格聊天滚到第 2 轮且高亮同步', async ({ page }) => {
  await openNewSession(page);

  for (let n = 1; n <= TURNS; n += 1) {
    await runTurn(page, n);
  }

  const rail = page.getByTestId('turn-rail-ticks');
  await expect(rail).toBeVisible({ timeout: 10_000 });
  const ticks = rail.getByRole('button', { name: /^(回到第 \d+ 轮|Back to turn \d+)$/ });
  await expect(ticks).toHaveCount(TURNS);

  // 进入落底：当前轮 = 最后一轮；点第 2 格
  await ticks.nth(1).click();

  const target = page.locator('[data-trace-turn-id]').nth(1);
  await expect(target).toBeVisible({ timeout: 5_000 });
  const inView = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.top < window.innerHeight * 0.5;
  });
  expect(inView, 'second turn should be aligned near the top of the viewport').toBe(true);
  await expect(ticks.nth(1)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });
});
