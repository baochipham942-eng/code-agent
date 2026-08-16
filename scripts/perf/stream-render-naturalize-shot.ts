// 工单 2026-08-01（流式渲染自然化）观感截图：8199 同款 web 构建（vite + 真实
// renderer 源码与 global.css），模拟 GLM-5 式大块吐字，截「长内容到达瞬间」与
// 「静止后」两张，附 DOM 状态证据（直落长度 / isAnimating / 尾段 span 是否存在）。
import fs from 'node:fs';
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright';
import { getFreePort } from '../acceptance/browser-computer-system-chrome.ts';
import { getStringOption, parseArgs, printJson, hasFlag } from '../acceptance/_helpers.ts';

interface StreamRenderSnapshot {
  atMs: number;
  contentLength: number;
  displayLength: number;
  isAnimating: boolean;
  tailStartIndex: number | null;
  tailSegmentInDom: boolean;
}

interface StreamRenderTimeline {
  startedAtMs: number;
  arrivals: Array<{ atMs: number; targetLength: number; displayLength: number }>;
  mutations: Array<StreamRenderSnapshot & { sequence: number }>;
  finishedAtMs: number | null;
}

// 模拟大块吐字：一整段 ~1500 字中文长文一次到达（不含 markdown 触发符，走纯文本
// 流式路径——尾段淡入 span 生效的那条）。
const LONG_CHUNK = [
  '流式渲染的自然化改造，核心思路是把「到达」和「呈现」解耦。模型端以大块节奏吐字时，',
  '渲染层不再逐字符追赶，而是先判断积压规模：超过阈值的积压立即直落，保证整段内容第一时间可读；',
  '只有阈值内的尾巴保留生长感，按词和短段的粒度、以稳定节拍逐段落定。这样做的好处是双重的。',
  '一方面，用户面对长回答时不再需要等待动画追平，视线可以直接落在已稳定的文字上开始阅读；',
  '另一方面，尾部保留的轻微浮现感仍然传达了「正在生成」的语义，不会让界面显得僵硬或死寂。',
  '从工程实现看，这套机制收敛在一个 hook 之内：直落阈值、段落节拍、中文短段长度上限都是显式常量，',
  '便于后续按模型吐字特征微调。消费组件只多承担一件事——把最新落定的短段包进一个带淡入动画的',
  '容器，动画本身交给 CSS，不引入任何动画库。系统开启减少动态效果时，整条链路退化为全量直落，',
  '零动画，行为同样可测。既有契约保持不变：动画进行中的信号语义不变，依赖它的按钮行追平逻辑',
  '无需修改，只是追平会来得更快——这正是本次改造想要的效果。此外，直落策略还天然提供了一个',
  '安全阀：无论模型以多极端的突发节奏输出，屏幕上从左到右的扫描长度都不会超过约一行，',
  '频闪问题在机制上被根除，而不是靠调参掩盖。验收层面，我们关注三组行为：积压直落是否即时、',
  '尾部分段是否按词和句读切分、减少动态效果时是否全部直落，并配真机截图核对观感。',
].join('');

const PACED_TEXT = [
  '流式快照每隔一百五十毫秒到达一次，呈现层应把这些突发增量铺成连续可读的尾部节奏。',
  '当某次快照明显更长时，播放速度可以温和追赶，但不该积压到回合结束再整段跳变。',
  '短快照到达时也不应额外等待完整节拍，用户应该持续看到稳定前缀向后自然生长。',
].join('');
const PACED_CHUNK_SIZES = [18, 6, 26, 12, 32, 8, 24, 16, 28, 10, 30, 14];
const PACED_INTERVAL_MS = 150;

