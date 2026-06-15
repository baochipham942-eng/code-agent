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

interface CodeHighlightPhase {
  durationMs: number;
  longTasks: Array<{ name: string; startTime: number; duration: number }>;
  rendered: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

interface CodeHighlightResult {
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
    collapsedBlocks: number;
    collapsedLinesPerBlock: number;
    expandLines: number[];
  };
  initial: CodeHighlightPhase & {
    longTaskCount: number;
    longTaskTotalMs: number;
    longTaskMaxMs: number;
  };
  expand1000: CodeHighlightPhase & {
    longTaskCount: number;
    longTaskTotalMs: number;
    longTaskMaxMs: number;
  };
  expand5000: CodeHighlightPhase & {
    longTaskCount: number;
    longTaskTotalMs: number;
    longTaskMaxMs: number;
  };
}

const OUT_DIR = path.resolve(process.cwd(), 'docs/perf');
const JSON_OUT = path.join(OUT_DIR, 'code-highlight-browser-latest.json');
const MD_OUT = path.join(OUT_DIR, 'code-highlight-browser-latest.md');

function usage(): void {
  console.log(`Code highlight browser performance smoke

Usage:
  npx tsx scripts/perf/code-highlight-browser-smoke.ts [options]

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

function summarizeLongTasks(tasks: CodeHighlightPhase['longTasks']): {
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
        '@main': path.resolve(root, 'src/main'),
        '@renderer': path.resolve(root, 'src/renderer'),
        '@shared': path.resolve(root, 'src/shared'),
        electron: path.resolve(root, 'src/main/platform/index.ts'),
        keytar: path.resolve(root, 'tests/__mocks__/keytar.ts'),
      },
    },
  });

  server.middlewares.use('/__code-highlight-browser-perf.html', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Code Highlight Browser Perf</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #09090b; color: #e4e4e7; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      button { font: inherit; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/scripts/perf/code-highlight-browser-harness.tsx"></script>
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

function formatLongTasks(tasks: CodeHighlightPhase['longTasks']): string {
  return tasks.length > 0
    ? tasks.map((task) => `- ${task.name}: start=${task.startTime} ms duration=${task.duration} ms`).join('\n')
    : '- none recorded';
}

function formatPhase(name: string, phase: CodeHighlightResult['initial']): string[] {
  return [
    `## ${name}`,
    '',
    `- Duration: ${phase.durationMs} ms`,
    `- Rendered: ${JSON.stringify(phase.rendered)}`,
    `- Long task count: ${phase.longTaskCount}`,
    `- Long task total: ${phase.longTaskTotalMs} ms`,
    `- Long task max: ${phase.longTaskMaxMs} ms`,
    '',
    '| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |',
    '|---|---:|---:|---:|---:|---:|',
    formatTimingRows(phase.metrics) || '| none | 0 | 0 | 0 | 0 | 0 |',
    '',
    'Long tasks:',
    '',
    formatLongTasks(phase.longTasks),
    '',
  ];
}

function formatMarkdown(result: CodeHighlightResult): string {
  return [
    '# Code Highlight Browser Performance Smoke',
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
    `- Collapsed blocks: ${result.fixture.collapsedBlocks}`,
    `- Collapsed lines per block: ${result.fixture.collapsedLinesPerBlock}`,
    `- Expand lines: ${result.fixture.expandLines.join(', ')}`,
    '',
    ...formatPhase('Initial Collapsed Render', result.initial),
    ...formatPhase('Expand 1000 Lines', result.expand1000),
    ...formatPhase('Expand 5000 Lines', result.expand5000),
  ].join('\n');
}

async function collectPhase(page: Awaited<ReturnType<Browser['newPage']>>, startedAt: number): Promise<CodeHighlightPhase> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    window.setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 100);
  }));
  const phase = await page.evaluate((value) => window.__CODE_HIGHLIGHT_BROWSER_COLLECT__?.(value), startedAt);
  if (!phase) {
    throw new Error('Code highlight harness did not publish phase data.');
  }
  return phase;
}

async function expandFixture(page: Awaited<ReturnType<Browser['newPage']>>, fixture: 'expand-1000' | 'expand-5000'): Promise<CodeHighlightPhase> {
  await page.evaluate(() => window.__CODE_HIGHLIGHT_BROWSER_RESET__?.());
  const startedAt = await page.evaluate(() => performance.now());
  await page.locator(`[data-code-fixture="${fixture}"] button`).filter({ hasText: '展开全部' }).click({ timeout: 60_000 });
  const expectedText = fixture === 'expand-1000' ? 'expand_1000_1000' : 'expand_5000_5000';
  await page.waitForFunction((text) => document.body.textContent?.includes(text), expectedText, { timeout: 120_000 });
  await page.waitForFunction((selector) => (
    document.querySelector(selector)?.getAttribute('data-code-highlight-complete') === 'true'
  ), `[data-code-fixture="${fixture}"] [data-code-block-lines]`, { timeout: 180_000 });
  return collectPhase(page, startedAt);
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
        profilePrefix: 'code-agent-code-highlight-perf-',
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
    const pageUrl = new URL('/__code-highlight-browser-perf.html', localUrl).toString();

    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-code-highlight-ready="true"]', { timeout: 120_000 });

    const initialRaw = await page.evaluate(() => window.__CODE_HIGHLIGHT_BROWSER_INITIAL__);
    if (!initialRaw) {
      throw new Error('Code highlight harness did not publish initial data.');
    }
    const expand1000Raw = await expandFixture(page, 'expand-1000');
    const expand5000Raw = await expandFixture(page, 'expand-5000');

    const result: CodeHighlightResult = {
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
        collapsedBlocks: 10,
        collapsedLinesPerBlock: 500,
        expandLines: [1_000, 5_000],
      },
      initial: {
        ...initialRaw,
        ...summarizeLongTasks(initialRaw.longTasks ?? []),
      },
      expand1000: {
        ...expand1000Raw,
        ...summarizeLongTasks(expand1000Raw.longTasks ?? []),
      },
      expand5000: {
        ...expand5000Raw,
        ...summarizeLongTasks(expand5000Raw.longTasks ?? []),
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
        `initial=${result.initial.durationMs}ms expand1000=${result.expand1000.durationMs}ms expand1000LongTaskMax=${result.expand1000.longTaskMaxMs}ms expand5000=${result.expand5000.durationMs}ms expand5000LongTaskMax=${result.expand5000.longTaskMaxMs}ms`,
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
