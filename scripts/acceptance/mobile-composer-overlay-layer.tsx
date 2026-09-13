/**
 * N-COMPOSER-TRACE-JITTER 的判据：输入区高矮变化**不许**改动会话区的可视高度与内容位置。
 *
 * 为什么不能用 jsdom：它不做布局，clientHeight / getBoundingClientRect 恒为 0，
 * 这条不变量在那里根本不可观测。为什么不能用截图：这是运动伪影，两张图各自都"对"，
 * 错的是它们之间的那一跳。所以在真引擎里量数。
 *
 * 用真 styles.css + 真 DOM 形状。复刻与真组件的接线由两道兜：下面的 assertReplicaStillMatches()
 * 对着 MobileRoot 源码核承重点，重新贴底那一半由 tests/unit/mobile/companionConversationRepin.test.tsx
 * 在 jsdom 里钉。
 *
 * 跑法：npx tsx scripts/acceptance/mobile-composer-overlay-layer.tsx
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.resolve(here, '../../packages/mobile/src/styles.css'), 'utf8');

/** 与 MobileRoot 的 `<main className="conversation">` 子树同构：topbar / message-region / composer-area。 */
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<div class="app"><div class="conversation" id="conversation">
  <div class="topbar"><strong>会话</strong></div>
  <div class="message-region"><div class="lan-messages" id="scroller">
    ${Array.from({ length: 40 }, (_, i) => `<div class="lan-message" id="m${i}">第 ${i} 条消息，用来把滚动区撑高</div>`).join('')}
  </div><button class="jump-latest" id="jump">回到最新</button></div>
  <div class="composer-area" id="area">
    <div class="composer"><textarea id="ta" rows="1"></textarea><div class="composer-tools"><span class="spacer"></span></div></div>
    <div class="task-status"><span>状态行</span></div>
  </div>
</div></div>
<script>
  // 照搬 MobileRoot 那个 ResizeObserver：把输入区实测高度发布成 --composer-h
  const area = document.getElementById('area'), root = document.getElementById('conversation');
  const scroller = document.getElementById('scroller');
  let following = true;
  scroller.addEventListener('scroll', () => {
    following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  });
  const sync = () => {
    root.style.setProperty('--composer-h', area.offsetHeight + 'px');
    // 复刻 MobileRoot → CompanionConversation 的重新贴底（真实接线由 mobileRootLayout 单测钉住）
    if (following) scroller.scrollTop = scroller.scrollHeight;
  };
  sync(); new ResizeObserver(sync).observe(area);
</script></body></html>`;

type Probe = { clientHeight: number; scrollTop: number; anchorTop: number; areaHeight: number; lastVisible: boolean; jumpVisible: boolean };

/**
 * 这份 HTML 是 MobileRoot 子树的**复刻**，复刻就有跟着漂的风险：真组件改了类名，
 * CSS 在 app 里失效、这里却照样绿。所以先对着源文件确认复刻的那几个承重点还在——
 * 它挡不住语义漂移，但挡得住静默重命名。
 */
function assertReplicaStillMatches(): string[] {
  const source = fs.readFileSync(path.resolve(here, '../../packages/mobile/src/app/MobileRoot.tsx'), 'utf8');
  const required: [string, string][] = [
    ['className="conversation" ref={conversation}', '会话根元素（--composer-h 挂在它身上）'],
    ['className="composer-area" ref={composerArea}', '输入区那一层（被观察的就是它）'],
    ["setProperty('--composer-h'", '把实测高度发布成 CSS 变量'],
    ['composerHeight={composerHeight}', '把高度传给会话区做重新贴底'],
  ];
  return required.filter(([needle]) => !source.includes(needle))
    .map(([needle, why]) => `MobileRoot 里找不到 \`${needle}\`（${why}）——复刻已与真组件脱节，这份判据不再作数`);
}