function splitBySizes(content: string, sizes: number[]): string[] {
  const chunks: string[] = [];
  let offset = 0;
  let sizeIndex = 0;
  while (offset < content.length) {
    const size = sizes[sizeIndex % sizes.length];
    chunks.push(content.slice(offset, offset + size));
    offset += size;
    sizeIndex += 1;
  }
  return chunks;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function summarizeTimeline(timeline: StreamRenderTimeline) {
  const displayMutations = timeline.mutations.filter((mutation, index, all) => (
    mutation.displayLength > (all[index - 1]?.displayLength ?? 0)
  ));
  const landingIntervalsMs = displayMutations.slice(1).map((mutation, index) => (
    mutation.atMs - displayMutations[index].atMs
  ));
  const catchUpDelaysMs = timeline.arrivals.map((arrival) => {
    const caughtUp = timeline.mutations.find((mutation) => (
      mutation.atMs >= arrival.atMs && mutation.displayLength >= arrival.targetLength
    ));
    return caughtUp ? caughtUp.atMs - arrival.atMs : null;
  });
  const measuredCatchUps = catchUpDelaysMs.filter((delay): delay is number => delay !== null);
  const displayDeltas = displayMutations.map((mutation, index) => (
    mutation.displayLength - (displayMutations[index - 1]?.displayLength ?? 0)
  ));
  const backlogsAtArrival = timeline.arrivals.map((arrival) => arrival.targetLength - arrival.displayLength);

  return {
    arrivalCount: timeline.arrivals.length,
    displayMutationCount: displayMutations.length,
    landingIntervalsMs: {
      min: landingIntervalsMs.length ? Math.min(...landingIntervalsMs) : null,
      median: percentile(landingIntervalsMs, 0.5),
      p95: percentile(landingIntervalsMs, 0.95),
      max: landingIntervalsMs.length ? Math.max(...landingIntervalsMs) : null,
    },
    catchUpDelaysMs: {
      measured: measuredCatchUps.length,
      pending: catchUpDelaysMs.length - measuredCatchUps.length,
      median: percentile(measuredCatchUps, 0.5),
      p95: percentile(measuredCatchUps, 0.95),
      max: measuredCatchUps.length ? Math.max(...measuredCatchUps) : null,
    },
    maxDisplayDeltaChars: displayDeltas.length ? Math.max(...displayDeltas) : 0,
    maxBacklogAtArrivalChars: backlogsAtArrival.length ? Math.max(...backlogsAtArrival) : 0,
    finalDisplayLength: timeline.mutations.at(-1)?.displayLength ?? 0,
  };
}

async function startViteServer(): Promise<ViteDevServer> {
  const port = await getFreePort();
  const root = process.cwd();
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    logLevel: 'error',
    root,
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      hmr: false,
    },
    resolve: {
      alias: {
        '@': path.resolve(root, 'src'),
        '@host': path.resolve(root, 'src/host'),
        '@renderer': path.resolve(root, 'src/renderer'),
        '@shared': path.resolve(root, 'src/shared'),
        electron: path.resolve(root, 'src/host/platform/index.ts'),
        keytar: path.resolve(root, 'tests/__mocks__/keytar.ts'),
      },
    },
  });

  server.middlewares.use('/__stream-render-naturalize.html', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Stream Render Naturalize</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #09090b; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/scripts/perf/stream-render-naturalize-harness.tsx"></script>
  </body>
</html>`);
  });

  await server.listen();
  return server;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(getStringOption(args, 'out-dir') || path.join(process.cwd(), 'docs/plans'));
  const label = getStringOption(args, 'label') || '2026-08-01-stream-render';
  const arrivalOut = path.join(outDir, `${label}-arrival.png`);
  const settledOut = path.join(outDir, `${label}-settled.png`);
  const pacedFrames = [
    path.join(outDir, `${label}-paced-1.png`),
    path.join(outDir, `${label}-paced-2.png`),
    path.join(outDir, `${label}-paced-3.png`),
  ];
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;

  try {
    fs.mkdirSync(outDir, { recursive: true });
    vite = await startViteServer();
    const localUrl = vite.resolvedUrls?.local[0];
    if (!localUrl) {
      throw new Error('Vite did not expose a local URL.');
    }

    browser = await chromium.launch({ headless: !hasFlag(args, 'visible') });
    const page = await browser.newPage({ viewport: { width: 880, height: 720 }, deviceScaleFactor: 2 });
    await page.goto(new URL('/__stream-render-naturalize.html', localUrl).toString(), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('body[data-stream-demo-ready="true"]', { timeout: 60_000 });

    // 大块吐字到达：一整段长文一次性 push
    await page.evaluate((chunk) => window.__STREAM_RENDER_DEMO__?.push(chunk), LONG_CHUNK);
    // 等一拍：首帧直落已发生、尾巴正在逐段落定
    await page.waitForTimeout(360);
    const arrival = await page.evaluate(() => window.__STREAM_RENDER_DEMO__?.snapshot());
    await page.screenshot({ path: arrivalOut });

    // 尾巴播完 + 流结束追平后的静止态
    await page.evaluate(() => window.__STREAM_RENDER_DEMO__?.finish());
    await page.waitForTimeout(600);
    const settled = await page.evaluate(() => window.__STREAM_RENDER_DEMO__?.snapshot());
    await page.screenshot({ path: settledOut });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-stream-demo-ready="true"]', { timeout: 60_000 });
    const pacedChunks = splitBySizes(PACED_TEXT, PACED_CHUNK_SIZES);
    const frameChunkIndexes = new Map([
      [Math.floor(pacedChunks.length / 3), pacedFrames[0]],
      [Math.floor(pacedChunks.length * 2 / 3), pacedFrames[1]],
      [pacedChunks.length - 1, pacedFrames[2]],
    ]);
    for (const [index, chunk] of pacedChunks.entries()) {
      await page.evaluate((nextChunk) => window.__STREAM_RENDER_DEMO__?.push(nextChunk), chunk);
      await page.waitForTimeout(PACED_INTERVAL_MS);
      const framePath = frameChunkIndexes.get(index);
      if (framePath) await page.screenshot({ path: framePath });
    }
    await page.waitForTimeout(800);
    await page.evaluate(() => window.__STREAM_RENDER_DEMO__?.finish());
    await page.waitForTimeout(600);
    const pacedSnapshot = await page.evaluate(() => window.__STREAM_RENDER_DEMO__?.snapshot());
    const pacedTimeline = await page.evaluate(() => window.__STREAM_RENDER_DEMO__?.timeline());
    if (!pacedTimeline) throw new Error('Paced timeline was not exposed by the harness.');

    const result = {
      chunkLength: LONG_CHUNK.length,
      arrival,
      settled,
      paced: {
        sourceLength: PACED_TEXT.length,
        chunkSizes: pacedChunks.map((chunk) => chunk.length),
        intervalMs: PACED_INTERVAL_MS,
        snapshot: pacedSnapshot,
        metrics: summarizeTimeline(pacedTimeline),
        timeline: pacedTimeline,
      },
      shots: { arrival: arrivalOut, settled: settledOut, paced: pacedFrames },
    };
    const jsonOut = getStringOption(args, 'json-out');
    if (jsonOut) {
      const resolvedJsonOut = path.resolve(jsonOut);
      fs.mkdirSync(path.dirname(resolvedJsonOut), { recursive: true });
      fs.writeFileSync(resolvedJsonOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }
    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      console.log(JSON.stringify(result, null, 2));
      console.log(`Wrote ${path.relative(process.cwd(), arrivalOut)}`);
      console.log(`Wrote ${path.relative(process.cwd(), settledOut)}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (vite) await vite.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
