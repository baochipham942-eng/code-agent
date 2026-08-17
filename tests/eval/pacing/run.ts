import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { pacingFixtures } from './fixtures';
import type { HarnessResult, PacingMode, PipelineMode } from './src';

// Headless Chromium occasionally leaves document.fonts.ready pending forever even though
// this harness declares no web fonts. Playwright exposes this screenshot-only guard; it does
// not change rAF, React scheduling, rendering, or any measured interval.
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';

const root = path.resolve(import.meta.dirname, '../../..');
const artifactDir = path.join(import.meta.dirname, 'artifacts');
const screenshotDir = path.join(artifactDir, 'screenshots');
const baseUrl = 'http://127.0.0.1:4178';

interface RunSummary {
  fixtureId: string;
  label: string;
  mode: PacingMode;
  pipeline: PipelineMode;
  chars: number;
  chunks: number;
  chunkSize: number;
  intervalMs: number;
  latencyP50: number;
  latencyP95: number;
  convergenceMs: number;
  droppedFrames: number;
  longestFrameMs: number;
  longestTaskMs: number;
  profilerActualMs: number;
  flushCount: number;
  batcherTextPathCalls: number;
  stage?: {
    accumulatorWaitMs: number;
    accumulatorWaitShare: number;
    flushCpuMs: number;
    flushCpuShare: number;
    messageBatcherMs: number;
    messageBatcherShare: number;
    reactCommitMs: number;
    reactCommitShare: number;
    smoothAndMarkdownMs: number;
    smoothAndMarkdownShare: number;
    paintMs: number;
    paintShare: number;
    endToEndMs: number;
  };
  screenshots: string[];
}

