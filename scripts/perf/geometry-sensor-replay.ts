#!/usr/bin/env npx tsx
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { startGeometryVite } from './geometry-sensor-runtime.ts';
import { hasKind, probeCaselistGeometry, probeSidebarGeometry } from '../../tests/e2e/fixtures/geometryScenarios.ts';
import type { GeometryReport } from '../../tests/e2e/fixtures/geometrySensor.ts';

interface ReplayCase {
  id: string;
  title: string;
  pr: number;
  mergeSha: string;
  preSha: string;
  kind: 'sticky-header' | 'right-overhang';
  page: 'caselist' | 'sidebar';
}

interface RepeatResult {
  repeat: number;
  red: boolean;
  kinds: string[];
  details: string[];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parsedRepeats = Number.parseInt(process.env.GEOMETRY_REPLAY_REPEATS ?? '5', 10);
if (!Number.isInteger(parsedRepeats) || parsedRepeats < 5) {
  throw new Error(`GEOMETRY_REPLAY_REPEATS must be an integer >= 5 (got ${process.env.GEOMETRY_REPLAY_REPEATS ?? '5'})`);
}
const repeats = parsedRepeats;
const keepWorktrees = process.argv.includes('--keep-worktrees');

const CASES: ReplayCase[] = [
  {
    id: 'N-EVAL-CASELIST-STICKY-PAD',
    title: 'rows showing through above a sticky table header',
    pr: 1844,
    mergeSha: '756e44763bb3fae12badea5662399f61325a0627',
    preSha: '5d67be41edd8b1c68e3a5b3e81e2c0a8f0e3cbcd',
    kind: 'sticky-header',
    page: 'caselist',
  },
  {
    id: 'N-SCROLLGUTTER',
    title: 'sidebar session list content-box right overhangs sibling columns by 6px',
    pr: 1251,
    mergeSha: '1cd157912e59b5567f74a7286ec66c4b36a95453',
    preSha: 'd1ddbdfb5d0f293fbe358657a8f7ee0afe11523c',
    kind: 'right-overhang',
    page: 'sidebar',
  },
];

function run(command: string, args: string[], cwd = repoRoot): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}

function addWorktree(dir: string, sha: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  run('git', ['worktree', 'add', '--detach', dir, sha]);
  const bootstrap = path.join(repoRoot, 'scripts/worktree-bootstrap.sh');
  if (fs.existsSync(bootstrap)) {
    run('bash', [bootstrap, dir, '--source', repoRoot]);
  }
}

function removeWorktree(dir: string): void {
  if (keepWorktrees) return;
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: repoRoot, stdio: 'inherit' });
  fs.rmSync(dir, { recursive: true, force: true });
}

async function probe(page: Page, which: ReplayCase['page']): Promise<GeometryReport> {
  return which === 'caselist' ? probeCaselistGeometry(page) : probeSidebarGeometry(page);
}

async function runVariant(entry: ReplayCase, variant: string, sha: string): Promise<RepeatResult[]> {
  const dir = path.join(os.tmpdir(), `geo-${entry.pr}-${variant}`);
  let vite: Awaited<ReturnType<typeof startGeometryVite>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const results: RepeatResult[] = [];
  try {
    addWorktree(dir, sha);
    vite = await startGeometryVite(dir, repoRoot);
    browser = await chromium.launch({ headless: true });
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const page = await browser.newPage({
        viewport: entry.page === 'caselist' ? { width: 1440, height: 900 } : { width: 420, height: 720 },
      });
      try {
        const url = entry.page === 'caselist' ? vite.caselistUrl : vite.sidebarUrl;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const report = await probe(page, entry.page);
        results.push({
          repeat,
          red: hasKind(report, entry.kind),
          kinds: report.violations.map((violation) => violation.kind),
          details: report.violations.map((violation) => `${violation.kind}: ${violation.detail}`),
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser?.close();
    await vite?.server.close();
    removeWorktree(dir);
  }
  return results;
}

function summarize(label: string, expectedRed: boolean, results: RepeatResult[]): string {
  const hits = results.filter((result) => result.red).length;
  const ok = expectedRed ? hits === results.length : hits === 0;
  const status = ok ? 'PASS' : 'FAIL';
  const lines = [
    `## ${label}`,
    '',
    `expected: ${expectedRed ? 'red' : 'green'} ${results.length}/${results.length}`,
    `actual: ${expectedRed ? 'red' : 'green'} ${expectedRed ? hits : results.length - hits}/${results.length} (${status})`,
    '',
    ...results.map((result) => {
      const details = result.details.join(' | ');
      return `- repeat ${result.repeat}: ${result.red ? 'RED' : 'GREEN'} kinds=${JSON.stringify(result.kinds)}${details ? ` ${details}` : ''}`;
    }),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const chunks: string[] = [
    '# geometry-sensor historical replay',
    '',
    `generatedAt: ${new Date().toISOString()}`,
    `repeats: ${repeats}`,
    'harnessRoot: .',
    '',
  ];
  let failed = false;
  for (const entry of CASES) {
    chunks.push(`# ${entry.id} (PR #${entry.pr})`);
    chunks.push(`pre-fix: ${entry.preSha}`);
    chunks.push(`fix: ${entry.mergeSha}`);
    chunks.push(`probe: ${entry.kind} on ${entry.page}`);
    chunks.push('');
    const pre = await runVariant(entry, 'pre', entry.preSha);
    const fix = await runVariant(entry, 'fix', entry.mergeSha);
    chunks.push(summarize(`${entry.id} pre-fix`, true, pre));
    chunks.push('');
    chunks.push(summarize(`${entry.id} fix`, false, fix));
    chunks.push('');
    const preOk = pre.every((result) => result.red);
    const fixOk = fix.every((result) => !result.red);
    if (!preOk || !fixOk) failed = true;
  }
  const mainSha = spawnSync('git', ['rev-parse', 'origin/main'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  chunks.push(`# current origin/main (${mainSha})`);
  chunks.push('probe: caselist sticky-header + sidebar right-overhang, expect green (zero false reds)');
  chunks.push('');
  const mainCaselist = await runVariant({
    ...CASES[0],
    id: 'current-main-caselist',
    pr: 0,
    preSha: mainSha,
    mergeSha: mainSha,
  }, 'main-caselist', mainSha);
  const mainSidebar = await runVariant({
    ...CASES[1],
    id: 'current-main-sidebar',
    pr: 0,
    preSha: mainSha,
    mergeSha: mainSha,
  }, 'main-sidebar', mainSha);
  chunks.push(summarize('current origin/main caselist', false, mainCaselist));
  chunks.push('');
  chunks.push(summarize('current origin/main sidebar', false, mainSidebar));
  chunks.push('');
  if (!mainCaselist.every((result) => !result.red) || !mainSidebar.every((result) => !result.red)) failed = true;

  const output = chunks.join('\n');
  process.stdout.write(`${output}\n`);
  const outDir = path.join(repoRoot, 'docs/perf');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'geometry-sensor-replay-latest.md'), output);
  if (failed) process.exit(1);
}

await main();
