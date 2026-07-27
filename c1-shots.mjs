// PR-C1 审美关截图：三个二级页 + 设置，亮暗两套。
// 打在 e2e webServer（与 Dev 包同一份 renderer bundle）。
import { chromium } from 'playwright';
import fs from 'node:fs';

const PORT = process.env.PORT || '8190';
const OUT = process.argv[2] || '/tmp/c1-shots';
fs.mkdirSync(OUT, { recursive: true });

const PAGES = [
  { entry: 'sidebar-capability-hub', id: 'capability-hub', wait: 'capability-hub-page' },
  { entry: 'sidebar-capability-library', id: 'library', wait: 'library-panel' },
  { entry: 'sidebar-capability-automation', id: 'automation', wait: 'cron-center-panel' },
];

const browser = await chromium.launch();

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem('code-agent-theme', t), theme);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.locator('.h-screen').waitFor({ timeout: 20000 });

  for (const name of ['信任并加载', '跳过，稍后在设置里配置', '返回应用']) {
    const btn = page.getByRole('button', { name }).first();
    await btn.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
  }
  await page.getByTestId('sidebar-capability-zone').waitFor({ timeout: 20000 });

  // 先建一个会话，让聊天区有内容（对照基线）
  await page.getByTestId('sidebar-new-task').click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${theme}-00-chat.png` });

  for (const { entry, id, wait } of PAGES) {
    await page.getByTestId(entry).click();
    await page.getByTestId(wait).waitFor({ timeout: 20000 });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${OUT}/${theme}-${id}.png` });
  }

  // 能力中心其余 tab
  await page.getByTestId('sidebar-capability-hub').click();
  await page.getByTestId('capability-hub-page').waitFor({ timeout: 20000 });
  for (const tab of ['skills', 'connectors']) {
    await page.getByTestId(`capability-hub-tab-${tab}`).click().catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/${theme}-capability-hub-${tab}.png` });
  }

  // 设置页（真独立 overlay 页）
  await page.getByTestId('sidebar-capability-hub').click().catch(() => {});
  await page.keyboard.press('Control+,').catch(() => {});
  await page.waitForTimeout(1200);
  if (await page.getByTestId('settings-panel').isVisible().catch(() => false)) {
    await page.screenshot({ path: `${OUT}/${theme}-settings.png` });
  } else {
    console.log(`[${theme}] 设置页未打开（快捷键不通），跳过`);
  }

  await ctx.close();
}

await browser.close();
console.log('done ->', OUT, fs.readdirSync(OUT).join(' '));