function fixed(value: number): number {
  return Number(value.toFixed(2));
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

function partitionStages(result: HarnessResult) {
  let cumulativeLength = 0;
  const rows = result.flushes.flatMap((flush) => {
    cumulativeLength += flush.charCount;
    const targetCommit = result.profiler.find((sample) => sample.commitTime >= flush.endedAt);
    const visiblePaint = result.paints.find((sample) => sample.contentLength >= cumulativeLength && (!targetCommit || sample.commitAt >= targetCommit.commitTime));
    if (!targetCommit || !visiblePaint) return [];
    const endToEndMs = Math.max(0, visiblePaint.paintAt - flush.firstArrivalAt);
    const accumulatorWaitMs = Math.max(0, flush.startedAt - flush.firstArrivalAt);
    const flushCpuMs = Math.max(0, flush.endedAt - flush.startedAt);
    const reactCommitMs = Math.max(0, targetCommit.commitTime - flush.endedAt);
    const smoothAndMarkdownMs = Math.max(0, visiblePaint.commitAt - targetCommit.commitTime);
    const paintMs = Math.max(0, visiblePaint.paintAt - visiblePaint.commitAt);
    return [{ accumulatorWaitMs, flushCpuMs, reactCommitMs, smoothAndMarkdownMs, paintMs, endToEndMs }];
  });
  const total = (key: keyof (typeof rows)[number]) => rows.reduce((sum, row) => sum + row[key], 0);
  const endToEndMs = total('endToEndMs');
  const share = (value: number) => endToEndMs > 0 ? value / endToEndMs : 0;
  const accumulatorWaitMs = total('accumulatorWaitMs');
  const flushCpuMs = total('flushCpuMs');
  const reactCommitMs = total('reactCommitMs');
  const smoothAndMarkdownMs = total('smoothAndMarkdownMs');
  const paintMs = total('paintMs');
  return {
    accumulatorWaitMs: fixed(accumulatorWaitMs / Math.max(rows.length, 1)),
    accumulatorWaitShare: fixed(share(accumulatorWaitMs) * 100),
    flushCpuMs: fixed(flushCpuMs / Math.max(rows.length, 1)),
    flushCpuShare: fixed(share(flushCpuMs) * 100),
    messageBatcherMs: 0,
    messageBatcherShare: 0,
    reactCommitMs: fixed(reactCommitMs / Math.max(rows.length, 1)),
    reactCommitShare: fixed(share(reactCommitMs) * 100),
    smoothAndMarkdownMs: fixed(smoothAndMarkdownMs / Math.max(rows.length, 1)),
    smoothAndMarkdownShare: fixed(share(smoothAndMarkdownMs) * 100),
    paintMs: fixed(paintMs / Math.max(rows.length, 1)),
    paintShare: fixed(share(paintMs) * 100),
    endToEndMs: fixed(endToEndMs / Math.max(rows.length, 1)),
  };
}

async function waitForPaint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function runOne(
  page: Page,
  fixture: (typeof pacingFixtures)[number],
  mode: PacingMode,
  pipeline: PipelineMode,
  capture: boolean,
): Promise<RunSummary> {
  await page.evaluate(({ selectedMode, selectedPipeline }) => {
    window.pacing?.reset({ mode: selectedMode, pipeline: selectedPipeline });
  }, { selectedMode: mode, selectedPipeline: pipeline });
  await waitForPaint(page);

  const screenshots: string[] = [];
  const thresholds = capture ? [0.25, 0.5, 0.75] : [];
  let nextThreshold = 0;
  let chunks = 0;
  for (let offset = 0; offset < fixture.content.length; offset += fixture.chunkSize) {
    const chunk = fixture.content.slice(offset, offset + fixture.chunkSize);
    await page.evaluate((value) => window.pacing?.push(value), chunk);
    chunks += 1;
    const ratio = Math.min(1, (offset + chunk.length) / fixture.content.length);
    if (nextThreshold < thresholds.length && ratio >= thresholds[nextThreshold]) {
      await waitForPaint(page);
      const name = `${fixture.id}-${mode}-frame-${nextThreshold + 1}.png`;
      await page.screenshot({ path: path.join(screenshotDir, name), fullPage: true });
      screenshots.push(`screenshots/${name}`);
      nextThreshold += 1;
    }
    await page.waitForTimeout(fixture.intervalMs);
  }

  const raw = await page.evaluate(() => window.pacing!.stop());
  await waitForPaint(page);
  if (capture) {
    const name = `${fixture.id}-${mode}-frame-4.png`;
    await page.screenshot({ path: path.join(screenshotDir, name), fullPage: true });
    screenshots.push(`screenshots/${name}`);
  }
  const latencies = raw.arrivalTimes.map((arrivalAt, index) => (raw.visibleTimes[index] ?? raw.convergedAt) - arrivalAt);
  const droppedFrames = raw.rafGaps.reduce((count, gap) => count + Math.max(0, Math.floor(gap / 16.67) - 1), 0);
  return {
    fixtureId: fixture.id,
    label: fixture.label,
    mode,
    pipeline,
    chars: fixture.content.length,
    chunks,
    chunkSize: fixture.chunkSize,
    intervalMs: fixture.intervalMs,
    latencyP50: fixed(percentile(latencies, 0.5)),
    latencyP95: fixed(percentile(latencies, 0.95)),
    convergenceMs: fixed(raw.convergedAt - raw.inputStoppedAt),
    droppedFrames,
    longestFrameMs: fixed(Math.max(0, ...raw.rafGaps)),
    longestTaskMs: fixed(Math.max(0, ...raw.longTasks)),
    profilerActualMs: fixed(raw.profiler.reduce((sum, sample) => sum + sample.actualDuration, 0)),
    flushCount: raw.flushes.length,
    batcherTextPathCalls: raw.batcherTextPathCalls,
    stage: pipeline === 'production' ? partitionStages(raw) : undefined,
    screenshots,
  };
}

async function main() {
  await mkdir(screenshotDir, { recursive: true });
  const server = spawn(path.join(root, 'node_modules/.bin/vite'), ['--config', path.join(import.meta.dirname, 'vite.config.ts')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += String(chunk); });
  server.stderr.on('data', (chunk) => { serverLog += String(chunk); });

  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(baseUrl);
        if (response.ok) break;
      } catch { /* server is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (Date.now() >= deadline) throw new Error(`Vite did not start:\n${serverLog}`);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', reducedMotion: 'no-preference' });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.pacing));

    const partA: RunSummary[] = [];
    for (const fixture of pacingFixtures) {
      process.stdout.write(`[pacing] Part A ${fixture.id}\n`);
      partA.push(await runOne(page, fixture, 'smooth', 'production', false));
    }

    const partB: RunSummary[] = [];
    for (const fixture of pacingFixtures) {
      for (const mode of ['smooth', 'direct'] as const) {
        process.stdout.write(`[pacing] Part B ${fixture.id} ${mode}\n`);
        partB.push(await runOne(page, fixture, mode, 'comparison', true));
      }
    }

    const userAgent = await page.evaluate(() => navigator.userAgent);
    await browser.close();
    const output = {
      metadata: {
        generatedAt: new Date().toISOString(),
        userAgent,
        accumulatorThrottleMs: 150,
        messageBatcherConfiguredMs: 50,
        markdownThrottleMs: 96,
        visibilityDefinition: 'source prefix admitted to the production Markdown renderer and followed by a requestAnimationFrame paint opportunity',
      },
      partA,
      partB,
    };
    await writeFile(path.join(artifactDir, 'results.json'), `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`[pacing] wrote ${path.join(artifactDir, 'results.json')}\n`);
  } finally {
    server.kill('SIGTERM');
  }
}

await main();
