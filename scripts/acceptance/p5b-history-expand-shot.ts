import { setTimeout as delay } from 'timers/promises';
import { loadPlaywrightChromium } from '../../src/host/agent/runtime/browser/playwrightRuntime';
const OUT = process.argv[2]!;
async function main(): Promise<void> {
  const pw = await loadPlaywrightChromium();
  if (!pw.ok || !pw.chromium) throw new Error('playwright 不可用');
  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.goto(`http://127.0.0.1:${process.env.WEB_PORT ?? '8186'}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="sidebar-capability-hub"]', { timeout: 60_000 });
  await delay(1500);
  await page.click('[data-testid="sidebar-capability-hub"]');
  await page.waitForSelector('[data-testid="capability-hub-tab-history"]', { timeout: 15_000 });
  await page.click('[data-testid="capability-hub-tab-history"]');
  await page.waitForSelector('[data-testid="capability-history-batch"]', { timeout: 15_000 });
  await delay(800);
  // 只展开 50 个能力的那一批（冷启动装载，流式名单的视觉关）
  const toggles = await page.$$('[data-testid="capability-history-fold-toggle"]');
  await toggles[toggles.length - 1].click();
  await delay(400);
  await page.screenshot({ path: `${OUT}/05-history-batch-expanded-dark.png`, fullPage: true });
  const members = await page.$$eval('[data-testid="capability-history-batch-member"]', (els) => els.length);
  console.log(`expanded members=${members}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
