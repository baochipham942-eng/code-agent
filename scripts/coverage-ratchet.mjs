#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const METRICS = ['statements', 'branches', 'functions', 'lines'];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function fail(message) {
  console.error(`[coverage-ratchet] ✗ ${message}`);
  process.exit(1);
}

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} 缺少参数值`);
  return value;
}

const valueOptions = new Set([
  '--repo-root', '--baseline', '--summary', '--coverage-final',
  '--compare-baseline', '--diff-base', '--diff-head',
]);
const flagOptions = new Set(['--baseline-only', '--changed-lines']);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (valueOptions.has(arg)) {
    index += 1;
    if (index >= args.length || args[index].startsWith('--')) fail(`${arg} 缺少参数值`);
  } else if (!flagOptions.has(arg)) {
    fail(`不支持的参数：${arg}`);
  }
}

const baselineOnly = args.includes('--baseline-only');
const changedLinesOnly = args.includes('--changed-lines');
if (baselineOnly && changedLinesOnly) fail('--baseline-only 与 --changed-lines 不能同时使用');

const repoRoot = path.resolve(option('--repo-root', path.resolve(scriptDir, '..')));
const baselineRelative = option('--baseline', 'scripts/coverage-ratchet-baseline.json');
const baselinePath = path.resolve(repoRoot, baselineRelative);
const summaryPath = path.resolve(repoRoot, option('--summary', 'coverage/coverage-summary.json'));
const coverageFinalPath = path.resolve(repoRoot, option('--coverage-final', 'coverage/coverage-final.json'));
const compareBaselineRef = option('--compare-baseline', undefined);
const diffBase = option('--diff-base', undefined);
const diffHead = option('--diff-head', 'HEAD');

function readJson(file, label) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    fail(`自检失败：无法读取 ${label} ${path.relative(repoRoot, file)}：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`自检失败：${label} JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

function validPercentage(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validateBaseline(value, label = '基线') {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
    fail(`自检失败：${label}缺少 schemaVersion=1`);
  }
  for (const metric of METRICS) {
    if (!validPercentage(value[metric])) {
      fail(`自检失败：${label}缺少有效的 ${metric} 百分比`);
    }
  }
  if (typeof value.measuredAt !== 'string' || !value.measuredAt.trim()
    || typeof value.source !== 'string' || !value.source.trim()) {
    fail(`自检失败：${label}必须保留非空 measuredAt 和 source 证据`);
  }
  return value;
}

function runGit(gitArgs, purpose, { allowMissingPath = false } = {}) {
  const result = spawnSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status === 0) return result.stdout;
  if (allowMissingPath && result.status === 128
    && /does not exist in|exists on disk, but not in|path .* does not exist/.test(result.stderr)) return undefined;
  fail(`自检失败：git ${purpose} 失败：${result.stderr.trim() || `exit ${result.status}`}`);
}

const baseline = validateBaseline(readJson(baselinePath, '覆盖率基线'));

if (compareBaselineRef) {
  runGit(['cat-file', '-e', `${compareBaselineRef}^{commit}`], `解析基线参照 ${compareBaselineRef}`);
  const previousText = runGit(
    ['show', `${compareBaselineRef}:${baselineRelative.split(path.sep).join('/')}`],
    `读取 ${compareBaselineRef} 中的基线`,
    { allowMissingPath: true },
  );
  if (previousText === undefined) {
    console.log(`[coverage-ratchet] ${compareBaselineRef} 尚无基线文件，本次建立初始实测基线`);
  } else {
    let previous;
    try {
      previous = JSON.parse(previousText);
    } catch (error) {
      fail(`自检失败：${compareBaselineRef} 中的基线 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
    validateBaseline(previous, `${compareBaselineRef} 中的基线`);
    const lowered = METRICS.filter((metric) => baseline[metric] < previous[metric]);
    if (lowered.length > 0) {
      // 正当理由闸门：基线原则上只许升不许降。唯一例外是带新鲜 lowerJustification 的
      // 校正（如初值取错环境、门槛口径修正）——理由必须非空且与上一版不同，
      // 防止旧理由被复制粘贴反复复用。（先例：eslint-ratchet.mjs 文件头的基线订正记录。）
      const justification = typeof baseline.lowerJustification === 'string' ? baseline.lowerJustification.trim() : '';
      const previousJustification = typeof previous.lowerJustification === 'string' ? previous.lowerJustification.trim() : '';
      const justified = justification.length > 0 && justification !== previousJustification;
      for (const metric of lowered) {
        console.error(`[coverage-ratchet] ${justified ? '!' : '✗'} ${metric} 基线下调：${previous[metric].toFixed(2)}% -> ${baseline[metric].toFixed(2)}%`);
      }
      if (!justified) {
        fail('覆盖率基线只许升不许降；确需校正必须在基线 JSON 写新的非空 lowerJustification');
      }
      console.error(`[coverage-ratchet] ! 带正当理由的基线校正：${justification}`);
    }
    console.log(`[coverage-ratchet] ✓ 基线方向检查通过（相对 ${compareBaselineRef} 无未授权下调）`);
  }
}

if (baselineOnly) process.exit(0);

