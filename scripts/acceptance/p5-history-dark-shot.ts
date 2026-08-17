#!/usr/bin/env npx tsx
// N-LEDGER-P5 补拍：暗色档装卸历史 tab（生产桌面 app 主色调）
import { mkdir } from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';
import { loadPlaywrightChromium } from '../../src/host/agent/runtime/browser/playwrightRuntime';

const BASE = `http://127.0.0.1:${process.env.WEB_PORT ?? '8186'}`;
const OUT = process.argv[2] ?? '/tmp/p5-accept';

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const pw = await loadPlaywrightChromium();
  if (!pw.ok || !pw.chromium) throw new Error('playwright 不可用');
  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sidebar-capability-hub"]', { timeout: 60_000 });
  await delay(2000);
  await page.click('[data-testid="sidebar-capability-hub"]');
  await page.waitForSelector('[data-testid="capability-hub-tab-history"]', { timeout: 15_000 });
  await page.click('[data-testid="capability-hub-tab-history"]');
  // P5B 前后两种形状都等：批次行（新）或事件行（旧）
  await page.waitForSelector('[data-testid="capability-history-batch"], [data-testid="capability-history-event"]', { timeout: 15_000 });
  await delay(1200);
  await page.screenshot({ path: `${OUT}/04-history-tab-dark.png` });
  await browser.close();
  console.log('dark screenshot done');
}

main().catch((error) => { console.error(error); process.exit(1); });
