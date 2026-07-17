#!/usr/bin/env node
// ============================================================================
// tsc-tests-ratchet — tests/ + scripts/ 的 TypeScript error 棘轮门
// ============================================================================
//
// 背景：根 tsconfig.json 的 include 只有 src/**，tests/ 和 scripts/ 一直在 tsc 门外
// （见 docs/audits/2026-07-17-tsc-gate-blindspot-tests-scripts-debt.md）。真实漏网：给函数
// 加参数漏改 scripts 侧调用方（A-8）、测试侧组合断裂溜进 main。本门用 typescript7 原生引擎
// 跑 tsconfig.tests.json（把 tests+scripts 纳入检查），error 计数只降不升。
//
// 存量基线（2026-07-18 实测）：CI(Linux)=1229 errors，本地(macOS arm64)=1228——差 1 是
// 平台相关的类型错（某个 error 只在 Linux 上浮现，clean npm ci 后仍稳定复现该差）。基线以
// 门的真正执行环境 CI 为准=1229；本地跑会显示 delta=-1（"可收紧到 1228"），那只是提示不阻塞。
// src 恒 0（tsconfig.tests.json include 带 src/** 只为加载 ambient 全局声明，不产生 src error）。
//
// ⚠️ Phase 2 清偿更新基线时：以 PR 自己 CI 跑出的 current 为准（本地读数比 CI 低 1），别照抄本地。
// 分批清偿见工单 docs/audits/2026-07-18-tsc-tests-scripts-ratchet-ticket.md。
//
// 清理记录：
//   2026-07-18 建门，基线 1229（CI）。
//   2026-07-18 B1：tsconfig.tests.json 开 allowImportingTsExtensions，消 82 处 TS5097（配置类，
//               非 bug）——本地 1228→1146，基线 1229→1147。
//
// 自检 guard 有意 fail loud（[[gate-must-report-own-blindspot]]）：引擎二进制/配置失效、
// 配置匹配 0 个文件（TS18003）、tsc 被 kill —— 任一发生都说明门失去测量能力，此时静默通过
// 就是"门在但没在看"的假绿，一律报红并指名道姓。
//
// 用法：node scripts/tsc-tests-ratchet.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BASELINE_MAX = 1147;
const MAX_FINDINGS_TO_PRINT = 40;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const tscBin = path.join(repoRoot, 'node_modules', 'typescript7', 'bin', 'tsc');
const tsconfigPath = path.join(repoRoot, 'tsconfig.tests.json');

// 建门三问之二：引擎二进制 / 配置失效 → 报红并指名道姓，别假绿。
if (!fs.existsSync(tscBin)) {
  console.error(`[tsc-tests-ratchet] ✗ 自检失败：找不到 typescript7 引擎 ${path.relative(repoRoot, tscBin)}（npm 依赖未装好？）`);
  process.exit(1);
}
if (!fs.existsSync(tsconfigPath)) {
  console.error(`[tsc-tests-ratchet] ✗ 自检失败：找不到 ${path.relative(repoRoot, tsconfigPath)}（门读的配置被删/改名）`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [tscBin, '-p', tsconfigPath, '--noEmit', '--pretty', 'false'],
  { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

// tsc 被 kill / 没跑起来（发现类型错时 exit 1 属正常，故只在 signal / spawn error / 无输出时判死）。
if (result.error || result.signal || result.status === null) {
  console.error('[tsc-tests-ratchet] ✗ 自检失败：tsc 未正常产生报告（被 kill / spawn 失败）');
  console.error(result.error?.message || `(status=${result.status}, signal=${result.signal ?? 'none'})`);
  process.exit(1);
}

// 建门三问之一：配置匹配 0 个文件（include glob 失效）→ 报红。TS18003 = "No inputs were found"，
// 静默过去会让"删光测试目录"这种改动假绿。TS6053/TS5083 = 配置文件读不出，同理判死。
for (const [code, why] of [
  ['TS18003', 'tsconfig 匹配 0 个文件（include glob 失效？）'],
  ['TS6053', 'tsconfig 引用的文件不存在'],
  ['TS5083', '无法读取 tsconfig'],
]) {
  if (output.includes(code)) {
    console.error(`[tsc-tests-ratchet] ✗ 自检失败：${why}（${code}）—— 门失去测量能力，禁止假绿`);
    process.exit(1);
  }
}

const lines = output.split('\n');
const errorLines = lines.filter((line) => /: error TS[0-9]+/.test(line));
const count = errorLines.length;

// exit 0（无错）但基线 > 0：要么是清到 0 了（好事），要么 tsc 根本没检查。用 count 兜底即可，
// 但若 exit 0 且 count 0 而基线仍 > 0，提示可把基线归零。
console.log(`[tsc-tests-ratchet] tests+scripts TypeScript errors current=${count} baseline=${BASELINE_MAX} delta=${count - BASELINE_MAX > 0 ? '+' : ''}${count - BASELINE_MAX}`);

if (count > BASELINE_MAX) {
  console.error(`[tsc-tests-ratchet] ✗ 超基线 ${count - BASELINE_MAX} 处——修掉新增的类型错（禁止用 as any / 删断言抹平语义，见工单围栏）`);
  const byFile = new Map();
  for (const line of errorLines) {
    const file = line.split('(')[0];
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  const sorted = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
  for (const [file, n] of sorted.slice(0, MAX_FINDINGS_TO_PRINT)) console.error(`  ${n}\t${file}`);
  if (sorted.length > MAX_FINDINGS_TO_PRINT) console.error(`  ...另有 ${sorted.length - MAX_FINDINGS_TO_PRINT} 个文件（已限制输出）`);
  process.exit(1);
}

if (count < BASELINE_MAX) {
  console.log(`[tsc-tests-ratchet] ✓ 低于基线 ${BASELINE_MAX - count} 处——把 BASELINE_MAX 调小到 ${count} 收紧棘轮`);
} else {
  console.log('[tsc-tests-ratchet] ✓ 等于基线，通过（未新增）');
}
