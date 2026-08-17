import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtures, type MarkdownFixture } from './fixtures';

type Side = 'neo' | 'streamdown';
type ChunkMethod = 'random-5-30' | 'boundary';

interface RunResult {
  fixtureId: string;
  family: MarkdownFixture['family'];
  purpose: string;
  chars: number;
  method: ChunkMethod;
  side: Side;
  logicalCadenceMs: 150;
  frameCount: number;
  terminalEqual: boolean;
  terminalDiffHint: string | null;
  rawMarkdownFrames: number;
  rawMarkdownRatio: number;
  layoutJumpCount: number;
  renderMsP50: number;
  renderMsP95: number;
  renderMsMax: number;
  renderMsTotal: number;
  crashed: boolean;
  error: string | null;
  anomalyScreenshot: string | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(here, 'artifacts');
const screenshotDir = path.join(outputDir, 'screenshots');
const seed = 0x4e454f;

function mulberry32(initial: number): () => number {
  let value = initial >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function randomChunks(content: string, fixtureIndex: number): string[] {
  const random = mulberry32(seed + fixtureIndex);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    const length = 5 + Math.floor(random() * 26);
    chunks.push(content.slice(offset, offset + length));
    offset += length;
  }
  return chunks;
}

function boundaryChunks(content: string): string[] {
  const tokens = content.match(/\n+|[^\s\n]+[ \t]*|[ \t]+/g) ?? [content];
  const chunks: string[] = [];
  let pending = '';
  for (const token of tokens) {
    pending += token;
    if (pending.length >= 18 || token.includes('\n')) {
      chunks.push(pending);
      pending = '';
    }
  }
  if (pending) chunks.push(pending);
  return chunks;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
}

function fixed(value: number): number {
  return Number(value.toFixed(3));
}

async function surfaceState(page: Page): Promise<{ html: string; text: string; height: number; raw: boolean }> {
  return page.locator('#surface').evaluate((surface) => {
    const clone = surface.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[style]').forEach((element) => element.removeAttribute('style'));
    clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    clone.querySelectorAll('*').forEach((element) => {
      const attributes = [...element.attributes].sort((a, b) => a.name.localeCompare(b.name));
      for (const attribute of attributes) element.removeAttribute(attribute.name);
      for (const attribute of attributes) element.setAttribute(attribute.name, attribute.value);
    });
    const html = clone.innerHTML.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
    const text = surface.textContent ?? '';
    const raw = /```|\*\*|\]\(|(^|\n)\s*\|[^\n]*\||(^|[^`])`[^`\n]*$/m.test(text);
    return { html, text, height: surface.getBoundingClientRect().height, raw };
  });
}

function diffHint(left: string, right: string): string | null {
  if (left === right) return null;
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return `at ${index}: stream=${JSON.stringify(left.slice(index, index + 100))} static=${JSON.stringify(right.slice(index, index + 100))}`;
}

let anomalyScreenshots = 0;

