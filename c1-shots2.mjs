import { chromium } from 'playwright';
import fs from 'node:fs';
const PORT = process.env.PORT || '8190';
const OUT = process.argv[2] || '/tmp/c1-shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem('code-agent-theme', t), theme);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.locator('.h-screen').waitFor({ timeout: 20000 });
  for (const name of ['信任并加载', '跳过，稍后在设置里配置', '返回应用']) {
    const b = page.getByRole('button', { name }).first();
    await b.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
  }
  await page.getByTestId('sidebar-capability-zone').waitFor({ timeout: 20000 });

  const openMenu = async () => {
    await page.locator('text=Local Web').first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);
  };
  // 评测中心
  await openMenu();
  await page.getByText('评测中心', { exact: true }).first().click({ timeout: 8000 }).catch((e) => console.log('eval menu miss', e.message));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${theme}-evalcenter.png` });
  for (const tab of ['telemetry', 'benchmarks']) {
    await page.getByTestId(`eval-center-tab-${tab}`).click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/${theme}-evalcenter-${tab}.png` });
  }
  // 设置
  const back = page.getByTestId('full-screen-page-back').first();
  if (await back.isVisible().catch(() => false)) await back.click().catch(() => {});
  await page.waitForTimeout(800);
  await openMenu();
  await page.getByText('设置', { exact: true }).first().click({ timeout: 8000 }).catch((e) => console.log('settings menu miss', e.message));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/${theme}-settings.png` });
  await ctx.close();
}
await browser.close();
console.log('done');
