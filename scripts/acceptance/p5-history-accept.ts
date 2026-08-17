#!/usr/bin/env npx tsx
// N-LEDGER-P5 真机验收：能力中心 → 技能 tab → 关掉再打开一个技能（造 unload/load 事件）
// → 装卸历史 tab 截图。用法：npx tsx scripts/acceptance/p5-history-accept.ts <outDir>
import { mkdir } from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';
import { loadPlaywrightChromium } from '../../src/host/agent/runtime/browser/playwrightRuntime';

const BASE = `http://127.0.0.1:${process.env.WEB_PORT ?? '8186'}`;
const OUT = process.argv[2] ?? '/tmp/p5-accept';

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const pw = await loadPlaywrightChromium();
  if (!pw.ok || !pw.chromium) throw new Error(`playwright 不可用: ${pw.error ?? 'unknown'}`);
  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[console.error] ${msg.text().slice(0, 200)}`);
  });
  page.on('pageerror', (err) => console.log(`[pageerror] ${String(err).slice(0, 200)}`));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sidebar-capability-hub"]', { timeout: 60_000 });
  await delay(2000);

  // 进能力中心 → 技能 tab
  await page.click('[data-testid="sidebar-capability-hub"]');
  await page.waitForSelector('[data-testid="capability-hub-tab-skills"]', { timeout: 15_000 });
  await page.click('[data-testid="capability-hub-tab-skills"]');
  // 默认落在「发现安装」子页，切到「已安装」才有启用开关
  await page.waitForSelector('button:has-text("已安装"), [role="tab"]:has-text("已安装")', { timeout: 30_000 });
  await page.click('button:has-text("已安装")');
  // 等技能行的启用开关出现
  await page.waitForSelector('button[aria-label^="启用 "], button[aria-label^="Enable "]', { timeout: 30_000 });
  await delay(1000);
  await page.screenshot({ path: `${OUT}/01-skills-tab.png`, fullPage: false });

  // 选一个技能，关掉再打开（触发 synchronizeSkillCapabilitySurface rebuild ⇒ unload/load 落账）
  const toggles = await page.$$('button[aria-label^="启用 "], button[aria-label^="Enable "]');
  if (toggles.length === 0) throw new Error('没有找到任何技能开关');
  const first = toggles[0];
  const ariaLabel = await first.getAttribute('aria-label');
  const skillName = (ariaLabel ?? '').replace(/^(启用 |Enable )/, '');
  const pressed = await first.getAttribute('aria-checked');
  console.log(`目标技能: ${skillName} (初始 aria-checked=${pressed})`);

  // 关 → 开（各等 2.5s 让账本 flush）
  await first.click();
  await delay(2500);
  const toggles2 = await page.$$(`button[aria-label="${ariaLabel}"]`);
  if (toggles2.length === 0) throw new Error('关闭后开关句柄丢失');
  await toggles2[0].click();
  await delay(2500);
  await page.screenshot({ path: `${OUT}/02-skills-after-toggle.png`, fullPage: false });

  // 切到装卸历史 tab
  await page.click('[data-testid="capability-hub-tab-history"]');
  await page.waitForSelector('[data-testid="capability-history-tab"]', { timeout: 15_000 });
  await delay(1500);
  await page.screenshot({ path: `${OUT}/03-history-tab.png`, fullPage: true });

  const summary = await page.evaluate(() => ({
    batches: document.querySelectorAll('[data-testid="capability-history-batch"]').length,
    members: document.querySelectorAll('[data-testid="capability-history-batch-member"]').length,
    // P5B 前的旧形状（按能力分组）：before 对照拍摄时只有这两个 testid
    groups: document.querySelectorAll('[data-testid="capability-history-group"]').length,
    events: document.querySelectorAll('[data-testid="capability-history-event"]').length,
    text: document.querySelector('[data-testid="capability-history-tab"]')?.textContent?.slice(0, 400) ?? '',
  }));
  console.log(`历史 tab: batches=${summary.batches} members=${summary.members} groups=${summary.groups} events=${summary.events}`);
  console.log(`可见文本: ${summary.text}`);

  await browser.close();
  if (summary.batches === 0 && summary.groups === 0) {
    console.error('FAIL: 历史 tab 既没有批次也没有分组——toggle 路径未触发装卸事件');
    process.exit(2);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
