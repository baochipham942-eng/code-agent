#!/usr/bin/env node
// ============================================================================
// knip-dependency-gate — 依赖完整性 + 档位零容忍门
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
// 档位的地基是交付形态，不是源码目录：
// - 已发布 app 运行时要加载、又没被 esbuild/Vite 吃进 bundle 的直接包
//   才放 dependencies。具体是 esbuild.config.ts 的 NATIVE_EXTERNALS，
//   加上下方少量运行时字符串加载项。
// - 其余都在 devDependencies：host 的普通非 external 依赖会被 esbuild
//   bundle，renderer 会被 Vite bundle，type-only / tests / scripts 只在开发期需要。
//
// 这里没有档位豁免名单。RUNTIME_STRING_DEPENDENCIES 是真正的运行时
// 静态分析盲区，每条都绑定消费文件和理由，不是对错档消音。
//
// 🔴 范围由 `--include` 划定，不用 ignore 毯子盖：只管
// dependencies / unlisted / unresolved 三项。**binaries 维度不在本门内**——
// 它报的是 clang / xattr / otool 这类系统工具，不是 npm 包、无从声明，
// 属于另一条轴另一张单。要开就显式开，别用 `ignoreBinaries: [".*"]` 假装看过。
//
// 用法：node scripts/knip-dependency-gate.mjs
// ============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { KNIP_VERSION } from './lib/knipVersion.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'knip.dependencies.json';
const INCLUDE = 'dependencies,unlisted,unresolved';
const NPM_CACHE = '/tmp/code-agent-npm-cache';

const RUNTIME_EXTERNAL_CONSUMERS = {
  '@ui-tars/sdk': {
    consumer: 'src/host/tools/vision/guiAgent.ts',
    reason: 'GUIAgent 运行时动态加载，且在 NATIVE_EXTERNALS 中',
  },
  'better-sqlite3': {
    consumer: 'src/host/services/core/database/nativeLoader.ts',
    reason: 'nativeLoader 经 runtimeRequire 加载 Node-API 模块',
  },
  keytar: {
    consumer: 'src/host/services/core/secureStorage.ts',
    reason: 'secureStorage 运行时 require 的 native 钥匙串模块',
  },
  'node-pty': {
    consumer: 'src/host/services/terminal/terminalSessionManager.ts',
    reason: '终端会话运行时加载 PTY native 模块',
  },
  'onnxruntime-node': {
    consumer: 'src/host/services/desktop/audioVadRuntime.ts',
    reason: 'VAD 运行时按路径加载 ONNX native 模块',
  },
  playwright: {
    consumer: 'src/host/runtime/playwrightRuntime.ts',
    reason: '浏览器能力按需资产经 requireOptionalNodeModule 加载',
  },
  'playwright-core': {
    consumer: 'src/host/runtime/runtimeAssetRegistry.ts',
    reason: 'Playwright 运行时资产的必需客户端包',
  },
  sharp: {
    consumer: 'src/host/runtime/sharpRuntime.ts',
    reason: '图像处理运行时按路径加载 native 模块',
  },
};

const RUNTIME_STRING_DEPENDENCIES = {
  'avr-vad': {
    consumer: 'src/host/services/desktop/audioVadRuntime.ts',
    reason: "runtimeRequire.resolve('avr-vad') 定位 silero_vad_v5.onnx，模型资产不在 JS bundle 里",
  },
  jszip: {
    consumer: 'src/host/testing/artifactRunnableAdapter.ts',
    reason: "requireOptionalNodeModule('jszip') 经变量 require 加载，esbuild 无法静态收进 bundle",
  },
};

// 工具插件、peer provider 和测试环境不一定以 import 形式出现。
// 这些是可验证的隐式开发期消费方，不是档位豁免。
const IMPLICIT_DEV_CONSUMERS = {
  '@testing-library/dom': {
    consumer: 'tests/unit/renderer/useInAppValidationBridge.test.tsx',
    reason: '@testing-library/react 的必需 peer provider，只用于组件测试',
  },
  '@vitest/coverage-v8': {
    consumer: 'package.json#scripts.test:coverage',
    reason: 'vitest --coverage 的 coverage provider',
  },
  jsdom: {
    consumer: 'tests/unit/renderer/useInAppValidationBridge.test.tsx',
    reason: '@vitest-environment jsdom 测试环境',
  },
  'lint-staged': {
    consumer: 'lint-staged.config.mjs',
    reason: 'pre-commit 文件匹配与命令配置',
  },
  'react-is': {
    consumer: 'src/renderer/components/features/chat/MessageBubble/ChartRenderer.tsx',
    reason: 'renderer 的 recharts 直接 peer provider，由 Vite 吃进 bundle',
  },
};

