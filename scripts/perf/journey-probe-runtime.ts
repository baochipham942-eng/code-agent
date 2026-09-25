import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright';
import {
  isJourneyId,
  type JourneyId,
  type JourneyProbeResult,
} from './journey-probe-protocol';

export const JOURNEY_HARNESS: Record<JourneyId, string> = {
  'cold-start': '/scripts/perf/journey-cold-start-harness.tsx',
  'first-token': '/scripts/perf/journey-first-token-harness.tsx',
  'long-session': '/scripts/perf/journey-long-session-harness.tsx',
  'session-switch': '/scripts/perf/journey-session-switch-harness.tsx',
};

export async function startJourneyViteServer(root = process.cwd()): Promise<ViteDevServer> {
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

  server.middlewares.use((req, res, next) => {
    const url = req.url ? new URL(req.url, 'http://127.0.0.1') : null;
    const match = url?.pathname.match(/^\/__perf-journey-([a-z0-9-]+)\.html$/);
    if (!match) {
      next();
      return;
    }
    const journey = match[1];
    if (!isJourneyId(journey)) {
      res.statusCode = 404;
      res.end('unknown journey');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Perf journey ${journey}</title>
    <style>
      * { box-sizing: border-box; }
      html, body, #root { margin: 0; height: 100%; }
      body { background: #09090b; color: #e4e4e7; font-family: ui-sans-serif, system-ui, sans-serif; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${JOURNEY_HARNESS[journey]}"></script>
  </body>
</html>`);
  });

  await server.listen();
  return server;
}

export async function launchJourneyBrowser(): Promise<Browser> {
  const channel = process.env.E2E_BROWSER_CHANNEL;
  try {
    return await chromium.launch({
      channel: channel || 'chrome',
      headless: true,
    });
  } catch (error) {
    if (channel) throw error;
    return chromium.launch({ headless: true });
  }
}

export async function measureJourney(options: {
  journey: JourneyId;
  extraRenders?: number;
  server: ViteDevServer;
  browser: Browser;
}): Promise<JourneyProbeResult> {
  const base = options.server.resolvedUrls?.local[0];
  if (!base) throw new Error('Vite did not expose a local URL.');
  const extraRenders = options.extraRenders ?? 0;
  const pageUrl = new URL(`/__perf-journey-${options.journey}.html`, base);
  if (extraRenders > 0) pageUrl.searchParams.set('extraRenders', String(extraRenders));

  const context = await options.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  try {
    await page.goto(pageUrl.toString(), { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector(`body[data-perf-journey-ready="${options.journey}"]`, { timeout: 60_000 });
    } catch (error) {
      const harnessError = await page.evaluate(() => document.body.getAttribute('data-perf-journey-error'));
      const detail = [harnessError, ...pageErrors].filter(Boolean).join('\n');
      throw new Error(`Journey ${options.journey} did not become ready.${detail ? `\n${detail}` : ''}`, { cause: error });
    }
    const result = await page.evaluate(() => window.__PERF_JOURNEY_RESULT__);
    if (!result) throw new Error(`Journey ${options.journey} did not publish a result.`);
    if (result.journey !== options.journey) {
      throw new Error(`Journey mismatch: harness published ${result.journey}, requested ${options.journey}`);
    }
    return result;
  } finally {
    await context.close().catch(() => undefined);
  }
}