function appendSummary(markdown) {
  process.stdout.write(`${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

if (changedLinesOnly) {
  if (!diffBase) fail('--changed-lines 必须提供 --diff-base');
  const coverage = readJson(coverageFinalPath, 'coverage-final');
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage) || Object.keys(coverage).length === 0) {
    fail('自检失败：coverage-final 没有任何文件覆盖数据');
  }

  const lineCoverageByFile = new Map();
  for (const [coverageKey, fileCoverage] of Object.entries(coverage)) {
    if (!fileCoverage || typeof fileCoverage !== 'object'
      || !fileCoverage.statementMap || typeof fileCoverage.statementMap !== 'object'
      || !fileCoverage.s || typeof fileCoverage.s !== 'object') {
      fail(`自检失败：coverage-final 中 ${coverageKey} 缺少 statementMap/s`);
    }
    const lines = new Map();
    for (const [statementId, hits] of Object.entries(fileCoverage.s)) {
      const location = fileCoverage.statementMap[statementId];
      const line = location?.start?.line;
      if (!Number.isInteger(line) || line < 1 || !Number.isFinite(hits) || hits < 0) {
        fail(`自检失败：coverage-final 中 ${coverageKey} 的 statement ${statementId} 行号/命中数无效`);
      }
      // Match istanbul-lib-coverage#getLineCoverage: a source line was executed
      // when any statement starting on that line ran, so retain the max count.
      lines.set(line, Math.max(lines.get(line) ?? hits, hits));
    }
    const rawPath = typeof fileCoverage.path === 'string' ? fileCoverage.path : coverageKey;
    const relative = path.relative(repoRoot, path.resolve(repoRoot, rawPath)).split(path.sep).join('/');
    lineCoverageByFile.set(relative, lines);
  }

  const diff = runGit([
    '-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff',
    '--diff-filter=AMR', diffBase, diffHead, '--', 'src',
  ], `生成 ${diffBase}..${diffHead} 改动行`);

  const changedByFile = new Map();
  let currentFile;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      const candidate = target === '/dev/null' ? undefined : target.replace(/^b\//, '');
      currentFile = candidate && /\.tsx?$/.test(candidate) ? candidate : undefined;
      if (currentFile && !changedByFile.has(currentFile)) changedByFile.set(currentFile, new Set());
      continue;
    }
    if (!currentFile || !line.startsWith('@@ ')) continue;
    const match = line.match(/\+(\d+)(?:,(\d+))?/);
    if (!match) fail(`自检失败：无法解析 diff hunk：${line}`);
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let offset = 0; offset < count; offset += 1) changedByFile.get(currentFile).add(start + offset);
  }

  const rows = [];
  let changed = 0;
  let executable = 0;
  let executed = 0;
  for (const [file, changedLines] of changedByFile) {
    const coverageLines = lineCoverageByFile.get(file) ?? new Map();
    const executableLines = [...changedLines].filter((line) => coverageLines.has(line));
    const executedLines = executableLines.filter((line) => coverageLines.get(line) > 0);
    const uncoveredLines = executableLines.filter((line) => coverageLines.get(line) === 0);
    changed += changedLines.size;
    executable += executableLines.length;
    executed += executedLines.length;
    rows.push({ file, changed: changedLines.size, executable: executableLines.length, executed: executedLines.length, uncoveredLines });
  }

  const percent = executable === 0 ? undefined : (executed / executable) * 100;
  const markdown = [
    '### Changed-line execution report (non-blocking)',
    '',
    `Diff: \`${diffBase}..${diffHead}\``,
    `Changed source lines: ${changed}; executable changed lines: ${executable}; executed: ${executed}; rate: ${percent === undefined ? 'N/A' : `${percent.toFixed(2)}%`}`,
    '',
    '| File | Changed | Executable | Executed | Rate | Uncovered executable lines |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...(rows.length === 0
      ? ['| (no changed src TypeScript files) | 0 | 0 | 0 | N/A | - |']
      : rows.map((row) => `| \`${row.file}\` | ${row.changed} | ${row.executable} | ${row.executed} | ${row.executable === 0 ? 'N/A' : `${((row.executed / row.executable) * 100).toFixed(2)}%`} | ${row.uncoveredLines.length ? row.uncoveredLines.join(', ') : '-'} |`)),
  ].join('\n');
  appendSummary(markdown);
  process.exit(0);
}

const summary = readJson(summaryPath, 'coverage-summary');
if (!summary?.total || typeof summary.total !== 'object') {
  fail('自检失败：coverage-summary 缺少 total');
}

const current = {};
for (const metric of METRICS) {
  const value = summary.total[metric]?.pct;
  if (!validPercentage(value)) fail(`自检失败：coverage-summary.total 缺少有效的 ${metric}.pct`);
  current[metric] = value;
}

let failed = false;
let improved = false;
for (const metric of METRICS) {
  const delta = current[metric] - baseline[metric];
  console.log(`[coverage-ratchet] ${metric} current=${current[metric].toFixed(2)}% baseline=${baseline[metric].toFixed(2)}% delta=${delta >= 0 ? '+' : ''}${delta.toFixed(2)}pp`);
  if (delta < 0) {
    failed = true;
    console.error(`[coverage-ratchet] ✗ ${metric} 低于基线 ${Math.abs(delta).toFixed(2)} 个百分点`);
  } else if (delta > 0) {
    improved = true;
  }
}

if (failed) fail('覆盖率回退，任一项低于基线都不允许通过');
if (improved) {
  console.log(`[coverage-ratchet] ✓ 覆盖率已提升，请把基线上调到实测值：${METRICS.map((metric) => `${metric}=${current[metric].toFixed(2)}%`).join(', ')}`);
} else {
  console.log('[coverage-ratchet] ✓ 四项覆盖率均与基线持平');
}