async function runOne(
  page: Page,
  fixture: MarkdownFixture,
  fixtureIndex: number,
  method: ChunkMethod,
  side: Side,
): Promise<RunResult> {
  const chunks = method === 'random-5-30' ? randomChunks(fixture.content, fixtureIndex) : boundaryChunks(fixture.content);
  const renderTimes: number[] = [];
  let content = '';
  let rawMarkdownFrames = 0;
  let layoutJumpCount = 0;
  let previousHeight = 0;
  let anomalyScreenshot: string | null = null;
  try {
    await page.evaluate(() => window.mdswap.render({ side: 'neo', content: '', phase: 'static' }));
    for (let frame = 0; frame < chunks.length; frame += 1) {
      const tickStartedAt = Date.now();
      content += chunks[frame];
      const elapsed = await page.evaluate(async ({ nextSide, nextContent }) => {
        const started = performance.now();
        await window.mdswap.render({ side: nextSide, content: nextContent, phase: 'active' });
        return performance.now() - started;
      }, { nextSide: side, nextContent: content });
      renderTimes.push(elapsed);
      const state = await surfaceState(page);
      if (state.raw) rawMarkdownFrames += 1;
      if (frame > 0 && Math.abs(state.height - previousHeight) >= 64) layoutJumpCount += 1;
      previousHeight = state.height;
      if (state.raw && anomalyScreenshots < 12 && !anomalyScreenshot) {
        anomalyScreenshots += 1;
        const name = `${fixture.id}-${method}-${side}-frame-${frame + 1}.png`;
        await page.locator('#surface').screenshot({ path: path.join(screenshotDir, name) });
        anomalyScreenshot = `screenshots/${name}`;
      }
      await page.waitForTimeout(Math.max(0, 150 - (Date.now() - tickStartedAt)));
    }
    await page.evaluate(async ({ nextSide, nextContent }) => {
      await window.mdswap.render({ side: nextSide, content: nextContent, phase: 'complete' });
    }, { nextSide: side, nextContent: fixture.content });
    await page.waitForTimeout(250);
    const terminalStreamingHtml = (await surfaceState(page)).html;
    await page.evaluate(async ({ nextSide, nextContent }) => {
      await window.mdswap.render({ side: nextSide, content: nextContent, phase: 'static' });
    }, { nextSide: side, nextContent: fixture.content });
    await page.waitForTimeout(250);
    const terminalStaticHtml = (await surfaceState(page)).html;
    return {
      fixtureId: fixture.id,
      family: fixture.family,
      purpose: fixture.purpose,
      chars: fixture.content.length,
      method,
      side,
      logicalCadenceMs: 150,
      frameCount: chunks.length,
      terminalEqual: terminalStreamingHtml === terminalStaticHtml,
      terminalDiffHint: diffHint(terminalStreamingHtml, terminalStaticHtml),
      rawMarkdownFrames,
      rawMarkdownRatio: fixed(rawMarkdownFrames / chunks.length),
      layoutJumpCount,
      renderMsP50: fixed(percentile(renderTimes, 0.5)),
      renderMsP95: fixed(percentile(renderTimes, 0.95)),
      renderMsMax: fixed(Math.max(...renderTimes)),
      renderMsTotal: fixed(renderTimes.reduce((sum, value) => sum + value, 0)),
      crashed: false,
      error: null,
      anomalyScreenshot,
    };
  } catch (error) {
    const name = `${fixture.id}-${method}-${side}-crash.png`;
    await page.screenshot({ path: path.join(screenshotDir, name), fullPage: true }).catch(() => undefined);
    return {
      fixtureId: fixture.id, family: fixture.family, purpose: fixture.purpose,
      chars: fixture.content.length, method, side, logicalCadenceMs: 150,
      frameCount: chunks.length, terminalEqual: false, terminalDiffHint: null,
      rawMarkdownFrames, rawMarkdownRatio: chunks.length ? fixed(rawMarkdownFrames / chunks.length) : 0,
      layoutJumpCount, renderMsP50: fixed(percentile(renderTimes, 0.5)),
      renderMsP95: fixed(percentile(renderTimes, 0.95)), renderMsMax: renderTimes.length ? fixed(Math.max(...renderTimes)) : 0,
      renderMsTotal: fixed(renderTimes.reduce((sum, value) => sum + value, 0)),
      crashed: true, error: error instanceof Error ? error.stack ?? error.message : String(error),
      anomalyScreenshot: `screenshots/${name}`,
    };
  }
}

async function semanticChecks(page: Page): Promise<Record<string, unknown>[]> {
  const cases: Array<{ fixtureId: string; side: Side; check: string; oneShot?: boolean; inspect: () => Promise<unknown> }> = [
    { fixtureId: 'malformed-table-ragged', side: 'neo', check: 'table structure', inspect: () => page.locator('#surface').evaluate((node) => ({ tables: node.querySelectorAll('table').length, rows: node.querySelectorAll('tr').length })) },
    { fixtureId: 'malformed-unclosed-fence', side: 'streamdown', check: 'code block complete', inspect: () => page.locator('#surface').evaluate((node) => ({ code: node.querySelector('pre code')?.textContent ?? node.querySelector('code')?.textContent, pre: node.querySelectorAll('pre').length })) },
    { fixtureId: 'cjk-comma-url', side: 'neo', check: 'CJK URL href', inspect: () => page.locator('#surface').evaluate((node) => node.querySelector('a')?.getAttribute('href') ?? null) },
    { fixtureId: 'cjk-comma-url', side: 'streamdown', check: 'CJK URL href', inspect: () => page.locator('#surface').evaluate((node) => node.querySelector('a')?.getAttribute('href') ?? null) },
    { fixtureId: 'reference-link-definition', side: 'streamdown', check: 'reference href', inspect: () => page.locator('#surface').evaluate((node) => node.querySelector('a')?.getAttribute('href') ?? null) },
    { fixtureId: 'reference-image-definition', side: 'streamdown', check: 'one-shot image wrapper DOM', oneShot: true, inspect: () => page.locator('#surface').evaluate((node) => ({ images: node.querySelectorAll('img').length, wrappers: node.querySelectorAll('[data-streamdown="image-wrapper"]').length })) },
  ];
  const output: Record<string, unknown>[] = [];
  for (const item of cases) {
    const fixture = fixtures.find((candidate) => candidate.id === item.fixtureId)!;
    if (item.oneShot) {
      await page.evaluate((request) => window.mdswap.render(request), { side: item.side, content: fixture.content, phase: 'static' as const });
    } else {
      let streamed = '';
      for (const chunk of boundaryChunks(fixture.content)) {
        streamed += chunk;
        await page.evaluate((request) => window.mdswap.render(request), { side: item.side, content: streamed, phase: 'active' as const });
      }
      await page.evaluate((request) => window.mdswap.render(request), { side: item.side, content: fixture.content, phase: 'complete' as const });
    }
    await page.waitForTimeout(250);
    const value = await item.inspect();
    const name = `semantic-${item.fixtureId}-${item.side}.png`;
    await page.locator('#surface').screenshot({ path: path.join(screenshotDir, name) });
    output.push({ ...item, inspect: undefined, value, screenshot: `screenshots/${name}` });
  }
  return output;
}