function fail(message) {
  console.error(`[knip-dependency-gate] ✗ ${message}`);
  process.exit(1);
}

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
  } catch (error) {
    fail(`无法解析 ${relativePath}：${error instanceof Error ? error.message : String(error)}`);
  }
}

const config = readJson(CONFIG);
const manifest = readJson('package.json');

// ── 自检 0：从真实 esbuild 配置读取 external 地基 ───────────────────────
// 不在这里复制一份可漂移的包名表；配置数组改名/改成非字面量时
// 解析会 fail-loud，要求同步升级本门。
const esbuildConfigPath = path.join(repoRoot, 'esbuild.config.ts');
const esbuildConfigSource = readFileSync(esbuildConfigPath, 'utf8');
const nativeExternalsMatch = esbuildConfigSource.match(
  /const\s+NATIVE_EXTERNALS\s*=\s*\[([\s\S]*?)\]\s*;/,
);
if (!nativeExternalsMatch) {
  fail('esbuild.config.ts 里解析不出 NATIVE_EXTERNALS；档位地基已失效。');
}
const nativeExternals = [...nativeExternalsMatch[1].matchAll(/['"]([^'"]+)['"]/g)]
  .map((match) => match[1]);
if (nativeExternals.length === 0) {
  fail('esbuild.config.ts 的 NATIVE_EXTERNALS 解析为 0 个包；拒绝假绿。');
}

const dependencies = Object.keys(manifest.dependencies ?? {});
const devDependencies = Object.keys(manifest.devDependencies ?? {});
const allDeclared = [...dependencies, ...devDependencies];
if (allDeclared.length === 0) {
  fail('package.json 扫到 0 个 dependencies/devDependencies；拒绝假绿。');
}
const duplicateTiers = dependencies.filter((name) => devDependencies.includes(name));
if (duplicateTiers.length > 0) {
  fail(`同一包同时出现在两档：\n  - ${duplicateTiers.join('\n  - ')}`);
}

const runtimeStringDependencies = new Set(Object.keys(RUNTIME_STRING_DEPENDENCIES));
for (const [name, policy] of Object.entries(RUNTIME_STRING_DEPENDENCIES)) {
  if (!policy.reason?.trim() || !policy.consumer?.trim()) {
    fail(`运行时字符串依赖 ${name} 缺 consumer/reason；不允许无理由例外。`);
  }
  const consumerPath = path.join(repoRoot, policy.consumer);
  if (!existsSync(consumerPath)) {
    fail(`运行时字符串依赖 ${name} 的消费文件不存在：${policy.consumer}`);
  }
  if (!readFileSync(consumerPath, 'utf8').includes(name)) {
    fail(`运行时字符串依赖 ${name} 已不在 ${policy.consumer} 中；请重新判档。`);
  }
}
for (const [name, policy] of Object.entries(IMPLICIT_DEV_CONSUMERS)) {
  if (!policy.reason?.trim() || !policy.consumer?.trim()) {
    fail(`隐式开发消费方 ${name} 缺 consumer/reason。`);
  }
  const relativeConsumerPath = policy.consumer.split('#')[0];
  if (!existsSync(path.join(repoRoot, relativeConsumerPath))) {
    fail(`隐式开发消费方 ${name} 的证据文件不存在：${relativeConsumerPath}`);
  }
}

const requiredRuntimeDependencies = new Set([
  ...nativeExternals.filter((name) => allDeclared.includes(name)),
  ...runtimeStringDependencies,
]);
for (const name of nativeExternals.filter((candidate) => allDeclared.includes(candidate))) {
  const policy = RUNTIME_EXTERNAL_CONSUMERS[name];
  if (!policy?.reason?.trim() || !policy.consumer?.trim()) {
    fail(`已声明的 esbuild runtime external ${name} 缺 consumer/reason。`);
  }
  const consumerPath = path.join(repoRoot, policy.consumer);
  if (!existsSync(consumerPath) || !readFileSync(consumerPath, 'utf8').includes(name)) {
    fail(`esbuild runtime external ${name} 的消费证据已失效：${policy.consumer}`);
  }
}
for (const name of runtimeStringDependencies) {
  if (!allDeclared.includes(name)) {
    fail(`运行时字符串依赖 ${name} 未在根 package.json 声明。`);
  }
}

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

const consumerPatterns = [
  ...config.entry,
  ...config.project,
  'packages/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  '*.{ts,js,mjs,cjs}',
  'tsconfig*.json',
];
const scannedFiles = [...new Set(
  consumerPatterns.flatMap((pattern) => globSync(pattern, { cwd: repoRoot })),
)].filter((file) => file !== 'scripts/knip-dependency-gate.mjs');
if (scannedFiles.length === 0) {
  fail(`${CONFIG} 展开后消费文件为 0；拒绝假绿。`);
}

