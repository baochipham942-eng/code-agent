import { test, expect, type Page } from '@playwright/test';

test.setTimeout(120_000);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function dismissApiKeyDialog(page: Page) {
  const skipButton = page.getByText('稍后配置');
  if (await skipButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await skipButton.click();
    await page.waitForTimeout(500);
  }
}

async function bootstrapUniqueSession(page: Page): Promise<string> {
  const title = `Phase6 Review Smoke ${Date.now()}`;

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
  await dismissApiKeyDialog(page);

  await page.evaluate(async (sessionTitle) => {
    const response = await window.domainAPI?.invoke<{ id: string }>('session', 'create', { title: sessionTitle });
    if (!response?.success) {
      throw new Error(response?.error?.message || 'failed to create e2e session');
    }
  }, title);

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
  await dismissApiKeyDialog(page);

  return title;
}

test('current session can enter review queue and reopen replay from eval center', async ({ page }) => {
  const title = await bootstrapUniqueSession(page);
  const titlePattern = new RegExp(escapeRegExp(title));

  await expect(page.locator('h2').filter({ hasText: title })).toBeVisible({ timeout: 15_000 });

  const addToReviewButton = page.getByRole('button', { name: '加入 Review' });
  await expect(addToReviewButton).toBeVisible({ timeout: 10_000 });
  await addToReviewButton.click();
  await expect(page.getByRole('button', { name: '已在 Review' })).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: '打开 Replay' }).click();

  await expect(page.getByRole('heading', { name: '评测中心' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(titlePattern).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Trace 轨迹')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: '返回' }).click();

  await expect(page.getByText('Review Queue')).toBeVisible({ timeout: 10_000 });

  const reviewQueueItem = page.getByRole('button', {
    name: new RegExp(`${escapeRegExp(title)}[\\s\\S]*Replay`),
  }).first();
  await expect(reviewQueueItem).toBeVisible({ timeout: 10_000 });
  await reviewQueueItem.click();

  await expect(page.getByRole('button', { name: '返回' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(titlePattern).first()).toBeVisible({ timeout: 10_000 });
});
