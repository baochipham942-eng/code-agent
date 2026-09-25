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

const valueOptions = new Set(['--repo-root', '--baseline', '--report', '--journey', '--extra-renders']);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
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

let failed = false;
let lowered = false;
for (const report of reports) {
  const reference = baseline.journeys[report.journey].commitCount;
  const current = report.commitCount;
  const delta = current - reference;
  console.log(`[perf-journey-ratchet] ${report.journey} commitCount current=${current} baseline=${reference} wallClockMs=${report.wallClockMs} longTaskCount=${report.longTaskCount} hotRenderCount=${report.hotRenderCount}`);
  if (current > reference) {
    failed = true;
    console.error(`[perf-journey-ratchet] ✗ ${report.journey} commitCount 上升：${reference} -> ${current} (+${delta})。这是确定性计数回归，禁止合入；把多余 commit 从热路径拿掉。`);
  } else if (current < reference) {
    lowered = true;
    console.error(`[perf-journey-ratchet] ✗ ${report.journey} commitCount 下降：${reference} -> ${current}。请在同一 PR 把 scripts/perf-journey-ratchet-baseline.json 里该 journey 的 commitCount 降到 ${current}，并在 reason 里记下这次赢得的 commit。不要自动改写基线。`);
  }
}

if (failed || lowered) process.exit(1);
console.log(`[perf-journey-ratchet] ✓ ${journeys.join(', ')} commitCount 均未超基线`);
