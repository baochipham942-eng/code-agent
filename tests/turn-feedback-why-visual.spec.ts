import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const evidenceDir = process.env.FEEDBACK_WHY_EVIDENCE_DIR
  || path.resolve('test-results/turn-feedback-why-visual');

for (const theme of ['light', 'dark'] as const) {
  test(`turn feedback why ${theme}`, async ({ page }) => {
    await mkdir(evidenceDir, { recursive: true });
    await page.setViewportSize({ width: 960, height: 620 });
    await page.goto(`/tests/renderer/visual/turn-feedback-why.html?theme=${theme}`);

    await page.getByRole('button', { name: '这一轮回答有问题' }).click();
    await expect(page.getByTestId('turn-feedback-why')).toBeVisible();
    await page.screenshot({
      path: path.join(evidenceDir, `feedback-why-expanded-${theme}.png`),
      fullPage: true,
    });

    await page.getByRole('textbox', { name: '哪里不对？一句话就行' }).fill('工具选错了');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByTestId('turn-feedback-received')).toHaveText('已收到');
    await page.screenshot({
      path: path.join(evidenceDir, `feedback-why-received-${theme}.png`),
      fullPage: true,
    });
  });
}
