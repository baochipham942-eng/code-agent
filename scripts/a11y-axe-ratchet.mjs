#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function fail(message) {
  console.error(`[a11y-axe-ratchet] ✗ ${message}`);
  process.exit(1);
}

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} 缺少参数值`);
  return value;
}

const valueOptions = new Set(['--repo-root', '--baseline', '--report', '--compare-baseline']);
const flagOptions = new Set(['--record']);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (valueOptions.has(arg)) {
    index += 1;
    if (index >= args.length || args[index].startsWith('--')) fail(`${arg} 缺少参数值`);
  } else if (!flagOptions.has(arg)) {
    fail(`不支持的参数：${arg}`);
  }
}

const recordOnly = args.includes('--record');
const repoRoot = path.resolve(option('--repo-root', path.resolve(scriptDir, '..')));
const baselineRelative = option('--baseline', 'scripts/a11y-axe-ratchet-baseline.json');
const baselinePath = path.resolve(repoRoot, baselineRelative);
const reportPath = path.resolve(repoRoot, option('--report', 'test-results/axe/axe-report.json'));
const compareBaselineRef = option('--compare-baseline', undefined);

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

function validRuleCounts(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`自检失败：${label}缺少 ruleCounts 对象`);
  }
  for (const [rule, count] of Object.entries(value)) {
    if (!rule.trim() || !Number.isInteger(count) || count < 0) {
      fail(`自检失败：${label}规则 ${JSON.stringify(rule)} 的命中数必须是非负整数`);
    }
  }
  return value;
}

function validateReport(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
    fail('自检失败：axe 报告缺少 schemaVersion=1');
  }
  if (!Array.isArray(value.scans) || value.scans.length === 0) {
    fail('自检失败：axe 报告没有任何扫描结果');
  }
  const reportedCounts = validRuleCounts(value.ruleCounts, 'axe 报告');
  const computedCounts = {};
  for (const [scanIndex, scan] of value.scans.entries()) {
    if (!scan || typeof scan !== 'object' || !Array.isArray(scan.violations)) {
      fail(`自检失败：axe 报告 scans[${scanIndex}] 缺少 violations`);
    }
    for (const violation of scan.violations) {
      if (!violation || typeof violation.id !== 'string' || !violation.id.trim()
        || !Array.isArray(violation.nodes)) {
        fail(`自检失败：axe 报告 scans[${scanIndex}] 含无效 violation`);
      }
      computedCounts[violation.id] = (computedCounts[violation.id] ?? 0) + violation.nodes.length;
    }
  }
  const orderedReported = JSON.stringify(Object.fromEntries(Object.entries(reportedCounts).sort()));
  const orderedComputed = JSON.stringify(Object.fromEntries(Object.entries(computedCounts).sort()));
  if (orderedReported !== orderedComputed) {
    fail(`自检失败：axe 报告 ruleCounts 与 scans 明细不一致（报告 ${orderedReported}，重算 ${orderedComputed}）`);
  }
  const hits = Object.values(computedCounts).reduce((sum, count) => sum + count, 0);
  if (!value.totals || value.totals.scans !== value.scans.length
    || value.totals.rules !== Object.keys(computedCounts).length || value.totals.hits !== hits) {
    fail('自检失败：axe 报告 totals 与扫描明细不一致');
  }
  if (typeof value.generatedAt !== 'string' || !value.generatedAt.trim()) {
    fail('自检失败：axe 报告缺少 generatedAt');
  }
  return value;
}

function validateBaseline(value, label = 'axe 基线') {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
    fail(`自检失败：${label}缺少 schemaVersion=1`);
  }
  validRuleCounts(value.ruleCounts, label);
  if (typeof value.measuredAt !== 'string' || !value.measuredAt.trim()
    || typeof value.source !== 'string' || !value.source.trim()) {
    fail(`自检失败：${label}必须保留非空 measuredAt 和 source 证据`);
  }
  return value;
}

function appendSummary(markdown) {
  process.stdout.write(`${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function runGit(gitArgs, purpose, { allowMissingPath = false } = {}) {
  const result = spawnSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status === 0) return result.stdout;
  if (allowMissingPath && result.status === 128
    && /does not exist in|exists on disk, but not in|path .* does not exist/.test(result.stderr)) return undefined;
  fail(`自检失败：git ${purpose} 失败：${result.stderr.trim() || `exit ${result.status}`}`);
}

