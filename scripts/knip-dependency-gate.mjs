#!/usr/bin/env node
// ============================================================================
// knip-dependency-gate — 依赖维度零容忍门
// ============================================================================
//
// 为什么单开一道：`knip.json` 里 `"ignoreDependencies": [".*"]` 一条 catch-all
// 把整个依赖维度关掉了，所以那道 dead-export 棘轮对「孤儿依赖 / 未声明依赖」
// 覆盖是 0。四个死 `@types` 能在仓里躺着没人发现，根因就在这。
// 2026-08-10 清账时实测：**16 条未声明**（含 native 的 `onnxruntime-node`）、
// 4 个 unused。它们全靠 transitive hoisting 活着，上游任一父包调整依赖树就是
// 运行时 `MODULE_NOT_FOUND`，而且**只在打包后的 app 里炸**（开发树永远有它）。
//
// 不做成棘轮，做成**零容忍**：清完就是 0，没有存量债要背，
// 「零豁免优于有豁免机制」。
//
// 🔴 范围由 `--include` 划定，不用 ignore 毯子盖：只管
// dependencies / unlisted / unresolved 三项。**binaries 维度不在本门内**——
// 它报的是 clang / xattr / otool 这类系统工具，不是 npm 包、无从声明，
// 属于另一条轴另一张单。要开就显式开，别用 `ignoreBinaries: [".*"]` 假装看过。
//
// 用法：node scripts/knip-dependency-gate.mjs
// ============================================================================

import { spawnSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { KNIP_VERSION } from './lib/knipVersion.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'knip.dependencies.json';
const INCLUDE = 'dependencies,unlisted,unresolved';

function fail(message) {
  console.error(`[knip-dependency-gate] ✗ ${message}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(path.join(repoRoot, CONFIG), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

// ── 自检 1：配置的扫描范围必须真的命中文件 ────────────────────────────────
// 没有这条，「把 entry/project 改窄到什么都不扫」会表现成「0 个问题，通过」，
// 是典型的假绿（门在但没在看）。
for (const [field, patterns] of [['entry', config.entry], ['project', config.project]]) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    fail(`${CONFIG} 的 ${field} 为空——门失去测量能力，不能按通过处理。`);
  }
  for (const pattern of patterns) {
    if (globSync(pattern, { cwd: repoRoot }).length === 0) {
      fail(`${CONFIG} 的 ${field} 里 "${pattern}" 一个文件都没命中；范围写坏了。`);
    }
  }
}

// ── 自检 2：豁免名单不许留僵尸 ────────────────────────────────────────────
// 被豁免的包哪天不再是依赖了，这条豁免就该跟着删；留着会在下次有同名包进来时
// 悄悄给它开后门。
const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
]);
const zombies = (config.ignoreDependencies ?? []).filter((name) => !declared.has(name));
if (zombies.length > 0) {
  fail(`${CONFIG} 的 ignoreDependencies 里有已不再声明的包，请删掉：\n  - ${zombies.join('\n  - ')}`);
}

// ── 真跑 ──────────────────────────────────────────────────────────────────
// 与 knip-ratchet 同一套调用：knip 不在 node_modules 里，走 npx 且版本钉死。
// 版本常量走 lib/knipVersion.mjs 单一真源（别直接 import knip-ratchet.mjs——
// 它是脚本、顶层就跑，import 一下会顺带跑掉一整轮 dead-export 扫描）。
const result = spawnSync(
  'npx',
  ['--yes', `knip@${KNIP_VERSION}`, '--config', CONFIG,
    '--include', INCLUDE, '--no-progress', '--reporter', 'json'],
  { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);

if (result.error) fail(`knip 没跑起来：${result.error.message}`);

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  // 解析不了就说明 knip 崩了/换了输出格式——静默通过等于门瞎了。
  fail(`knip 输出不是 JSON（exit=${result.status}）。前 400 字：\n${(result.stdout || result.stderr || '').slice(0, 400)}`);
}

const issues = Array.isArray(report.issues) ? report.issues : null;
if (issues === null) fail('knip 报告里没有 issues 数组；输出契约变了，需要同步本门。');

const findings = [];
for (const entry of issues) {
  for (const field of ['dependencies', 'devDependencies', 'optionalPeerDependencies', 'unlisted', 'unresolved']) {
    for (const item of entry[field] ?? []) {
      findings.push(`${field}: ${item.name ?? item} (${entry.file})`);
    }
  }
}

if (findings.length > 0) {
  console.error(`[knip-dependency-gate] 依赖维度发现 ${findings.length} 处：`);
  for (const finding of findings) console.error(`  - ${finding}`);
  console.error('');
  console.error('  未声明（unlisted）：补进 package.json。判档看消费位置——');
  console.error('    src/host/** → dependencies；src/renderer/** 或 tests/scripts → devDependencies');
  console.error('    （renderer 由 Vite 全量打包，与 react-markdown / rehype-katex 同档）');
  console.error('  未使用（dependencies）：先确认不是动态解析（runtimeRequire.resolve 这类静态');
  console.error('    分析看不见的），确实死了就删；确实是假阳性再进 ignoreDependencies 并写明理由。');
  fail(`依赖维度必须为 0，实际 ${findings.length}。`);
}

console.log(`[knip-dependency-gate] ✓ 依赖维度 0 处（扫描范围自检通过，豁免名单 ${(config.ignoreDependencies ?? []).length} 项均在册）`);
