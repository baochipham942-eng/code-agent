#!/usr/bin/env npx tsx
// 探查技能 tab 实际结构
import { mkdir } from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';
import { loadPlaywrightChromium } from '../../src/host/agent/runtime/browser/playwrightRuntime';

const BASE = 'http://127.0.0.1:8186';
const OUT = process.argv[2] ?? '/tmp/p5-accept';

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const pw = await loadPlaywrightChromium();
  if (!pw.ok || !pw.chromium) throw new Error('playwright 不可用');
  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sidebar-capability-hub"]', { timeout: 60_000 });
  await delay(2000);
  await page.click('[data-testid="sidebar-capability-hub"]');
  await page.waitForSelector('[data-testid="capability-hub-tab-skills"]', { timeout: 15_000 });
  await page.click('[data-testid="capability-hub-tab-skills"]');
  await delay(5000);
  await page.screenshot({ path: `${OUT}/01-skills-tab.png`, fullPage: true });
  const info = await page.evaluate(() => ({
    ariaButtons: [...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')).slice(0, 30),
    switches: document.querySelectorAll('[role="switch"]').length,
    bodyText: document.body.innerText.slice(0, 800),
  }));
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
