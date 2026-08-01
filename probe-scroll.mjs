import { chromium } from 'playwright';
const SHOT = '/private/tmp/claude-501/-Users-linchen-Downloads-ai/949fd597-ff9b-429c-8457-af7b0d45cbf0/scratchpad';
const log = (...a) => console.log('[probe]', ...a);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:8182', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.getByText('新任务', { exact: true }).first().click();
await page.waitForTimeout(3000);

const composer = () => page.locator('[contenteditable="true"]').first();
await composer().click();
await page.keyboard.type('写一段 400 字的散文，讲春天的雨，不要分点', { delay: 5 });
await page.keyboard.press('Enter');

// 流式过程中反复量：滚动容器是否贴底、最后一段文字是否在视口内
const samples = [];
for (let i = 0; i < 24; i += 1) {
  await page.waitForTimeout(2000);
  const m = await page.evaluate(() => {
    const scrollers = Array.from(document.querySelectorAll('*')).filter((el) => {
      const s = getComputedStyle(el);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40;
    });
    // 取会话区那个（最高的）
    const el = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (!el) return null;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    return { gap: Math.round(gap), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  if (m) samples.push(m);
  const done = !/引导对话/.test(await page.evaluate(() => document.body.innerText.slice(-400)));
  if (done && i > 3) break;
}
log('滚动样本（gap = 距底部距离，越大越说明没跟住）:', JSON.stringify(samples.slice(-8)));
const maxGap = Math.max(...samples.map((s) => s.gap));
log('最大 gap:', maxGap);
await page.screenshot({ path: `${SHOT}/scroll-end.png` });

// ④ 点赞工具栏与正文的 DOM 顺序
const order = await page.evaluate(() => {
  const nodes = Array.from(document.querySelectorAll('[data-testid], button[title]'));
  return nodes
    .map((n) => n.getAttribute('data-testid') || n.getAttribute('title'))
    .filter((x) => x && /赞|复制|copy|feedback|thumb|分支/i.test(x))
    .slice(0, 6);
});
log('工具栏候选:', JSON.stringify(order));
await browser.close();
