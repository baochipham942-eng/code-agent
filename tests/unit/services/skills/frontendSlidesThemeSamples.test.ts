// 风格样张脚本 + SKILL.md 选风格步骤（N-PPT-SAMPLE-PICK-FLOW）。
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found');
}

const root = repoRoot();
const script = path.join(root, 'resources', 'skills', 'frontend-slides', 'scripts', 'theme-samples.mjs');

const SLIDES = [
  { index: 1, layout: 'cover', title: 'Q3 季度报告', subtitle: '增长稳健', bullets: [], footnote: '' },
  { index: 2, layout: 'content', title: '营收同比增长 23%', subtitle: '', bullets: ['华东贡献最大', '新客占比 41%'], footnote: '' },
];

function makeDeck(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-samples-'));
  fs.writeFileSync(path.join(dir, 'slides.json'), JSON.stringify(SLIDES), 'utf8');
  return dir;
}

function run(deck: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script, deck], { encoding: 'utf8', env, timeout: 180_000 });
}

function hasSoffice(): boolean {
  const candidates = [
    process.env.LIBREOFFICE_PATH,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/libreoffice',
  ].filter((entry): entry is string => Boolean(entry));
  if (candidates.some((entry) => fs.existsSync(entry))) return true;
  return ['soffice', 'libreoffice'].some((bin) => spawnSync('which', [bin]).status === 0);
}

const SOFFICE = hasSoffice();

describe('frontend-slides theme-samples script', () => {
  // 没有 LibreOffice 的机器上这条显式跳过（原因写在用例名里），不静默通过。
  it.skipIf(!SOFFICE)('emits 3 distinct non-empty PNGs for corporate/minimal/bold-editorial', () => {
    const deck = makeDeck();
    const env = { ...process.env };
    delete env.NODE_PATH;
    const result = run(deck, env);
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.available).toBe(true);
    expect(out.slide).toBe(2);
    expect(out.samples.map((s: { theme: string }) => s.theme)).toEqual(['corporate', 'minimal', 'bold-editorial']);
    const hashes = out.samples.map((s: { png: string }) => {
      expect(path.isAbsolute(s.png)).toBe(true);
      const bytes = fs.readFileSync(s.png);
      expect(bytes.length).toBeGreaterThan(0);
      return createHash('sha256').update(bytes).digest('hex');
    });
    expect(new Set(hashes).size).toBe(3);
  }, 240_000);

  // 假 soffice：把收到的 pptx 抄到捕获目录再失败。不依赖真 LibreOffice，直接检查样张 PPTX 的版式。
  function capturedSamplePptx(deckSlides: unknown[]): string[] {
    const deck = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-samples-cap-'));
    fs.writeFileSync(path.join(deck, 'slides.json'), JSON.stringify(deckSlides), 'utf8');
    const capture = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-samples-capdir-'));
    const fake = path.join(capture, 'fake-soffice');
    fs.writeFileSync(fake, `#!/bin/sh\nfor last; do :; done\ncp "$last" "${capture}/$(basename "$last")"\nexit 1\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, LIBREOFFICE_PATH: fake };
    delete env.NODE_PATH;
    run(deck, env);
    return fs.readdirSync(capture).filter((f) => f.endsWith('.pptx')).map((f) => path.join(capture, f));
  }
  const titleCentered = (pptx: string) =>
    spawnSync('unzip', ['-p', pptx, 'ppt/slides/slide1.xml'], { encoding: 'utf8' }).stdout.includes('algn="ctr"');

  it('lays a chosen content slide out as content, not as a cover (merge treats index 1 as cover)', () => {
    const pptxs = capturedSamplePptx(SLIDES);
    expect(pptxs.length).toBe(1); // fake soffice fails after the first theme
    expect(titleCentered(pptxs[0])).toBe(false);
  });

  it('still lays a sole cover slide out as a cover', () => {
    const pptxs = capturedSamplePptx([SLIDES[0]]);
    expect(pptxs.length).toBe(1);
    expect(titleCentered(pptxs[0])).toBe(true);
  });

  it('prints {available:false}, exits 0 and logs the failed lookup when soffice cannot be found', () => {
    const deck = makeDeck();
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'no-soffice-'));
    // 显式 LIBREOFFICE_PATH 是权威来源：指向不存在的文件 = 本机视为没装，即使系统别处装了 LibreOffice。
    const result = run(deck, { PATH: emptyBin, LIBREOFFICE_PATH: path.join(emptyBin, 'soffice') });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim()).available).toBe(false);
    expect(result.stderr).toContain('lookup failed');
  });
});

describe('frontend-slides SKILL.md sample-pick step', () => {
  const copies = [
    'resources/skills/frontend-slides/SKILL.md',
    '.claude/skills/frontend-slides/SKILL.md',
    '.agents/skills/frontend-slides/SKILL.md',
  ];

  it.each(copies)('%s documents the sample step, skip rules and theme hand-off', (relative) => {
    const content = fs.readFileSync(path.join(root, relative), 'utf8');
    expect(content).toContain('### 3.5 风格样张');
    expect(content).toContain('theme-samples.mjs');
    // 跳过规则
    expect(content).toContain('「直接做」「just do it」「you decide」');
    expect(content).toContain('用户已经点名了风格');
    // 无 LibreOffice 的文字降级
    expect(content).toContain('available:false');
    expect(content).toContain('这台机器没有预览');
    // 选择结果交给第 5 步 --theme
    expect(content).toContain('第 5 步的 `--theme` 就传这个值');
    // 样张步骤位于 slides.json 与合成之间
    const order = ['### 3. 生成 slides.json', '### 3.5 风格样张', '### 5. 合成 PPTX / PDF'].map((h) => content.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
