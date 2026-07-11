import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright';

const OUT_DIR = path.resolve(process.cwd(), 'docs/perf');
const JSON_OUT = path.join(OUT_DIR, 'long-session-gold-latest.json');

function gitHead(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
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
  server.middlewares.use('/__long-session-gold.html', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Neo Long Session Gold</title><style>*{box-sizing:border-box}body{margin:0}</style></head><body><div id="root"></div><script type="module" src="/scripts/perf/long-session-browser-harness.tsx"></script></body></html>`);
  });
  await server.listen();
  return server;
}

async function main(): Promise<void> {
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  try {
    server = await startViteServer();
    browser = await chromium.launch({
      channel: process.env.E2E_BROWSER_CHANNEL || 'chrome',
      headless: true,
      args: ['--enable-precise-memory-info'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const base = server.resolvedUrls?.local[0];
    if (!base) throw new Error('Vite did not expose a local URL.');
    await page.goto(new URL('/__long-session-gold.html', base).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-long-session-ready="true"]', { timeout: 120_000 });
    const browserResult = await page.evaluate(() => window.__LONG_SESSION_RESULT__);
    if (!browserResult) throw new Error('Long-session harness did not publish a result.');

    const gates = {
      turns500Interactive: browserResult.scenarios.turns500.interactiveMs <= 2_000,
      anchorDrift: typeof browserResult.scenarios.historyPrepend.anchorDriftPx === 'number'
        && Number.isFinite(browserResult.scenarios.historyPrepend.anchorDriftPx)
        && browserResult.scenarios.historyPrepend.anchorDriftPx <= 16,
      userScroll: browserResult.scenarios.userScroll.retainedPosition,
      streamingFollow: browserResult.scenarios.streamingFollow.resumedAtBottom,
      search: browserResult.scenarios.search.targetMounted && browserResult.scenarios.search.targetVisible,
      mainThread: browserResult.mainThread.over500ms === 0,
      memoryRecorded: browserResult.memory.supported,
    };
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: {
        gitHead: gitHead(),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        cpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        browser: await browser.version(),
        viewport: { width: 1440, height: 900 },
      },
      thresholds: {
        turns500InteractiveMs: 2_000,
        anchorDriftPx: 16,
        mainThreadLongTaskMs: 500,
      },
      stopEvidence: {
        includedInThisReport: false,
        reason: 'The browser harness only simulates renderer state. Real stop gates are tool-cancel and app-host smokes.',
        requiredSmokes: [
          'scripts/acceptance/tool-cancel-smoke.ts',
          'scripts/acceptance/agent-runtime-app-host-smoke.ts',
        ],
      },
      ...browserResult,
      gates,
      passed: Object.values(gates).every(Boolean),
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
