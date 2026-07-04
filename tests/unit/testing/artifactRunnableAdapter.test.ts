// artifact_runnable 断言家族的纯函数 adapter 测试（批 3 · B3①）。
// 浏览器类检查沿用仓库惯例：真跑 headless Chromium/系统 Chrome，零 mock；
// 环境没有浏览器 provider 时 verdict='skipped' 优雅放过（与生产语义一致）。
// 标本 fixture 是 2026-07-03 dogfood 实锤的真实生成产物（坏游戏回归标本），
// 双向硬门：坏标本必须 not_runnable，好产物必须 runnable。
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  checkGameSmoke,
  checkHtmlRenders,
  checkPptxOpens,
} from '../../../src/host/testing/artifactRunnableAdapter';

const require = createRequire(import.meta.url);

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../.claude/test-cases/artifact-runnable/fixtures',
);
const BAD_GAME_REFERENCEERROR = path.join(FIXTURE_DIR, 'bad-game-referenceerror.html');
const BAD_GAME_MECHANICS_BROKEN = path.join(FIXTURE_DIR, 'bad-game-mechanics-broken.html');
const GOOD_GAME_PLAYABLE = path.join(FIXTURE_DIR, 'good-game-playable.html');

async function writeTempFile(content: string | Buffer, fileName: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-runnable-'));
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, content);
  return filePath;
}

const CLEAN_HTML_PAGE = `
  <!doctype html>
  <html>
  <body>
    <main><h1>报告</h1><p>正文内容正常渲染。</p></main>
  </body>
  </html>
`;

const THROW_ON_LOAD_PAGE = `
  <!doctype html>
  <html>
  <body>
    <main><h1>报告</h1><p>页面有内容，但脚本在加载时抛未捕获异常。</p></main>
    <script>
      window.setTimeout(() => { missingFunction(); }, 100);
    </script>
  </body>
  </html>
`;

describe('checkGameSmoke (light contract)', () => {
  it('judges the bad-game specimen (uncaught ReferenceError on play) not_runnable', async (ctx) => {
    const result = await checkGameSmoke(BAD_GAME_REFERENCEERROR);

    if (result.verdict === 'skipped') ctx.skip();
    expect(result.verdict).toBe('not_runnable');
    expect(result.failures.some((f) => f.includes('ReferenceError'))).toBe(true);
    expect(result.environment).toContain(process.platform);
  });

  it('judges the known-good playable specimen runnable', async (ctx) => {
    const result = await checkGameSmoke(GOOD_GAME_PLAYABLE);

    if (result.verdict === 'skipped') ctx.skip();
    expect(result.verdict).toBe('runnable');
    expect(result.failures).toEqual([]);
  });

  it('reports a missing artifact file as file_missing (审计 R1-H1：不许与 not_runnable 混同，防回归标本假绿)', async () => {
    const result = await checkGameSmoke(path.join(FIXTURE_DIR, 'does-not-exist.html'));

    expect(result.verdict).toBe('file_missing');
    expect(result.failures.some((f) => f.includes('not found'))).toBe(true);
  });
});

describe('checkGameSmoke (full contract)', () => {
  it('judges the mechanics-broken specimen not_runnable under the full goal-mode contract', async (ctx) => {
    const result = await checkGameSmoke(BAD_GAME_MECHANICS_BROKEN, { contract: 'full' });

    if (result.verdict === 'skipped') ctx.skip();
    expect(result.verdict).toBe('not_runnable');
    expect(result.failures.length).toBeGreaterThan(0);
  });
});

describe('checkHtmlRenders', () => {
  it('judges a clean static page runnable', async (ctx) => {
    const filePath = await writeTempFile(CLEAN_HTML_PAGE, 'clean.html');
    const result = await checkHtmlRenders(filePath);

    if (result.verdict === 'skipped') ctx.skip();
    expect(result.verdict).toBe('runnable');
  });

  it('judges a page with an uncaught load-time error not_runnable', async (ctx) => {
    const filePath = await writeTempFile(THROW_ON_LOAD_PAGE, 'throw-on-load.html');
    const result = await checkHtmlRenders(filePath);

    if (result.verdict === 'skipped') ctx.skip();
    expect(result.verdict).toBe('not_runnable');
    expect(result.failures.some((f) => f.includes('page error') || f.includes('missingFunction'))).toBe(true);
  });

  it('treats layout-quality findings (e.g. canvas game without <main>) as informational, not failures', async (ctx) => {
    // 校准 pin：canvas 游戏没有 <main> 元素，missing_main_element 是布局质量信号，
    // 不是"能不能跑"的硬信号——好游戏标本必须 runnable，防止 html_renders 误杀全部游戏产物。
    const result = await checkHtmlRenders(GOOD_GAME_PLAYABLE);

    if (result.verdict === 'skipped') ctx.skip();
    expect(result.verdict).toBe('runnable');
    expect(result.checks.some((c) => c.includes('missing_main_element'))).toBe(true);
  });

  it('judges the bad-game specimen not_runnable via its runtime page error', async (ctx) => {
    const result = await checkHtmlRenders(BAD_GAME_REFERENCEERROR);

    if (result.verdict === 'skipped') ctx.skip();
    expect(result.verdict).toBe('not_runnable');
    expect(result.failures.some((f) => f.includes('ReferenceError') || f.includes('page error'))).toBe(true);
  });
});

describe('checkPptxOpens', () => {
  it('judges a real pptxgenjs-generated deck runnable', async () => {
    // pptxgenjs 是 CJS，走 require 取构造器（与 pptxExport getPptxGenJS 同款）。
    const PptxGenJS = require('pptxgenjs') as new () => {
      addSlide(): { addText(text: string, opts: Record<string, unknown>): void };
      write(opts: { outputType: 'nodebuffer' }): Promise<Buffer>;
    };
    const deck = new PptxGenJS();
    deck.addSlide().addText('artifact runnable smoke', { x: 1, y: 1, w: 8, h: 1 });
    const buffer = await deck.write({ outputType: 'nodebuffer' });
    const filePath = await writeTempFile(buffer, 'good-deck.pptx');

    const result = await checkPptxOpens(filePath);

    expect(result.verdict).toBe('runnable');
    expect(result.checks.some((c) => c.includes('slide'))).toBe(true);
  });

  it('judges corrupt bytes not_runnable', async () => {
    const filePath = await writeTempFile(Buffer.from('this is not a zip file at all'), 'corrupt.pptx');

    const result = await checkPptxOpens(filePath);

    expect(result.verdict).toBe('not_runnable');
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('judges a zip without any slide not_runnable', async () => {
    const JSZip = require('jszip') as {
      new (): {
        file(name: string, content: string): void;
        generateAsync(opts: { type: 'nodebuffer' }): Promise<Buffer>;
      };
    };
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
    zip.file('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation/>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const filePath = await writeTempFile(buffer, 'no-slides.pptx');

    const result = await checkPptxOpens(filePath);

    expect(result.verdict).toBe('not_runnable');
    expect(result.failures.some((f) => f.includes('slide'))).toBe(true);
  });

  it('reports a missing file as file_missing with a clear message', async () => {
    const result = await checkPptxOpens(path.join(FIXTURE_DIR, 'does-not-exist.pptx'));

    expect(result.verdict).toBe('file_missing');
    expect(result.failures.some((f) => f.includes('not found'))).toBe(true);
  });
});