async function main(): Promise<void> {
  const drift = assertReplicaStillMatches();
  if (drift.length) {
    for (const d of drift) console.error(`\u2717 ${d}`);
    process.exit(1);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
  await page.setContent(html);

  const probe = (): Promise<Probe> => page.evaluate(() => {
    const scroller = document.getElementById('scroller')!;
    const anchor = document.getElementById('m20')!;
    const area = document.getElementById('area')!;
    const last = document.getElementById('m39')!.getBoundingClientRect();
    return {
      clientHeight: scroller.clientHeight,
      scrollTop: Math.round(scroller.scrollTop),
      anchorTop: Math.round(anchor.getBoundingClientRect().top),
      areaHeight: area.offsetHeight,
      // 最后一条消息的底边不许被输入区那一层盖住
      lastVisible: last.bottom <= area.getBoundingClientRect().top + 1,
      // 「回到最新」也不许落在那一层后面——它是浮在 message-region 上的，而 message-region
      // 现在一直铺到会话底边
      jumpVisible: document.getElementById('jump')!.getBoundingClientRect().bottom
        <= area.getBoundingClientRect().top + 1,
    };
  });

  // ResizeObserver 是下一帧才回调的：不等它落地就量，量到的是旧 padding。
  const settle = async () => {
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  };
  const setComposerHeight = async (px: number) => {
    await page.evaluate(h => { (document.getElementById('ta') as HTMLTextAreaElement).style.height = h + 'px'; }, px);
    await settle();
  };

  const failures: string[] = [];
  const near = (a: number, b: number, slack = 1) => Math.abs(a - b) <= slack;

  // ── 场景一：没贴底（滚到中间）时，输入区长高/变矮，可视内容必须一动不动 ──
  await page.evaluate(() => { document.getElementById('scroller')!.scrollTop = 400; });
  await setComposerHeight(140);
  const grown = await probe();
  await setComposerHeight(24);
  const shrunk = await probe();

  if (!near(grown.clientHeight, shrunk.clientHeight)) {
    failures.push(`会话区可视高度被输入区挤动了：${grown.clientHeight} → ${shrunk.clientHeight}（输入区 ${grown.areaHeight} → ${shrunk.areaHeight}）`);
  }
  if (!near(grown.anchorTop, shrunk.anchorTop)) {
    failures.push(`可视内容发生位移：锚点消息 top ${grown.anchorTop} → ${shrunk.anchorTop}`);
  }
  if (!near(grown.scrollTop, shrunk.scrollTop)) {
    failures.push(`scrollTop 被改动：${grown.scrollTop} → ${shrunk.scrollTop}`);
  }

  // ── 场景二：贴底时最后一条不许被输入区盖住（两种高度各验一次） ──
  for (const h of [24, 140]) {
    await setComposerHeight(h);
    await page.evaluate(() => { const s = document.getElementById('scroller')!; s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); });
    await settle();
    const bottom = await probe();
    if (!bottom.lastVisible) failures.push(`输入区高 ${bottom.areaHeight}px 贴底时，最后一条消息被盖住了`);
    if (!bottom.jumpVisible) failures.push(`输入区高 ${bottom.areaHeight}px 时，「回到最新」被输入区那一层盖住了（点不到）`);
  }

  // ── 场景三：矮屏（媒体查询会重写留白）也要给浮层留底 ──
  await page.setViewportSize({ width: 393, height: 500 });
  await setComposerHeight(140);
  const short = await probe();
  if (!short.jumpVisible) failures.push(`矮屏 500px 下「回到最新」被输入区那一层盖住了`);

  await browser.close();
  if (failures.length) {
    for (const f of failures) console.error(`✗ ${f}`);
    console.error(`FAIL: ${failures.length} 条不变量被打破`);
    process.exit(1);
  }
  console.log('✓ 输入区是独立一层：高矮变化不改会话区可视高度/内容位置，贴底时也不盖住最后一条');
}

void main();
