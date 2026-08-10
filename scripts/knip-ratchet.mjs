#!/usr/bin/env node
// ============================================================================
// knip-ratchet — dead-export 棘轮门（集合基线）
// ============================================================================
//
// 跑 knip 收集 unused exports + types。profile 决定入口/范围与独立基线；基线记录每个
// 文件、符号名和类别；当前结果中不在基线的符号即阻塞。这样同一批清理存量
// 死导出时，不能再用净计数下降掩盖新造的死导出。
//
// 2026-08-07 本地与 CI 的总数曾相差一处。集合基线必须以 CI 首次点名的额外
// 符号补齐，不能用“允许 N 个未知新增”的宽容度掩盖环境差异。
// knip 版本锁 6.24.0；升版本须先重测并有意更新基线。
//
// 用法：
//   node scripts/knip-ratchet.mjs
//   node scripts/knip-ratchet.mjs --update-baseline
//   node scripts/knip-ratchet.mjs --profile production
//   node scripts/knip-ratchet.mjs --profile production --update-baseline

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const KNIP_VERSION = '6.24.0';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const profiles = {
  default: {
    baselineFile: 'knip-ratchet-baseline.json',
    configFile: null,
    label: 'dead-export',
  },
  production: {
    baselineFile: 'knip-production-export-ratchet-baseline.json',
    configFile: 'knip.production-strict.json',
    label: 'production dead-export',
  },
};

const args = process.argv.slice(2);
const updateBaseline = args.includes('--update-baseline');
const profileIndex = args.indexOf('--profile');
const profileName = profileIndex === -1 ? 'default' : args[profileIndex + 1];
const consumedArgumentIndexes = new Set([...(updateBaseline ? [args.indexOf('--update-baseline')] : []), ...(profileIndex === -1 ? [] : [profileIndex, profileIndex + 1])]);
const unknownArguments = args.filter((_, index) => !consumedArgumentIndexes.has(index));
const profile = profiles[profileName];

if (!profile || unknownArguments.length > 0) {
  const detail = !profile ? `未知 profile：${profileName}` : `不支持的参数：${unknownArguments.join(', ')}`;
  console.error(`[knip-ratchet] ✗ ${detail}；仅支持 --update-baseline 和 --profile production`);
  process.exit(1);
}

const baselinePath = path.join(scriptDir, profile.baselineFile);

function compareSymbols(a, b) {
  return a.file.localeCompare(b.file) || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind);
}

function symbolKey(symbol) {
  return `${symbol.file}\u0000${symbol.kind}\u0000${symbol.name}`;
}

function formatSymbol(symbol) {
  return `${symbol.file}: ${symbol.name} (${symbol.kind})`;
}

function collectSymbols(report) {
  const symbols = [];
  for (const issue of report.issues) {
    for (const entry of issue.exports ?? []) symbols.push({ file: issue.file, name: entry.name, kind: 'export' });
    for (const entry of issue.types ?? []) symbols.push({ file: issue.file, name: entry.name, kind: 'type' });
  }
  return symbols.sort(compareSymbols);
}

function readBaseline() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    console.error(`[knip-ratchet] ✗ 自检失败：无法读取基线 ${path.relative(process.cwd(), baselinePath)}：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.symbols)
    || parsed.symbols.some((symbol) => !symbol || typeof symbol.file !== 'string' || typeof symbol.name !== 'string'
      || !['export', 'type'].includes(symbol.kind))) {
    console.error('[knip-ratchet] ✗ 自检失败：基线格式无效，预期 schemaVersion=1 和有序 symbols[]');
    process.exit(1);
  }
  return parsed.symbols.sort(compareSymbols);
}

const result = spawnSync(
  'npx',
  ['--yes', `knip@${KNIP_VERSION}`, ...(profile.configFile ? ['--config', profile.configFile] : []), '--include', 'exports,types', '--no-progress', '--reporter', 'json'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);

// knip 有 issue 时 exit 1 属正常；以 JSON 可解析为准判断门本身是否健康（自检 fail loud）。
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error('[knip-ratchet] ✗ 自检失败：knip 输出不可解析（工具未装好/配置损坏/被 kill）');
  console.error(result.stderr?.slice(0, 2000) || '(无 stderr)');
  process.exit(1);
}
if (!Array.isArray(report.issues)) {
  console.error('[knip-ratchet] ✗ 自检失败：knip JSON 里没有 issues 数组，报告格式变了，请同步更新本脚本');
  process.exit(1);
}

const currentSymbols = collectSymbols(report);
if (updateBaseline) {
  fs.writeFileSync(baselinePath, `${JSON.stringify({ schemaVersion: 1, symbols: currentSymbols }, null, 2)}\n`);
  console.log(`[knip-ratchet] ${profile.label} 扫描完成：${report.issues.length} 个命中文件，${currentSymbols.length} 个 dead export/type 符号`);
  console.log(`[knip-ratchet] ✓ 已更新 ${path.relative(process.cwd(), baselinePath)}；CI 首跑若点名环境额外符号，核实后将其补入此集合`);
  process.exit(0);
}

const baselineSymbols = readBaseline();
const baselineKeys = new Set(baselineSymbols.map(symbolKey));
const currentKeys = new Set(currentSymbols.map(symbolKey));
const added = currentSymbols.filter((symbol) => !baselineKeys.has(symbolKey(symbol)));
const removed = baselineSymbols.filter((symbol) => !currentKeys.has(symbolKey(symbol)));

console.log(`[knip-ratchet] ${profile.label} 扫描完成：${report.issues.length} 个命中文件；当前 ${currentSymbols.length} 个符号，基线 ${baselineSymbols.length} 个符号`);

if (added.length > 0) {
  console.error(`[knip-ratchet] ✗ 发现 ${added.length} 个新增 dead export/type，不能由存量清理抵消：`);
  for (const symbol of added) console.error(`  ${formatSymbol(symbol)}`);
  process.exit(1);
}

if (removed.length > 0) {
  console.log(`[knip-ratchet] ✓ 未新增；有 ${removed.length} 个存量符号已清理，可运行 --update-baseline 从基线移除：`);
  for (const symbol of removed) console.log(`  ${formatSymbol(symbol)}`);
} else {
  console.log('[knip-ratchet] ✓ 未新增；当前符号集合与基线一致');
}
