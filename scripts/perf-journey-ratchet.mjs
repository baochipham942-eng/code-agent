#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const JOURNEY_IDS = ['cold-start', 'first-token', 'long-session', 'session-switch'];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

// Post-merge swarm-ci `perf-journey-ratchet` (push to main, no path filter) re-runs
// all four journeys. That is the safety net for product paths that PR-time
// gates:fast no longer selects: each shared product path is attached to exactly
// one journey. Shared probe infra (journey-probe-*, journey-browser-smoke.ts,
// this script and its baseline) still selects all four.

function fail(message) {
  console.error(`[perf-journey-ratchet] ✗ ${message}`);
  process.exit(1);
}

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} 缺少参数值`);
  return value;
}

const flagOptions = new Set(['--tighten']);
const valueOptions = new Set(['--repo-root', '--baseline', '--report', '--journey', '--extra-renders']);
const tighten = args.includes('--tighten');
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (flagOptions.has(arg)) continue;
  if (valueOptions.has(arg)) {
    index += 1;
    if (index >= args.length || args[index].startsWith('--')) fail(`${arg} 缺少参数值`);
  } else {
    fail(`不支持的参数：${arg}`);
  }
}

const repoRoot = path.resolve(option('--repo-root', path.resolve(scriptDir, '..')));
const baselineRelative = option('--baseline', 'scripts/perf-journey-ratchet-baseline.json');
const baselinePath = path.resolve(repoRoot, baselineRelative);
const reportOption = option('--report', undefined);
const journeyOption = option('--journey', 'all');
const extraRenders = option('--extra-renders', undefined);

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

function validateBaseline(value, label = 'perf-journey 基线') {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
    fail(`自检失败：${label}缺少 schemaVersion=1`);
  }
  if (typeof value.reason !== 'string' || !value.reason.trim()) {
    fail(`自检失败：${label}必须保留非空 reason`);
  }
  if (!value.journeys || typeof value.journeys !== 'object' || Array.isArray(value.journeys)) {
    fail(`自检失败：${label}缺少 journeys 对象`);
  }
  for (const id of JOURNEY_IDS) {
    const entry = value.journeys[id];
    if (!entry || typeof entry !== 'object') fail(`自检失败：${label}缺少 journeys.${id}`);
    if (!Number.isInteger(entry.commitCount) || entry.commitCount < 0) {
      fail(`自检失败：${label} journeys.${id}.commitCount 必须是非负整数`);
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      fail(`自检失败：${label} journeys.${id}.reason 必须非空`);
    }
  }
  const unknown = Object.keys(value.journeys).filter((id) => !JOURNEY_IDS.includes(id));
  if (unknown.length) fail(`自检失败：${label}含未知 journey：${unknown.join(', ')}`);
  return value;
}

function validateReport(value, expectedJourney) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
    fail('自检失败：probe 报告缺少 schemaVersion=1');
  }
  if (value.journey !== expectedJourney) {
    fail(`自检失败：probe 报告 journey=${value.journey}，期望 ${expectedJourney}`);
  }
  if (!Number.isInteger(value.commitCount) || value.commitCount < 0) {
    fail(`自检失败：probe 报告 ${expectedJourney} commitCount 必须是非负整数`);
  }
  return value;
}

function selectedJourneys() {
  if (journeyOption === 'all') return [...JOURNEY_IDS];
  if (!JOURNEY_IDS.includes(journeyOption)) fail(`未知 journey：${journeyOption}`);
  return [journeyOption];
}

function runProbe(journey) {
  const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  const smoke = path.join(repoRoot, 'scripts/perf/journey-browser-smoke.ts');
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'perf-journey-ratchet-'));
  const reportPath = path.join(tempDir, `${journey}.json`);
  const argv = [tsxCli, smoke, '--journey', journey, '--out', reportPath];
  if (extraRenders !== undefined) argv.push('--extra-renders', extraRenders);
  const result = spawnSync(process.execPath, argv, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    rmSync(tempDir, { recursive: true, force: true });
    fail(`probe ${journey} 失败：${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  const report = validateReport(readJson(reportPath, `${journey} probe 报告`), journey);
  rmSync(tempDir, { recursive: true, force: true });
  return report;
}

function tightenCommand() {
  const parts = ['node scripts/perf-journey-ratchet.mjs'];
  if (journeyOption !== 'all') parts.push('--journey', journeyOption);
  parts.push('--tighten');
  return parts.join(' ');
}

function writeStepSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  writeFileSync(file, `${markdown.endsWith('\n') ? markdown : `${markdown}\n`}`, { flag: 'a' });
}