const report = validateReport(readJson(reportPath, 'axe 报告'));

if (recordOnly) {
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const candidate = {
    schemaVersion: 1,
    measuredAt: report.generatedAt,
    source: runUrl
      ? `Swarm full CI ${runUrl}; artifact swarm-e2e-axe-${process.env.GITHUB_RUN_ID}`
      : `record mode ${path.relative(repoRoot, reportPath)}`,
    ruleCounts: report.ruleCounts,
  };
  appendSummary([
    '### axe runtime baseline recording',
    '',
    `Record-only: ${report.totals.scans} scans, ${report.totals.rules} violated rules, ${report.totals.hits} violating nodes.`,
    '',
    '```json',
    JSON.stringify(candidate, null, 2),
    '```',
  ].join('\n'));
  process.exit(0);
}

const baseline = validateBaseline(readJson(baselinePath, 'axe 基线'));

if (compareBaselineRef) {
  runGit(['cat-file', '-e', `${compareBaselineRef}^{commit}`], `解析基线参照 ${compareBaselineRef}`);
  const previousText = runGit(
    ['show', `${compareBaselineRef}:${baselineRelative.split(path.sep).join('/')}`],
    `读取 ${compareBaselineRef} 中的 axe 基线`,
    { allowMissingPath: true },
  );
  if (previousText === undefined) {
    console.log(`[a11y-axe-ratchet] ${compareBaselineRef} 尚无 axe 基线，本次建立 CI 实测初始基线`);
  } else {
    let previous;
    try {
      previous = JSON.parse(previousText);
    } catch (error) {
      fail(`自检失败：${compareBaselineRef} 中的 axe 基线 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
    validateBaseline(previous, `${compareBaselineRef} 中的 axe 基线`);
    const raised = [...new Set([
      ...Object.keys(previous.ruleCounts),
      ...Object.keys(baseline.ruleCounts),
    ])].filter((rule) => (baseline.ruleCounts[rule] ?? 0) > (previous.ruleCounts[rule] ?? 0));
    for (const rule of raised) {
      console.error(`[a11y-axe-ratchet] ✗ ${rule} 基线上调：${previous.ruleCounts[rule] ?? 0} -> ${baseline.ruleCounts[rule] ?? 0}`);
    }
    if (raised.length > 0) fail('axe 违规基线只许降不许升');
    console.log(`[a11y-axe-ratchet] ✓ 基线方向检查通过（相对 ${compareBaselineRef} 未上调）`);
  }
}

const rules = [...new Set([
  ...Object.keys(baseline.ruleCounts),
  ...Object.keys(report.ruleCounts),
])].sort();
const regressions = [];
const improvements = [];
for (const rule of rules) {
  const allowed = baseline.ruleCounts[rule] ?? 0;
  const current = report.ruleCounts[rule] ?? 0;
  if (current > allowed) regressions.push({ rule, allowed, current });
  if (current < allowed) improvements.push({ rule, allowed, current });
}

for (const { rule, allowed, current } of regressions) {
  console.error(`[a11y-axe-ratchet] ✗ ${rule} 超基线：${current} > ${allowed}`);
}
if (regressions.length > 0) {
  fail(`运行时可访问性违规增加了 ${regressions.length} 个规则；先修回或用 Swarm full 重新证明基线`);
}

for (const { rule, allowed, current } of improvements) {
  console.warn(`[a11y-axe-ratchet] ↓ ${rule} 已下降：${allowed} -> ${current}，请下调基线`);
}

appendSummary([
  '### axe runtime ratchet',
  '',
  `Pass: ${report.totals.scans} scans; ${report.totals.rules} violated rules; ${report.totals.hits} violating nodes; ${improvements.length} baseline reductions available.`,
].join('\n'));