function sourcePriority(relativePath) {
  if (relativePath.startsWith('src/')) return 0;
  if (relativePath.startsWith('packages/')) return 1;
  if (relativePath.startsWith('scripts/')) return 2;
  if (relativePath.startsWith('tests/')) return 3;
  return 4;
}

const scannedSources = scannedFiles
  .map((relativePath) => ({
    relativePath,
    lines: readFileSync(path.join(repoRoot, relativePath), 'utf8').split(/\r?\n/),
  }))
  .sort((left, right) => (
    sourcePriority(left.relativePath) - sourcePriority(right.relativePath)
    || left.relativePath.localeCompare(right.relativePath)
  ));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceConsumer(name) {
  const specifier = new RegExp(`['"\\\`]${escapeRegExp(name)}(?:/[^'"\\\`]*)?['"\\\`]`);
  for (const { relativePath, lines } of scannedSources) {
    const lineIndex = lines.findIndex((line) => specifier.test(line));
    if (lineIndex >= 0) return `${relativePath}:${lineIndex + 1}`;
  }
  return null;
}

function manifestScriptConsumer(name) {
  const packageJsonPath = path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(packageJsonPath)) return null;
  const installed = readJson(path.relative(repoRoot, packageJsonPath));
  const bins = typeof installed.bin === 'string'
    ? [name.startsWith('@') ? name.split('/')[1] : name]
    : Object.keys(installed.bin ?? {});
  for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
    if (bins.some((bin) => new RegExp(`(^|[\\s;&|])${escapeRegExp(bin)}(?=$|[\\s;&|])`).test(command))) {
      return `package.json#scripts.${scriptName}`;
    }
  }
  return null;
}

function consumerFor(name) {
  return RUNTIME_EXTERNAL_CONSUMERS[name]?.consumer
    ?? RUNTIME_STRING_DEPENDENCIES[name]?.consumer
    ?? IMPLICIT_DEV_CONSUMERS[name]?.consumer
    ?? (name.startsWith('@types/')
      ? sourceConsumer(name.slice('@types/'.length)) ?? 'tsconfig.json#ambient-types'
      : null)
    ?? sourceConsumer(name)
    ?? manifestScriptConsumer(name);
}

const unresolvedConsumers = allDeclared.filter((name) => !consumerFor(name));
if (unresolvedConsumers.length > 0) {
  fail(
    `有 ${unresolvedConsumers.length}/${allDeclared.length} 个已声明包解析不出消费方；不能当作没问题：`
    + `\n  - ${unresolvedConsumers.join('\n  - ')}`,
  );
}
const parsedConsumerCount = allDeclared.length;

// ── 档位零容忍 ────────────────────────────────────────────────────────
const tierFindings = [];
for (const name of dependencies) {
  if (!requiredRuntimeDependencies.has(name)) {
    tierFindings.push({ name, actual: 'dependencies', expected: 'devDependencies' });
  }
}
for (const name of devDependencies) {
  if (requiredRuntimeDependencies.has(name)) {
    tierFindings.push({ name, actual: 'devDependencies', expected: 'dependencies' });
  }
}

if (tierFindings.length > 0) {
  console.error(`[knip-dependency-gate] 依赖档位发现 ${tierFindings.length} 处错档：`);
  for (const finding of tierFindings) {
    const consumer = consumerFor(finding.name);
    console.error(
      `  - ${finding.name}: ${finding.actual} → 应在 ${finding.expected}; `
      + `消费方=${consumer ?? '解析失败（fail-loud）'}`,
    );
  }
  fail(`依赖档位必须为 0 处错档，实际 ${tierFindings.length}。`);
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
  {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? NPM_CACHE },
  },
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
  console.error('  未声明（unlisted）：补进 package.json。判档看交付形态——');
  console.error('    app 运行时需要且未进 esbuild/Vite bundle → dependencies');
  console.error('    已 bundle，或 type-only / renderer / tests / scripts 开发期使用 → devDependencies');
  console.error('  未使用（dependencies）：先确认不是动态解析（runtimeRequire.resolve 这类静态');
  console.error('    分析看不见的），确实死了就删；确实是假阳性再进 ignoreDependencies 并写明理由。');
  fail(`依赖维度必须为 0，实际 ${findings.length}。`);
}

console.log(
  `[knip-dependency-gate] ✓ 依赖维度 0 处，档位 0 处错档`
  + `（声明 ${allDeclared.length} 包，运行时非 bundle ${requiredRuntimeDependencies.size} 包，`
  + `消费解析 ${parsedConsumerCount}/${allDeclared.length} 包·${scannedFiles.length} 文件，`
  + `knip 豁免 ${(config.ignoreDependencies ?? []).length} 项均在册）`,
);
