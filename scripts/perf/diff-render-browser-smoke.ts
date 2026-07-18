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

interface DiffRenderPhase {
  durationMs: number;
  longTasks: Array<{ name: string; startTime: number; duration: number }>;
  rows: Record<string, number>;
  metrics: Record<string, unknown>;
}

interface DiffRenderBrowserResult {
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
  fixture: {
    singleDiffLines: number;
    summaryFiles: number;
    summaryLinesPerFile: number;
  };
  initial: DiffRenderPhase & {
    longTaskCount: number;
    longTaskTotalMs: number;
    longTaskMaxMs: number;
  };
  summaryExpansion: DiffRenderPhase & {
    expandedFiles: number;
    longTaskCount: number;
    longTaskTotalMs: number;
    longTaskMaxMs: number;
  };
}

const OUT_DIR = path.resolve(process.cwd(), 'docs/perf');
const JSON_OUT = path.join(OUT_DIR, 'diff-render-browser-latest.json');
const MD_OUT = path.join(OUT_DIR, 'diff-render-browser-latest.md');

function usage(): void {
  console.log(`Diff render browser performance smoke

Usage:
  npx tsx scripts/perf/diff-render-browser-smoke.ts [options]

Options:
  --visible       Launch browser in visible mode.
  --keep-browser  Keep browser open after the smoke.
  --system-only   Fail instead of falling back to bundled Chromium.
  --json          Print JSON only.
  --help          Show this help.
`);
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summarizeLongTasks(tasks: DiffRenderPhase['longTasks']): {
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
} {
  return {
    longTaskCount: tasks.length,
    longTaskTotalMs: roundMs(tasks.reduce((sum, task) => sum + task.duration, 0)),
    longTaskMaxMs: tasks.length > 0
      ? roundMs(Math.max(...tasks.map((task) => task.duration)))
      : 0,
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

  server.middlewares.use('/__diff-render-browser-perf.html', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Diff Render Browser Perf</title>
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
    <script type="module" src="/scripts/perf/diff-render-browser-harness.tsx"></script>
  </body>
</html>`);
  });

  await server.listen();
  return server;
}

function formatTimingRows(metrics: Record<string, unknown>): string {
  const timings = (metrics.timings ?? {}) as Record<string, {
    count: number;
    meanMs: number;
    p95Ms: number;
    maxMs: number;
    lastMs: number;
  }>;
  return Object.entries(timings)
    .map(([name, timing]) => `| ${name} | ${timing.count} | ${timing.meanMs} | ${timing.p95Ms} | ${timing.maxMs} | ${timing.lastMs} |`)
    .join('\n');
}

function formatLongTasks(tasks: DiffRenderPhase['longTasks']): string {
  return tasks.length > 0
    ? tasks.map((task) => `- ${task.name}: start=${task.startTime} ms duration=${task.duration} ms`).join('\n')
    : '- none recorded';
}

function formatMarkdown(result: DiffRenderBrowserResult): string {
  return [
    '# Diff Render Browser Performance Smoke',
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
    '## Fixture',
    '',
    `- Single diff lines: ${result.fixture.singleDiffLines}`,
    `- Summary files: ${result.fixture.summaryFiles}`,
    `- Summary lines per file: ${result.fixture.summaryLinesPerFile}`,
    '',
    '## Initial Single Diff',
    '',
    `- Duration: ${result.initial.durationMs} ms`,
    `- Rows: ${JSON.stringify(result.initial.rows)}`,
    `- Long task count: ${result.initial.longTaskCount}`,
    `- Long task total: ${result.initial.longTaskTotalMs} ms`,
    `- Long task max: ${result.initial.longTaskMaxMs} ms`,
    '',
    '## TurnDiffSummary Expansion',
    '',
    `- Expanded files: ${result.summaryExpansion.expandedFiles}`,
    `- Duration: ${result.summaryExpansion.durationMs} ms`,
    `- Rows: ${JSON.stringify(result.summaryExpansion.rows)}`,
    `- Long task count: ${result.summaryExpansion.longTaskCount}`,
    `- Long task total: ${result.summaryExpansion.longTaskTotalMs} ms`,
    `- Long task max: ${result.summaryExpansion.longTaskMaxMs} ms`,
    '',
    '## Initial Runtime Metrics',
    '',
    '| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |',
    '|---|---:|---:|---:|---:|---:|',
    formatTimingRows(result.initial.metrics) || '| none | 0 | 0 | 0 | 0 | 0 |',
    '',
    '## Expansion Runtime Metrics',
    '',
    '| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |',
    '|---|---:|---:|---:|---:|---:|',
    formatTimingRows(result.summaryExpansion.metrics) || '| none | 0 | 0 | 0 | 0 | 0 |',
    '',
    '## Initial Long Tasks',
    '',
    formatLongTasks(result.initial.longTasks),
    '',
    '## Expansion Long Tasks',
    '',
    formatLongTasks(result.summaryExpansion.longTasks),
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
        profilePrefix: 'code-agent-diff-render-perf-',
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
    const pageUrl = new URL('/__diff-render-browser-perf.html', localUrl).toString();

    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-diff-render-ready="true"]', { timeout: 60_000 });

    const initialRaw = await page.evaluate(() => window.__DIFF_RENDER_BROWSER_INITIAL__);
    if (!initialRaw) {
      throw new Error('Diff render harness did not publish initial result.');
    }

    await page.evaluate(() => window.__DIFF_RENDER_BROWSER_RESET__?.());
    const expansionStartedAt = await page.evaluate(() => performance.now());
    const fileButtons = page.locator('[data-diff-summary-smoke] button').filter({ hasText: 'browser-file-' });
    const buttonCount = await fileButtons.count();
    for (let index = 0; index < Math.min(3, buttonCount); index += 1) {
      await fileButtons.nth(index).click();
    }
    await page.waitForFunction(() => (
      document.querySelectorAll('[data-diff-summary-smoke] .diff-view tbody tr').length >= 6_000
    ), { timeout: 60_000 });
    await page.evaluate(() => new Promise<void>((resolve) => {
      window.setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 100);
    }));
    const expansionRaw = await page.evaluate((startedAt) => (
      window.__DIFF_RENDER_BROWSER_COLLECT__?.(startedAt)
    ), expansionStartedAt);
    if (!expansionRaw) {
      throw new Error('Diff render harness did not publish expansion result.');
    }

    const result: DiffRenderBrowserResult = {
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
      fixture: {
        singleDiffLines: 5_000,
        summaryFiles: 3,
        summaryLinesPerFile: 1_000,
      },
      // Harness-side metrics field is a concrete StreamingPerformanceSnapshot; report-side
      // type widens it to an opaque JSON blob.
      initial: {
        ...(initialRaw as unknown as DiffRenderPhase),
        ...summarizeLongTasks(initialRaw.longTasks ?? []),
      },
      summaryExpansion: {
        ...(expansionRaw as unknown as DiffRenderPhase),
        expandedFiles: Math.min(3, buttonCount),
        ...summarizeLongTasks(expansionRaw.longTasks ?? []),
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
      console.log(
        `initial=${result.initial.durationMs}ms initialLongTaskMax=${result.initial.longTaskMaxMs}ms expansion=${result.summaryExpansion.durationMs}ms expansionLongTaskMax=${result.summaryExpansion.longTaskMaxMs}ms`,
      );
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
