import { chromium } from 'playwright';
const [url, out, vp, wait] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
try { await page.waitForSelector(wait || 'body', { state: 'visible', timeout: 30000 }); } catch {}
await page.waitForTimeout(3000);
await page.screenshot({ path: out, fullPage: false });
await browser.close();
console.log('SHOT', out);
