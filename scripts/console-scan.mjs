#!/usr/bin/env node
// ============================================================================
// console-scan — 静态门：限制裸 console.log / console.debug 的蔓延
// ============================================================================
//
// 规则：
//   - 扫描 src/**/*.{ts,tsx}
//   - 命中裸 `console.log` / `console.debug`（允许 console.error / console.warn）
//   - 同行带 `// console-scan-allow` 注释的豁免
//   - 排除 tests/**、scripts/**、*.test.* 、*.d.ts
//
// 落地策略（基线棘轮，非一次性 hard-fail）：
//   现状有大量历史 console.log（建库时 328 处），一上来 hard-fail 会卡死所有 PR。
//   因此采用「棘轮」：命中数 <= BASELINE_MAX 视为通过（打印趋势）；> BASELINE_MAX 才 exit 1。
//   基线只能往下走（清理一处就手动调小 BASELINE_MAX），新增超基线即红。
//   待清零后可改为 BASELINE_MAX = 0 的真正 hard-fail。
//
// 退出码：命中数 > BASELINE_MAX → exit 1；否则 exit 0。
// 用法：node scripts/console-scan.mjs [扫描根，默认 src]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

// 基线上限：当前代码库的历史 console.log/debug 命中数（脚本口径实测 318）。
// 清理后请调小此值（棘轮只降不升）。待清零后改为 0 即真正 hard-fail。
const BASELINE_MAX = 318;

const ALLOW_COMMENT = 'console-scan-allow';
const VIOLATION_PATTERN = /\bconsole\.(log|debug)\s*\(/;
const sourceExtensions = new Set(['.ts', '.tsx']);

const roots = process.argv.slice(2).map((item) => path.resolve(item));
const scanRoots = (roots.length > 0 ? roots : [path.join(repoRoot, 'src')]).filter((item) => fs.existsSync(item));

function toDisplayPath(filePath) {
  const relative = path.relative(repoRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isExcluded(filePath) {
  const posix = toPosix(toDisplayPath(filePath));
  return (
    posix.includes('/node_modules/') ||
    posix.startsWith('tests/') ||
    posix.includes('/tests/') ||
    posix.startsWith('scripts/') ||
    posix.endsWith('.test.ts') ||
    posix.endsWith('.test.tsx') ||
    posix.endsWith('.d.ts')
  );
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, acc);
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      if (!isExcluded(full)) acc.push(full);
    }
  }
}

const files = [];
for (const root of scanRoots) {
  const stat = fs.statSync(root);
  if (stat.isDirectory()) walk(root, files);
  else if (stat.isFile() && sourceExtensions.has(path.extname(root)) && !isExcluded(root)) files.push(root);
}

const violations = [];
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, idx) => {
    if (VIOLATION_PATTERN.test(line) && !line.includes(ALLOW_COMMENT)) {
      violations.push(`${toDisplayPath(file)}:${idx + 1}`);
    }
  });
}

const count = violations.length;
console.log(`[console-scan] 扫描 ${files.length} 个文件，命中 console.log/debug ${count} 处（基线上限 ${BASELINE_MAX}）`);

if (count > BASELINE_MAX) {
  console.error(`[console-scan] ✗ 命中数 ${count} 超过基线 ${BASELINE_MAX}，请移除新增的 console.log/debug（或改用 logger，或加 // ${ALLOW_COMMENT} 豁免）`);
  // 仅打印前 50 条，避免刷屏
  for (const v of violations.slice(0, 50)) console.error(`  ${v}`);
  if (violations.length > 50) console.error(`  ...以及另外 ${violations.length - 50} 处`);
  process.exit(1);
}

if (count < BASELINE_MAX) {
  console.log(`[console-scan] ✓ 低于基线 ${BASELINE_MAX - count} 处 —— 可把脚本里的 BASELINE_MAX 调小到 ${count} 收紧棘轮`);
} else {
  console.log('[console-scan] ✓ 等于基线，通过（未新增）');
}
process.exit(0);
