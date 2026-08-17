import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { getFreePort } from '../acceptance/browser-computer-system-chrome';

const scenarios = [
  ['live', '01-streaming-expanded.png'],
  ['collapsed', '02-collapsed-with-duration.png'],
  ['none', '03-no-reasoning-provider.png'],
] as const;

async function main(): Promise<void> {
  const outputDirectory = path.resolve(process.argv[2] || path.join(process.cwd(), 'docs/evidence/thinkflow'));
  const port = await getFreePort();
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;

  try {
    fs.mkdirSync(outputDirectory, { recursive: true });
    vite = await createServer({
      appType: 'custom',
      configFile: false,
      logLevel: 'error',
      root: process.cwd(),
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
      resolve: {
        alias: {
          '@': path.resolve('src'),
          '@host': path.resolve('src/host'),
          '@renderer': path.resolve('src/renderer'),
          '@shared': path.resolve('src/shared'),
          electron: path.resolve('src/host/platform/index.ts'),
          keytar: path.resolve('tests/__mocks__/keytar.ts'),
        },
      },
    });
    vite.middlewares.use('/__thinkflow-evidence.html', (_request, response) => {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Thinkflow evidence</title><style>*{box-sizing:border-box}body{margin:0}</style></head>
        <body><div id="root"></div><script type="module" src="/scripts/perf/thinkflow-evidence-harness.tsx"></script></body></html>`);
    });
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 620 }, deviceScaleFactor: 2 });

    for (const [scenario, filename] of scenarios) {
      await page.goto(`http://127.0.0.1:${port}/__thinkflow-evidence.html?scenario=${scenario}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForSelector(`body[data-thinkflow-evidence-ready="true"][data-scenario="${scenario}"]`);
      if (scenario === 'live') {
        await page.waitForSelector('[data-testid="thinking-digest"] button[aria-expanded="true"]');
        await page.waitForFunction(() => {
          const title = document.querySelector('.streaming-thinking-shimmer');
          return title && getComputedStyle(title).backgroundImage !== 'none';
        });
      } else if (scenario === 'collapsed') {
        await page.waitForSelector('[data-testid="thinking-digest"] button[aria-expanded="false"]');
      } else if (await page.locator('[data-testid="thinking-digest"]').count() !== 0) {
        throw new Error('No-reasoning scenario unexpectedly rendered a thinking digest.');
      }
      await page.waitForTimeout(250);
      await page.locator('[data-testid="evidence-card"]').screenshot({
        path: path.join(outputDirectory, filename),
      });
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await vite?.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
