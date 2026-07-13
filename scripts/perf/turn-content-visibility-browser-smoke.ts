import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';

interface Sample {
  initialRenderMs: number;
  scrollRenderMs: number;
  mountedTurns: number;
  deferredContentBlocks: number;
  computedStyle: {
    contentVisibility: string;
    containIntrinsicSize: string;
    scrollerScrollBehavior: string;
  };
  streamingPerformanceMetrics: {
    timings: Record<string, { meanMs: number; p95Ms: number; count: number }>;
  };
}

const RUNS_PER_MODE = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function startViteServer(): Promise<ViteDevServer> {
  const root = process.cwd();
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    logLevel: 'error',
    root,
    server: { host: '127.0.0.1', port: 0, hmr: false },
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
  server.middlewares.use('/__turn-content-visibility.html', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0}
      html[data-content-visibility="off"] [data-turn-heavy-content="true"]{
        content-visibility:visible!important;contain-intrinsic-size:none!important
      }
    </style></head><body><div id="root"></div><script type="module" src="/scripts/perf/turn-content-visibility-browser-harness.tsx"></script></body></html>`);
  });
  await server.listen();
  return server;
}

async function runSample(page: Page, base: string, mode: 'before' | 'after'): Promise<Sample> {
  await page.goto(
    new URL(`/__turn-content-visibility.html?mode=${mode}`, base).toString(),
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForSelector('body[data-turn-content-visibility-ready="true"]', { timeout: 120_000 });
  const result = await page.evaluate(() => window.__TURN_CONTENT_VISIBILITY_RESULT__);
  if (!result) throw new Error(`Harness did not publish a ${mode} result.`);
  return result;
}

async function main(): Promise<void> {
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  try {
    server = await startViteServer();
    browser = await chromium.launch({
      channel: process.env.E2E_BROWSER_PATH ? undefined : (process.env.E2E_BROWSER_CHANNEL || 'chrome'),
      executablePath: process.env.E2E_BROWSER_PATH,
      headless: true,
    });
    const base = server.resolvedUrls?.local[0];
    if (!base) throw new Error('Vite did not expose a local URL.');

    const samples: Record<'before' | 'after', Sample[]> = { before: [], after: [] };
    for (let run = 0; run < RUNS_PER_MODE; run += 1) {
      for (const mode of ['before', 'after'] as const) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        samples[mode].push(await runSample(page, base, mode));
        await page.close();
      }
    }

    const beforeInitial = median(samples.before.map((sample) => sample.initialRenderMs));
    const afterInitial = median(samples.after.map((sample) => sample.initialRenderMs));
    const beforeScroll = median(samples.before.map((sample) => sample.scrollRenderMs));
    const afterScroll = median(samples.after.map((sample) => sample.scrollRenderMs));
    const afterStyle = samples.after[0]?.computedStyle;
    const report = {
      methodology: 'Median of 3 alternating real-Chrome runs over the same 500-turn TurnBasedTraceView.',
      note: 'stream.markdown.render_ms measures React markdown work; frame timings include browser layout/paint where content-visibility applies.',
      before: { initialRenderMs: beforeInitial, scrollRenderMs: beforeScroll },
      after: { initialRenderMs: afterInitial, scrollRenderMs: afterScroll },
      delta: {
        initialRenderMs: Math.round((afterInitial - beforeInitial) * 1_000) / 1_000,
        scrollRenderMs: Math.round((afterScroll - beforeScroll) * 1_000) / 1_000,
      },
      cssEvidence: afterStyle,
      mountedEvidence: {
        turns: samples.after[0]?.mountedTurns ?? 0,
        deferredContentBlocks: samples.after[0]?.deferredContentBlocks ?? 0,
      },
      streamingPerformanceMetrics: {
        before: samples.before.map((sample) => sample.streamingPerformanceMetrics.timings['stream.markdown.render_ms']),
        after: samples.after.map((sample) => sample.streamingPerformanceMetrics.timings['stream.markdown.render_ms']),
      },
      samples,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    const cssApplied = afterStyle?.contentVisibility === 'auto'
      && afterStyle.containIntrinsicSize.includes('320px');
    const scrollBehaviorSafe = samples.after.every(
      (sample) => sample.computedStyle.scrollerScrollBehavior === 'auto',
    );
    if (!cssApplied || !scrollBehaviorSafe || report.mountedEvidence.deferredContentBlocks === 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
