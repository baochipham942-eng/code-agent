#!/usr/bin/env node
// ============================================================================
// knip-ratchet — dead-export 棘轮门（与 console-scan 同构）
// ============================================================================
//
// 跑 knip（入口/范围见 knip.json）统计 unused exports + types，超基线即红。
// 存量 2026-07-02 实测 2785（exports 1502 + types 1283），大头是 barrel index.ts
// 的转口出口（消费方直接 import 源模块，转口本身无人走）——抽查 5 例 0 误报，
// 全部是"该出口确实没有任何 import 路径"的真阳性，故不设 allowlist 起步；
// 确属误报时用 knip.json 的 ignore 机制核销并在此注明。
//
// 棘轮：命中数 <= BASELINE_MAX 通过；清理后手动调小（只降不升）。
// 清理记录：2026-07-13 从 2881 清到 2748；2026-07-15 状态化 CUA 收口到 2747；
// 2026-07-21 Surface Execution V1 新增 57 处死出口清零（去 export/删声明），收到 2708。
// 2026-07-21 资料库 Batch 2：libraryClient 按需裁剪后收到 2707。
// knip 版本锁 6.24.0（未入 devDependencies，避免 lockfile/共享 node_modules 变更；
// CI 与本地统一走 npx knip@6.24.0，升版本须同步重测基线）。
//
// 用法：node scripts/knip-ratchet.mjs

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const BASELINE_MAX = 2704;
const KNIP_VERSION = '6.24.0';

const result = spawnSync(
  'npx',
  ['--yes', `knip@${KNIP_VERSION}`, '--include', 'exports,types', '--no-progress', '--reporter', 'json'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);

// knip 有 issue 时 exit 1 属正常；以 JSON 可解析为准判断门本身是否健康（自检 fail loud）
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

let count = 0;
const perFile = [];
for (const issue of report.issues) {
  const n = (issue.exports?.length ?? 0) + (issue.types?.length ?? 0);
  if (n > 0) {
    count += n;
    perFile.push({ file: issue.file, n });
  }
}

console.log(`[knip-ratchet] dead exports+types 命中 ${count} 处（基线上限 ${BASELINE_MAX}）`);

if (count > BASELINE_MAX) {
  console.error(`[knip-ratchet] ✗ 超基线 ${count - BASELINE_MAX} 处，请移除新增的无人引用出口（或确属误报时在 knip.json 里核销）`);
  for (const { file, n } of perFile.sort((a, b) => b.n - a.n).slice(0, 20)) console.error(`  ${n}\t${file}`);
  process.exit(1);
}
if (count < BASELINE_MAX) {
  console.log(`[knip-ratchet] ✓ 低于基线 ${BASELINE_MAX - count} 处 —— 可把 BASELINE_MAX 调小到 ${count} 收紧棘轮`);
} else {
  console.log('[knip-ratchet] ✓ 等于基线，通过（未新增）');
}