function formatSummary({ comparisons, increases, decreases }) {
  const rows = comparisons.map((entry) => {
    const delta = entry.current - entry.reference;
    const signed = delta > 0 ? `+${delta}` : String(delta);
    let status = 'hold';
    if (delta > 0) status = 'regression';
    else if (delta < 0) status = `can tighten ${entry.reference} → ${entry.current}`;
    return `| ${entry.journey} | ${entry.current} | ${entry.reference} | ${signed} | ${status} |`;
  });
  const lines = [
    '## Perf journey ratchet',
    '',
    '| journey | current | baseline | delta | status |',
    '|---|---:|---:|---:|---|',
    ...rows,
    '',
  ];
  if (increases.length) {
    lines.push(`**Regressions (blocking):** ${increases.map((entry) => `${entry.journey} ${entry.reference} → ${entry.current}`).join(', ')}`, '');
  }
  if (decreases.length) {
    lines.push(`**Can tighten:** ${decreases.map((entry) => `${entry.journey} ${entry.reference} → ${entry.current}`).join(', ')}`, '');
    lines.push('```bash', tightenCommand(), '```', '');
  } else {
    lines.push('**Can tighten:** none', '');
  }
  lines.push('This job has no path filter and always runs all four journeys. It is the safety net for product paths that PR-time `gates:fast` no longer selects (each shared path is attached to exactly one journey).');
  return `${lines.join('\n')}\n`;
}

function writeBaseline(next) {
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
}

const journeys = selectedJourneys();
const baseline = validateBaseline(readJson(baselinePath, 'perf-journey 基线'));
const reports = [];

if (reportOption) {
  const raw = readJson(path.resolve(repoRoot, reportOption), 'probe 报告');
  const list = Array.isArray(raw) ? raw : [raw];
  if (journeys.length === 1 && list.length === 1) {
    reports.push(validateReport(list[0], journeys[0]));
  } else {
    for (const id of journeys) {
      const match = list.find((entry) => entry && entry.journey === id);
      if (!match) fail(`probe 报告缺少 journey ${id}`);
      reports.push(validateReport(match, id));
    }
  }
} else {
  for (const id of journeys) reports.push(runProbe(id));
}

const comparisons = [];
const increases = [];
const decreases = [];
for (const report of reports) {
  const reference = baseline.journeys[report.journey].commitCount;
  const current = report.commitCount;
  const delta = current - reference;
  comparisons.push({ journey: report.journey, current, reference, delta });
  console.log(`[perf-journey-ratchet] ${report.journey} commitCount current=${current} baseline=${reference} wallClockMs=${report.wallClockMs} longTaskCount=${report.longTaskCount} hotRenderCount=${report.hotRenderCount}`);
  if (current > reference) {
    increases.push({ journey: report.journey, current, reference, delta });
    console.error(`[perf-journey-ratchet] ✗ ${report.journey} commitCount 上升：${reference} -> ${current} (+${delta})。这是确定性计数回归，禁止合入；把多余 commit 从热路径拿掉。`);
  } else if (current < reference) {
    decreases.push({ journey: report.journey, current, reference, delta });
  }
}

if (tighten) {
  if (increases.length) {
    writeStepSummary(formatSummary({ comparisons, increases, decreases }));
    fail(`拒绝 --tighten：存在高于基线的 journey（${increases.map((entry) => `${entry.journey} ${entry.reference}→${entry.current}`).join(', ')}），禁止抬高基线。未写入 ${path.relative(repoRoot, baselinePath)}`);
  }
  if (!decreases.length) {
    writeStepSummary(formatSummary({ comparisons, increases, decreases }));
    console.log(`[perf-journey-ratchet] --tighten：没有可收紧的 journey`);
    console.log(`[perf-journey-ratchet] ✓ ${journeys.join(', ')} commitCount 均未超基线`);
    process.exit(0);
  }
  const when = new Date().toISOString();
  const tightened = decreases.map((entry) => `${entry.journey} ${entry.reference}→${entry.current}`).join(', ');
  const nextJourneys = {};
  for (const id of JOURNEY_IDS) {
    const entry = baseline.journeys[id];
    const drop = decreases.find((item) => item.journey === id);
    if (drop) {
      nextJourneys[id] = {
        commitCount: drop.current,
        reason: `${entry.reason} Tightened ${drop.reference}→${drop.current} on ${when} via --tighten.`,
      };
    } else {
      nextJourneys[id] = { commitCount: entry.commitCount, reason: entry.reason };
    }
  }
  writeBaseline({
    schemaVersion: 1,
    reason: `${when} --tighten lowered ${tightened}.`,
    journeys: nextJourneys,
  });
  writeStepSummary(formatSummary({ comparisons, increases, decreases }));
  console.log(`[perf-journey-ratchet] ✓ --tighten 已写入 ${path.relative(repoRoot, baselinePath)}：${tightened}`);
  process.exit(0);
}

writeStepSummary(formatSummary({ comparisons, increases, decreases }));

if (decreases.length) {
  for (const entry of decreases) {
    console.log(`[perf-journey-ratchet] ℹ ${entry.journey} commitCount 下降：${entry.reference} -> ${entry.current}。门通过。收紧基线：${tightenCommand()}`);
  }
}

if (increases.length) process.exit(1);
console.log(`[perf-journey-ratchet] ✓ ${journeys.join(', ')} commitCount 均未超基线`);