async function captureShikiThemes(page: Page): Promise<Record<string, string>[]> {
  const fixture = fixtures.find((candidate) => candidate.id === 'long-mixed-code')!;
  const captures: Record<string, string>[] = [];
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((dataTheme) => {
      const root = document.documentElement;
      root.setAttribute('data-theme', dataTheme);
      root.classList.remove('light', 'dark', 'high-contrast-light', 'high-contrast-dark');
      root.classList.add(dataTheme);
    }, theme);
    await page.evaluate((request) => window.mdswap.render(request), {
      side: 'neo' as const,
      content: fixture.content,
      phase: 'static' as const,
    });
    await page.getByRole('button', { name: /展开全部/ }).click();
    await page.locator('[data-code-preview="shiki"]').first().waitFor({ timeout: 5000 });
    const name = `long-mixed-code-shiki-${theme}.png`;
    await page.locator('#surface').screenshot({ path: path.join(screenshotDir, name) });
    captures.push({ theme, screenshot: `screenshots/${name}` });
  }
  return captures;
}

await fs.mkdir(screenshotDir, { recursive: true });
const semanticsOnly = process.argv.includes('--semantics-only');
const previousPayload = semanticsOnly
  ? JSON.parse(await fs.readFile(path.join(outputDir, 'results.json'), 'utf8')) as { results: RunResult[] }
  : null;
const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
const consoleErrors: string[] = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(error.stack ?? error.message));

const results: RunResult[] = previousPayload?.results ?? [];
try {
  await page.goto('http://127.0.0.1:4178', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.mdswap));
  await page.evaluate(async () => {
    await window.mdswap.render({ side: 'neo', content: '# warmup\n\n```ts\nconst x=1\n```', phase: 'active' });
    await window.mdswap.render({ side: 'streamdown', content: '# warmup\n\n```ts\nconst x=1\n```', phase: 'active' });
  });
  if (!semanticsOnly) {
    for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex += 1) {
      const fixture = fixtures[fixtureIndex];
      for (const [methodIndex, method] of (['random-5-30', 'boundary'] as const).entries()) {
        const order: Side[] = (fixtureIndex + methodIndex) % 2 === 0 ? ['neo', 'streamdown'] : ['streamdown', 'neo'];
        for (const side of order) results.push(await runOne(page, fixture, fixtureIndex, method, side));
      }
    }
  }
  const semantics = await semanticChecks(page);
  const shikiThemeScreenshots = await captureShikiThemes(page);
  const payload = {
    metadata: {
      generatedAt: new Date().toISOString(),
      seed,
      logicalCadenceMs: 150,
      actualCadence: 'each tick starts at least 150ms after the previous tick; render timing covers React commit plus two requestAnimationFrame callbacks and excludes the remaining cadence wait',
      userAgent: await page.evaluate(() => navigator.userAgent),
      fixtureCount: fixtures.length,
      runCount: results.length,
    },
    fixtureLengths: fixtures.map(({ id, family, purpose, content }) => ({ id, family, purpose, chars: content.length, bytes: new TextEncoder().encode(content).length })),
    results,
    semantics,
    shikiThemeScreenshots,
    consoleErrors,
  };
  await fs.writeFile(path.join(outputDir, 'results.json'), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`mdswap: ${results.length} runs, ${results.filter((result) => result.crashed).length} crashes, ${results.filter((result) => !result.terminalEqual).length} terminal mismatches`);
} finally {
  await browser.close();
  await server.close();
}
