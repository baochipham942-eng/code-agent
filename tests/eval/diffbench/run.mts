import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type CDPSession } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import type { HarnessResult } from './harness';

type RendererId = 'current' | 'codemirror';

interface MeasuredRun extends HarnessResult {
  repetition: number;
  heapBaselineMb: number;
  heapPeakMb: number;
  heapDeltaMb: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '../../..');
const resultsDir = path.join(__dirname, 'results');
const renderers: RendererId[] = ['current', 'codemirror'];
const fixtures = ['history-500', 'history-2000', 'history-5000', 'long-line-2400', 'pure-add-5000'];

function selectedRenderers(): RendererId[] {
  const requested = process.env.DIFFBENCH_RENDERER;
  if (!requested) return renderers;
  if (!renderers.includes(requested as RendererId)) throw new Error(`Unknown DIFFBENCH_RENDERER=${requested}`);
  return [requested as RendererId];
}

function selectedFixtures(): string[] {
  const requested = process.env.DIFFBENCH_FIXTURE;
  if (!requested) return fixtures;
  if (!fixtures.includes(requested)) throw new Error(`Unknown DIFFBENCH_FIXTURE=${requested}`);
  return [requested];
}

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} requires a positive integer`);
  return value;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function startServer(): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    logLevel: 'error',
    root: workspaceRoot,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    resolve: {
      alias: {
        '@': path.join(workspaceRoot, 'src'),
        '@renderer': path.join(workspaceRoot, 'src/renderer'),
        '@shared': path.join(workspaceRoot, 'src/shared'),
      },
      dedupe: ['react', 'react-dom', '@codemirror/state', '@codemirror/view'],
    },
    optimizeDeps: {
      entries: ['tests/eval/diffbench/harness.tsx'],
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        '@pierre/diffs',
        '@pierre/diffs/react',
        '@pierre/diffs > lru_map',
      ],
    },
  });

  server.middlewares.use('/__diffbench.html', (_request, response) => {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Neo Diffbench</title>
    <link rel="stylesheet" href="/src/renderer/styles/global.css" />
    <style>
      :root {
        color-scheme: dark;
        --bg-elevated: #27272a;
        --border-default: #3f3f46;
        --bg-surface: #18181b;
        --bg-deep: #09090b;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; background: #09090b; color: #d4d4d8; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
      #bench-scroll { width: 1180px; height: 720px; overflow: auto; contain: layout paint; }
      #root { min-height: 100%; }
      table { width: 100%; border-collapse: collapse; font: inherit; }
      td { padding: 2px 8px; white-space: pre; }
      .cm-editor { height: 720px; }
      diffs-container { display: block; min-height: 100%; }
    </style>
  </head>
  <body>
    <div id="bench-scroll"><div id="root"></div></div>
    <script type="module" src="/tests/eval/diffbench/harness.tsx"></script>
  </body>
</html>`);
  });

  await server.listen();
  await server.warmupRequest('/tests/eval/diffbench/harness.tsx');
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP address');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function launchBrowser(): Promise<{ browser: Browser; provider: string }> {
  try {
    return { browser: await chromium.launch({ headless: true }), provider: 'playwright-bundled-chromium' };
  } catch (bundledError) {
    try {
      return { browser: await chromium.launch({ channel: 'chrome', headless: true }), provider: 'system-chrome' };
    } catch (systemError) {
      throw new Error([
        'Unable to launch bundled Chromium or system Chrome.',
        `Bundled: ${String(bundledError)}`,
        `System: ${String(systemError)}`,
      ].join('\n'));
    }
  }
}

async function heapUsedMb(session: CDPSession): Promise<number> {
  const response = await session.send('Performance.getMetrics') as {
    metrics: Array<{ name: string; value: number }>;
  };
  const bytes = response.metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0;
  return bytes / (1024 * 1024);
}

