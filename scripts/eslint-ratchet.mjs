#!/usr/bin/env node
// ============================================================================
// eslint-ratchet — ESLint error / warning 双基线棘轮门
// ============================================================================
//
// 当前存量（2026-07-16 实测）：55 errors + 1893 warnings。
// 两条基线彼此独立、只能下降：任一计数超基线都阻塞 CI；清理后把对应常量
// 调小到新的实测值，禁止为放行新增问题而抬高基线。
//
// 自检 guard 有意 fail loud：0 文件、不可解析 JSON、缺失 errorCount / warningCount
// 都说明门本身已经失去测量能力。此时静默通过会制造“门在但没在看”的假绿。
//
// 用法：node scripts/eslint-ratchet.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BASELINE_ERROR_MAX = 55;
const BASELINE_WARNING_MAX = 1876;
const MAX_FINDINGS_TO_PRINT = 50;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const eslintBin = path.join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');

const result = spawnSync(
  process.execPath,
  [eslintBin, 'src', '--ext', '.ts,.tsx', '--format', 'json'],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  },
);

if (result.error || result.signal || result.status === null || result.status > 1) {
  console.error('[eslint-ratchet] ✗ 自检失败：ESLint 未正常产生报告（工具未安装/配置损坏/被 kill）');
  console.error(result.error?.message || result.stderr?.slice(0, 2000) || `(status=${result.status}, signal=${result.signal ?? 'none'})`);
  process.exit(1);
}

// ESLint 发现 lint errors 时 exit 1 属正常；门的真值来自可解析的 JSON 计数。
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error('[eslint-ratchet] ✗ 自检失败：ESLint JSON 不可解析，禁止在测量失效时静默通过');
  console.error(result.stderr?.slice(0, 2000) || '(no stderr)');
  process.exit(1);
}

if (!Array.isArray(report)) {
  console.error('[eslint-ratchet] ✗ 自检失败：ESLint JSON 顶层不是文件结果数组，报告格式已变更');
  process.exit(1);
}
if (report.length === 0) {
  console.error('[eslint-ratchet] ✗ 自检失败：ESLint 扫描 0 个文件，禁止源码路径失效时假绿');
  process.exit(1);
}

function hasValidCount(fileResult, field) {
  return Object.hasOwn(fileResult, field)
    && Number.isInteger(fileResult[field])
    && fileResult[field] >= 0;
}

for (const fileResult of report) {
  if (!fileResult || typeof fileResult !== 'object'
    || !hasValidCount(fileResult, 'errorCount')
    || !hasValidCount(fileResult, 'warningCount')) {
    const file = fileResult?.filePath ? path.relative(repoRoot, fileResult.filePath) : '(unknown file)';
    console.error(`[eslint-ratchet] ✗ 自检失败：${file} 缺少有效 errorCount / warningCount，报告格式已变更`);
    process.exit(1);
  }
}

const errors = report.reduce((sum, fileResult) => sum + fileResult.errorCount, 0);
const warnings = report.reduce((sum, fileResult) => sum + fileResult.warningCount, 0);

function formatDelta(current, baseline) {
  const delta = current - baseline;
  return delta > 0 ? `+${delta}` : String(delta);
}

console.log(`[eslint-ratchet] 扫描 ${report.length} 个文件`);
console.log(`[eslint-ratchet] errors current=${errors} baseline=${BASELINE_ERROR_MAX} delta=${formatDelta(errors, BASELINE_ERROR_MAX)}`);
console.log(`[eslint-ratchet] warnings current=${warnings} baseline=${BASELINE_WARNING_MAX} delta=${formatDelta(warnings, BASELINE_WARNING_MAX)}`);

const breachedSeverities = new Set();
if (errors > BASELINE_ERROR_MAX) breachedSeverities.add(2);
if (warnings > BASELINE_WARNING_MAX) breachedSeverities.add(1);

function gitPaths(args) {
  const gitResult = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return gitResult.status === 0 ? gitResult.stdout.split('\0').filter(Boolean) : [];
}

function displayPath(filePath) {
  const relative = path.relative(repoRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

if (breachedSeverities.size > 0) {
  const changedPaths = new Set([
    ...gitPaths(['diff', 'HEAD', '--name-only', '-z', '--']),
    ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const findings = report.flatMap((fileResult) => {
    const file = displayPath(fileResult.filePath);
    return (Array.isArray(fileResult.messages) ? fileResult.messages : [])
      .filter((message) => breachedSeverities.has(message.severity))
      .map((message) => ({
        file,
        line: message.line ?? 0,
        column: message.column ?? 0,
        ruleId: message.ruleId ?? 'unknown-rule',
        changed: changedPaths.has(file),
      }));
  }).sort((a, b) => Number(b.changed) - Number(a.changed)
    || a.file.localeCompare(b.file)
    || a.line - b.line
    || a.column - b.column);

  if (errors > BASELINE_ERROR_MAX) {
    console.error(`[eslint-ratchet] ✗ errors 超基线 ${errors - BASELINE_ERROR_MAX}；修复后若低于 ${BASELINE_ERROR_MAX}，把 BASELINE_ERROR_MAX 调小到新的 current 值`);
  }
  if (warnings > BASELINE_WARNING_MAX) {
    console.error(`[eslint-ratchet] ✗ warnings 超基线 ${warnings - BASELINE_WARNING_MAX}；修复后若低于 ${BASELINE_WARNING_MAX}，把 BASELINE_WARNING_MAX 调小到新的 current 值`);
  }
  console.error('[eslint-ratchet] 超基线 findings（已改动/未跟踪文件优先）：');
  for (const finding of findings.slice(0, MAX_FINDINGS_TO_PRINT)) {
    console.error(`  ${finding.file}:${finding.line}:${finding.column}:${finding.ruleId}`);
  }
  if (findings.length > MAX_FINDINGS_TO_PRINT) {
    console.error(`  ...另有 ${findings.length - MAX_FINDINGS_TO_PRINT} 处（已限制输出，避免 CI 日志刷屏）`);
  }
  process.exit(1);
}

if (errors < BASELINE_ERROR_MAX) {
  console.log(`[eslint-ratchet] ✓ 请把 BASELINE_ERROR_MAX 从 ${BASELINE_ERROR_MAX} 调小到 ${errors}`);
}
if (warnings < BASELINE_WARNING_MAX) {
  console.log(`[eslint-ratchet] ✓ 请把 BASELINE_WARNING_MAX 从 ${BASELINE_WARNING_MAX} 调小到 ${warnings}`);
}
if (errors === BASELINE_ERROR_MAX && warnings === BASELINE_WARNING_MAX) {
  console.log('[eslint-ratchet] ✓ 两条基线均持平，通过（未新增）');
} else {
  console.log('[eslint-ratchet] ✓ 未超基线，通过');
}
