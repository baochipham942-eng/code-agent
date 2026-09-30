// 合成脚本从随包目录运行，不靠仓库 node_modules 解析 pptxgenjs / pdf-lib。
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repo root not found');
}

function slides(count: number): string {
  const pages = Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    layout: index === 0 ? 'cover' : 'content',
    title: `第 ${index + 1} 页结论`,
    subtitle: index === 0 ? '纯文字兜底' : '',
    bullets: index === 0 ? [] : ['要点甲', '要点乙'],
    footnote: '',
  }));
  return JSON.stringify(pages, null, 2);
}

function runNode(script: string, args: string[], cwd: string) {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

function slideXmlCount(pptxPath: string): number {
  const listed = spawnSync('unzip', ['-l', pptxPath], { encoding: 'utf8' });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout.split('\n').filter((line) => /ppt\/slides\/slide[0-9]+\.xml/.test(line)).length;
}

describe('frontend-slides packaged merge scripts', () => {
  const root = repoRoot();
  const packagedScripts = path.join(root, 'resources', 'skills', 'frontend-slides', 'scripts');

  it('keeps the text-only notice inside the committed bundle and does not import pptxgenjs bare', () => {
    const source = fs.readFileSync(path.join(packagedScripts, 'src', 'merge-to-pptx-hybrid.mjs'), 'utf8');
    const notice = source.match(/const TEXT_ONLY_NOTICE = '([^']+)';/);
    expect(notice?.[1]).toBe('backgrounds were skipped');
    const bundle = fs.readFileSync(path.join(packagedScripts, 'merge-to-pptx-hybrid.bundle.mjs'), 'utf8');
    expect(bundle.length).toBeGreaterThan(10_000);
    expect(bundle).toContain(notice![1]);
    expect(bundle).not.toMatch(/from\s+["']pptxgenjs["']/);
    expect(bundle).not.toMatch(/require\(\s*["']pptxgenjs["']\s*\)/);
    const pdfBundle = fs.readFileSync(path.join(packagedScripts, 'merge-to-pdf.bundle.mjs'), 'utf8');
    expect(pdfBundle).not.toMatch(/from\s+["']pdf-lib["']/);
    expect(pdfBundle).not.toMatch(/require\(\s*["']pdf-lib["']\s*\)/);
  });

  it('renders a 5-page text-only pptx from a copy outside the repo', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-slides-merge-'));
    const scriptDir = path.join(outside, 'scripts');
    fs.cpSync(packagedScripts, scriptDir, {
      recursive: true,
      filter: (sourcePath) => path.basename(sourcePath) !== 'src',
    });
    const deckDir = path.join(outside, 'deck');
    fs.mkdirSync(deckDir);
    fs.writeFileSync(path.join(deckDir, 'slides.json'), slides(5), 'utf8');

    const env = { ...process.env };
    delete env.NODE_PATH;
    const paths = spawnSync(process.execPath, ['-e', 'console.log(module.paths.join("\\n"))'], {
      cwd: scriptDir,
      env,
      encoding: 'utf8',
    });
    expect(paths.status).toBe(0);
    const repoModules = fs.realpathSync(path.join(root, 'node_modules'));
    expect(paths.stdout).not.toContain(repoModules);
    expect(paths.stdout).not.toContain(path.join(root, 'node_modules'));

    const script = path.join(scriptDir, 'merge-to-pptx-hybrid.mjs');
    const explicit = runNode(script, [deckDir, '--text-only'], scriptDir);
    expect(explicit.status, `${explicit.stdout}\n${explicit.stderr}`).toBe(0);
    expect(explicit.stdout).toContain('backgrounds were skipped');
    const explicitPptx = path.join(deckDir, 'deck.pptx');
    const tested = spawnSync('unzip', ['-t', explicitPptx], { encoding: 'utf8' });
    expect(tested.status, tested.stdout + tested.stderr).toBe(0);
    expect(slideXmlCount(explicitPptx)).toBe(5);

    const autoDir = path.join(outside, 'auto');
    fs.mkdirSync(autoDir);
    fs.writeFileSync(path.join(autoDir, 'slides.json'), slides(5), 'utf8');
    const automatic = runNode(script, [autoDir], scriptDir);
    expect(automatic.status, `${automatic.stdout}\n${automatic.stderr}`).toBe(0);
    expect(automatic.stdout).toContain('backgrounds were skipped');
    expect(slideXmlCount(path.join(autoDir, 'auto.pptx'))).toBe(5);
  });

  it('keeps image mode silent about skipped backgrounds and still builds a pdf', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-slides-image-'));
    const scriptDir = path.join(outside, 'scripts');
    fs.cpSync(packagedScripts, scriptDir, {
      recursive: true,
      filter: (sourcePath) => path.basename(sourcePath) !== 'src',
    });
    const deckDir = path.join(outside, 'picture');
    fs.mkdirSync(deckDir);
    fs.writeFileSync(path.join(deckDir, 'slides.json'), slides(1), 'utf8');
    fs.writeFileSync(path.join(deckDir, '01-slide-cover.png'), ONE_PIXEL_PNG);

    const hybrid = runNode(path.join(scriptDir, 'merge-to-pptx-hybrid.mjs'), [deckDir], scriptDir);
    expect(hybrid.status, `${hybrid.stdout}\n${hybrid.stderr}`).toBe(0);
    expect(hybrid.stdout).not.toContain('backgrounds were skipped');
    const pptx = path.join(deckDir, 'picture.pptx');
    expect(spawnSync('unzip', ['-t', pptx], { encoding: 'utf8' }).status).toBe(0);
    expect(slideXmlCount(pptx)).toBe(1);

    const pdf = runNode(path.join(scriptDir, 'merge-to-pdf.mjs'), [deckDir], scriptDir);
    expect(pdf.status, `${pdf.stdout}\n${pdf.stderr}`).toBe(0);
    expect(fs.statSync(path.join(deckDir, 'picture.pdf')).size).toBeGreaterThan(100);
  });
});