async function runCase(
  browser: Browser,
  baseUrl: string,
  renderer: RendererId,
  fixture: string,
  repetition: number,
): Promise<MeasuredRun> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const diagnostics: string[] = [];
  page.on('pageerror', (error) => {
    diagnostics.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => diagnostics.push(
    `requestfailed: ${request.url()} ${request.failure()?.errorText ?? 'unknown'}`,
  ));
  page.on('response', (response) => {
    if (response.status() >= 400) diagnostics.push(`response ${response.status()}: ${response.url()}`);
  });
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  await session.send('HeapProfiler.enable');
  await session.send('HeapProfiler.collectGarbage');
  const heapBaselineMb = await heapUsedMb(session);
  let heapPeakMb = heapBaselineMb;
  let stopped = false;
  const sampler = (async () => {
    while (!stopped) {
      heapPeakMb = Math.max(heapPeakMb, await heapUsedMb(session));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();

  try {
    const shouldCapture = Boolean(process.env.DIFFBENCH_SCREENSHOT_DIR)
      && renderer === 'current'
      && fixture === 'history-5000'
      && repetition === 1;
    await page.goto(
      `${baseUrl}/__diffbench.html?renderer=${renderer}&fixture=${fixture}${shouldCapture ? '&keepMounted=1' : ''}`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (diagnostics.length > 0) throw new Error(diagnostics.join('\n'));
      const ready = await page.evaluate(() => (
        window.__DIFFBENCH_RESULT__ !== undefined || window.__DIFFBENCH_ERROR__ !== undefined
      ));
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (Date.now() >= deadline) {
      const body = await page.locator('body').innerText().catch(() => 'unreadable body');
      throw new Error(`Timed out waiting for harness\n${diagnostics.join('\n')}\nbody: ${body.slice(0, 2_000)}`);
    }
    const state = await page.evaluate(() => ({
      result: window.__DIFFBENCH_RESULT__,
      error: window.__DIFFBENCH_ERROR__,
      phase: window.__DIFFBENCH_PHASE__,
    }));
    if (state.error || !state.result) {
      throw new Error(`${renderer}/${fixture} failed in ${state.phase}: ${state.error ?? 'missing result'}`);
    }
    const screenshotDir = process.env.DIFFBENCH_SCREENSHOT_DIR;
    if (screenshotDir && shouldCapture) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.locator('.cm-scroller').evaluate((node) => { node.scrollTop = 0; });
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((nextTheme) => {
          document.documentElement.setAttribute('data-theme', nextTheme);
          document.documentElement.className = nextTheme;
        }, theme);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        await page.screenshot({
          path: path.join(screenshotDir, `diff-5000-${theme}.png`),
          clip: { x: 0, y: 0, width: 1180, height: 720 },
        });
      }
    }
    heapPeakMb = Math.max(heapPeakMb, await heapUsedMb(session));
    return {
      ...state.result,
      repetition,
      heapBaselineMb: round(heapBaselineMb),
      heapPeakMb: round(heapPeakMb),
      heapDeltaMb: round(Math.max(0, heapPeakMb - heapBaselineMb)),
    };
  } finally {
    stopped = true;
    await sampler.catch(() => undefined);
    await page.close();
  }
}

function aggregate(runs: MeasuredRun[], activeRenderers: RendererId[], activeFixtures: string[]) {
  const byCase: Record<string, unknown> = {};
  for (const renderer of activeRenderers) {
    for (const fixture of activeFixtures) {
      const selected = runs.filter((run) => run.renderer === renderer && run.fixture === fixture);
      const key = `${renderer}/${fixture}`;
      byCase[key] = {
        renderer,
        fixture,
        repetitions: selected.length,
        firstFrameMedianMs: round(median(selected.map((run) => run.firstFrameMs))),
        firstFrameMaxMs: round(Math.max(...selected.map((run) => run.firstFrameMs))),
        fullRenderMedianMs: round(median(selected.map((run) => run.fullRenderMs))),
        fullRenderMaxMs: round(Math.max(...selected.map((run) => run.fullRenderMs))),
        longestMountFrameMedianMs: round(median(selected.map((run) => run.longestMountFrameMs))),
        longestMountFrameMaxMs: round(Math.max(...selected.map((run) => run.longestMountFrameMs))),
        heapPeakMedianMb: round(median(selected.map((run) => run.heapPeakMb))),
        heapDeltaMedianMb: round(median(selected.map((run) => run.heapDeltaMb))),
        scrollMidP95MedianMs: round(median(selected.map((run) => run.scrollMid.p95Ms))),
        scrollMidMaxMs: round(Math.max(...selected.map((run) => run.scrollMid.maxMs))),
        scrollBottomP95MedianMs: round(median(selected.map((run) => run.scrollBottom.p95Ms))),
        scrollBottomMaxMs: round(Math.max(...selected.map((run) => run.scrollBottom.maxMs))),
        renderedDomRowsMedian: round(median(selected.map((run) => run.renderedDomRows))),
        scrollHeightMedian: round(median(selected.map((run) => run.scrollHeight))),
      };
    }
  }
  return byCase;
}

async function main(): Promise<void> {
  const repetitions = option('--repetitions', 3);
  const warmups = option('--warmups', 1);
  const activeRenderers = selectedRenderers();
  const activeFixtures = selectedFixtures();
  const startedAt = new Date().toISOString();
  const { server, url } = await startServer();
  const { browser, provider } = await launchBrowser();
  const version = browser.version();
  const runs: MeasuredRun[] = [];

  try {
    for (const renderer of activeRenderers) {
      for (const fixture of activeFixtures) {
        for (let index = 0; index < warmups; index += 1) {
          console.log(`warmup ${renderer}/${fixture} ${index + 1}/${warmups}`);
          await runCase(browser, url, renderer, fixture, 0);
        }
        for (let repetition = 1; repetition <= repetitions; repetition += 1) {
          console.log(`measure ${renderer}/${fixture} ${repetition}/${repetitions}`);
          runs.push(await runCase(browser, url, renderer, fixture, repetition));
        }
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    git: {
      head: process.env.DIFFBENCH_HEAD ?? 'aa2ea53c69f5b4c50044db286b6764b5741217bd',
      branch: process.env.DIFFBENCH_BRANCH ?? 'l5/diffbench',
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: os.cpus().length,
      totalMemoryGb: round(os.totalmem() / (1024 ** 3)),
      node: process.version,
      browserProvider: provider,
      browserVersion: version,
      viewport: { width: 1280, height: 820 },
      benchmarkViewport: { width: 1180, height: 720 },
    },
    method: {
      repetitions,
      warmups,
      firstFrame: 'mount 请求前起表，到 renderer 首批行 DOM 出现后的下一次 requestAnimationFrame。',
      fullRender: '首批 DOM 后，renderer 完成信号成立且 DOM 签名连续 3 帧稳定。虚拟化 renderer 以逻辑视图稳定为完成，不要求物化所有行。',
      longestFrame: 'mount 起点至 full render 完成期间相邻 requestAnimationFrame 的最大间隔。',
      memory: 'CDP Performance.getMetrics 的 JSHeapUsedSize，10ms 轮询；记录绝对峰值与相对 about:blank 基线增量。',
      scroll: '统一 720px 高 viewport，18 帧线性滚到中部，再 18 帧滚到底部；报告帧间隔 P95 与 max。',
      fairness: '两者统一只读 unified、展开全部上下文、关闭字级 diff 与语法高亮；生产 current 仍保留行/chunk 高亮，折叠、双栏、字级能力由 UI 开关触发。',
      lazyBoundary: '生产 current 在计时前仅预热懒加载模块和一个微型 editor；首开模块加载成本不计入 renderer mount，与 spike 候选预加载口径一致。',
    },
    fixtures: activeFixtures,
    aggregate: aggregate(runs, activeRenderers, activeFixtures),
    raw: runs,
  };

  fs.mkdirSync(resultsDir, { recursive: true });
  const output = path.join(resultsDir, '2026-08-17.json');
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${path.relative(workspaceRoot, output)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
