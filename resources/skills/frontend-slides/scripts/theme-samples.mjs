// Renders ONE slide of a deck under 3 themes as PNGs so the user can pick a style.
// Usage: node theme-samples.mjs <slide-deck-dir> [--out <dir>]
// Stdout: one JSON line. {available:false, reason} when LibreOffice is missing (exit 0),
//         {available:true, slide, samples:[{theme,png}]} otherwise.
// Plain Node, no dependencies; the merge step is the sibling merge-to-pptx-hybrid.mjs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THEMES = ['corporate', 'minimal', 'bold-editorial'];
const SOFFICE_FIXED_PATHS = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/libreoffice',
  '/usr/local/bin/libreoffice',
];
const STEP_TIMEOUT_MS = 120_000;

function log(message) {
  console.error(`[theme-samples] ${message}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let dir = '';
  let out = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') {
      out = args[i + 1] || '';
      i += 1;
    } else if (!args[i].startsWith('-')) {
      dir = args[i];
    }
  }
  if (!dir) {
    console.error('Usage: node theme-samples.mjs <slide-deck-dir> [--out <dir>]');
    process.exit(1);
  }
  return { dir: path.resolve(dir), out: out ? path.resolve(out) : path.join(path.resolve(dir), 'theme-samples') };
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(binary) {
  for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** LIBREOFFICE_PATH is authoritative when set; otherwise fixed install paths, then PATH. */
function findSoffice() {
  const explicit = process.env.LIBREOFFICE_PATH?.trim();
  if (explicit) {
    if (isExecutable(explicit)) return explicit;
    log(`lookup failed: LIBREOFFICE_PATH=${explicit} is not an executable file`);
    return null;
  }
  for (const candidate of SOFFICE_FIXED_PATHS) {
    if (isExecutable(candidate)) return candidate;
  }
  log(`lookup failed: none of ${SOFFICE_FIXED_PATHS.join(', ')}`);
  for (const binary of ['soffice', 'libreoffice']) {
    const found = findOnPath(binary);
    if (found) return found;
    log(`lookup failed: ${binary} not on PATH`);
  }
  return null;
}

function pickSlide(dir) {
  const slidesPath = path.join(dir, 'slides.json');
  const slides = JSON.parse(fs.readFileSync(slidesPath, 'utf8'));
  if (!Array.isArray(slides) || slides.length === 0) throw new Error(`${slidesPath} has no slides`);
  // First content slide; the cover only when it is the sole slide.
  return slides.find((slide) => slide.layout !== 'cover') ?? slides[0];
}

// The merge script treats index 1 as the cover whatever `layout` says, so a content slide
// must keep an index >= 2 or it would be laid out as a cover.
function sampleIndex(slide) {
  if (slide.layout === 'cover') return 1;
  return Math.max(Number(slide.index) || 2, 2);
}

function run(cmd, args, label) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: STEP_TIMEOUT_MS });
  if (result.status !== 0) {
    throw new Error(`${label} failed (status ${result.status}): ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`);
  }
}

function pdfToPng(pdf, png) {
  const pdftoppm = findOnPath('pdftoppm') || ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm'].find(isExecutable);
  if (pdftoppm) {
    const prefix = png.replace(/\.png$/, '');
    run(pdftoppm, ['-png', '-r', '80', '-singlefile', pdf, prefix], 'pdftoppm');
    return;
  }
  log('lookup failed: pdftoppm not found, falling back to sips');
  run('sips', ['-s', 'format', 'png', pdf, '--out', png], 'sips');
}

function renderSample({ soffice, mergeScript, slide, theme, outDir, work }) {
  const deck = path.join(work, theme);
  fs.mkdirSync(deck, { recursive: true });
  fs.writeFileSync(path.join(deck, 'slides.json'), JSON.stringify([{ ...slide, index: sampleIndex(slide) }], null, 2));
  const pptx = path.join(deck, `${theme}.pptx`);
  run(process.execPath, [mergeScript, deck, '--text-only', '--theme', theme, '--output', pptx], `merge (${theme})`);
  // Isolated profile so a running LibreOffice instance cannot swallow the headless call.
  const profile = path.join(work, `profile-${theme}`);
  run(
    soffice,
    [`-env:UserInstallation=file://${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', deck, pptx],
    `soffice (${theme})`,
  );
  const png = path.join(outDir, `${theme}.png`);
  pdfToPng(path.join(deck, `${theme}.pdf`), png);
  if (!fs.existsSync(png) || fs.statSync(png).size === 0) throw new Error(`empty PNG for ${theme}`);
  return { theme, png };
}

function main() {
  const { dir, out } = parseArgs();
  const soffice = findSoffice();
  if (!soffice) {
    console.log(JSON.stringify({ available: false, reason: 'LibreOffice (soffice) not found' }));
    return;
  }
  const slide = pickSlide(dir);
  const mergeScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'merge-to-pptx-hybrid.mjs');
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-theme-samples-'));
  try {
    const samples = THEMES.map((theme) => renderSample({ soffice, mergeScript, slide, theme, outDir: out, work }));
    console.log(JSON.stringify({ available: true, slide: slide.index, samples }));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  // Rendering broke after LibreOffice was found: report unavailable so the skill falls back to text options.
  log(`render failed: ${error instanceof Error ? error.message : String(error)}`);
  console.log(JSON.stringify({ available: false, reason: 'sample render failed' }));
}
