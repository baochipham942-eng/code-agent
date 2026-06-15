import fs from 'node:fs';
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright';
import {
  closeSystemChromeSession,
  formatAcceptanceError,
  getFreePort,
  launchSystemChromeSession,
} from '../acceptance/browser-computer-system-chrome.ts';
import { hasFlag, parseArgs, printJson } from '../acceptance/_helpers.ts';

interface BrowserPerfResult {
  generatedAt: string;
  browser: {
    provider: string;
    executable: string;
    cdpPort: number | null;
    mode: 'headless' | 'visible';
    fallbackReason?: string;
  };
  page: {
    url: string;
    title: string;
  };
  perf: {
    mountMs: number;
    longTaskCount: number;
    longTaskTotalMs: number;
    longTaskMaxMs: number;
    rendered: Record<string, unknown>;
    metrics: Record<string, unknown>;
    longTasks: Array<{ name: string; startTime: number; duration: number }>;
  };
}

const OUT_DIR = path.resolve(process.cwd(), 'docs/perf');
const JSON_OUT = path.join(OUT_DIR, 'chat-render-browser-latest.json');
const MD_OUT = path.join(OUT_DIR, 'chat-render-browser-latest.md');

function usage(): void {
  console.log(`Chat render browser performance smoke

Usage:
  npx tsx scripts/perf/chat-render-browser-smoke.ts [options]

Options:
  --visible       Launch system Chrome in visible mode.
  --keep-browser  Keep Chrome open after the smoke.
  --system-only   Fail instead of falling back to bundled Chromium.
  --json          Print JSON only.
  --help          Show this help.
`);
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
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
        '@main': path.resolve(root, 'src/main'),
        '@renderer': path.resolve(root, 'src/renderer'),
        '@shared': path.resolve(root, 'src/shared'),
        electron: path.resolve(root, 'src/main/platform/index.ts'),
        keytar: path.resolve(root, 'tests/__mocks__/keytar.ts'),
      },
    },
  });

  server.middlewares.use('/__chat-render-browser-perf.html', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Chat Render Browser Perf</title>
    <style>
      :root {
        --color-elevated: #27272a;
        --color-border: #3f3f46;
        --color-surface: #18181b;
        --color-deep: #09090b;
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: #09090b; color: #e4e4e7; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      button { font: inherit; }
      table { border-collapse: collapse; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/scripts/perf/chat-render-browser-harness.tsx"></script>
  </body>
</html>`);
  });

  await server.listen();
  return server;
}

function formatMarkdown(result: BrowserPerfResult): string {
  const timingRows = Object.entries(result.perf.metrics?.timings as Record<string, {
    count: number;
    meanMs: number;
    p95Ms: number;
    maxMs: number;
    lastMs: number;
  }> | undefined ?? {})
    .map(([name, timing]) => `| ${name} | ${timing.count} | ${timing.meanMs} | ${timing.p95Ms} | ${timing.maxMs} | ${timing.lastMs} |`)
    .join('\n');

  return [
    '# Chat Render Browser Performance Smoke',
    '',
    `Generated: ${result.generatedAt}`,
    '',
    '## Browser',
    '',
    `- Provider: ${result.browser.provider}`,
    `- Executable: ${result.browser.executable}`,
    `- Mode: ${result.browser.mode}`,
    `- CDP port: ${result.browser.cdpPort}`,
    ...(result.browser.fallbackReason ? [`- Fallback reason: ${result.browser.fallbackReason}`] : []),
    '',
    '## Rendered Fixture',
    '',
    `- Code blocks: ${String(result.perf.rendered.codeBlocks)}`,
    `- Code lines per block: ${String(result.perf.rendered.codeLinesPerBlock)}`,
    `- Streaming chars: ${String(result.perf.rendered.streamingChars)}`,
    `- Diff lines: ${String(result.perf.rendered.diffLines)}`,
    `- Diff rows rendered: ${String(result.perf.rendered.diffRows)}`,
    '',
    '## Browser Timing',
    '',
    `- Mount settled: ${result.perf.mountMs} ms`,
    `- Long task count: ${result.perf.longTaskCount}`,
    `- Long task total: ${result.perf.longTaskTotalMs} ms`,
    `- Long task max: ${result.perf.longTaskMaxMs} ms`,
    '',
    '## Runtime Metrics Snapshot',
    '',
    '| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |',
    '|---|---:|---:|---:|---:|---:|',
    timingRows || '| none | 0 | 0 | 0 | 0 | 0 |',
    '',
    '## Long Tasks',
    '',
    result.perf.longTasks.length > 0
      ? result.perf.longTasks.map((task) => `- ${task.name}: start=${task.startTime} ms duration=${task.duration} ms`).join('\n')
      : '- none recorded',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  let vite: ViteDevServer | null = null;
  let session: Awaited<ReturnType<typeof launchSystemChromeSession>> | null = null;
  let browser: Browser | null = null;
  let fallbackReason: string | undefined;
  let browserProvider: string | undefined;
  let browserExecutable: string | undefined;
  let browserCdpPort: number | null | undefined;

  try {
    try {
      session = await launchSystemChromeSession({
        profilePrefix: 'code-agent-chat-render-perf-',
        visible: hasFlag(args, 'visible'),
        timeoutMs: 15_000,
      });
      browser = session.browser;
      browserProvider = session.provider;
      browserExecutable = session.executable;
      browserCdpPort = session.port;
    } catch (error) {
      if (hasFlag(args, 'system-only')) {
        throw error;
      }
      fallbackReason = formatAcceptanceError(error).split('\n')[0] || String(error);
      browser = await chromium.launch({ headless: !hasFlag(args, 'visible') });
      browserProvider = 'playwright-bundled';
      browserExecutable = chromium.executablePath();
      browserCdpPort = null;
    }

    if (
      !browser
      || browserProvider === undefined
      || browserExecutable === undefined
      || browserCdpPort === undefined
    ) {
      throw new Error('Browser session did not initialize.');
    }

    vite = await startViteServer();
    const localUrl = vite.resolvedUrls?.local[0];
    if (!localUrl) {
      throw new Error('Vite did not expose a local URL.');
    }
    const pageUrl = new URL('/__chat-render-browser-perf.html', localUrl).toString();

    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-chat-perf-ready="true"]', { timeout: 60_000 });

    const raw = await page.evaluate(() => window.__CHAT_RENDER_BROWSER_RESULT__);
    if (!raw) {
      throw new Error('Browser harness did not publish __CHAT_RENDER_BROWSER_RESULT__.');
    }

    const longTasks = raw.longTasks ?? [];
    const longTaskTotalMs = roundMs(longTasks.reduce((sum, task) => sum + task.duration, 0));
    const longTaskMaxMs = longTasks.length > 0
      ? roundMs(Math.max(...longTasks.map((task) => task.duration)))
      : 0;

    const result: BrowserPerfResult = {
      generatedAt: new Date().toISOString(),
      browser: {
        provider: browserProvider,
        executable: browserExecutable,
        cdpPort: browserCdpPort,
        mode: hasFlag(args, 'visible') ? 'visible' : 'headless',
        fallbackReason,
      },
      page: {
        url: page.url(),
        title: await page.title(),
      },
      perf: {
        mountMs: raw.mountMs,
        longTaskCount: longTasks.length,
        longTaskTotalMs,
        longTaskMaxMs,
        rendered: raw.rendered,
        metrics: raw.metrics,
        longTasks,
      },
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(JSON_OUT, `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(MD_OUT, formatMarkdown(result));

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      console.log(`Wrote ${path.relative(process.cwd(), JSON_OUT)}`);
      console.log(`Wrote ${path.relative(process.cwd(), MD_OUT)}`);
      console.log(`mount=${result.perf.mountMs}ms longTasks=${result.perf.longTaskCount} longTaskMax=${result.perf.longTaskMaxMs}ms`);
    }
  } finally {
    if (!hasFlag(args, 'keep-browser')) {
      if (browser) {
        await browser.close().catch(() => undefined);
      }
      if (session) {
        await closeSystemChromeSession(session).catch(() => undefined);
      }
    }
    if (vite) {
      await vite.close().catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(formatAcceptanceError(error));
  process.exit(1);
});
