#!/usr/bin/env node
/* global console */
// ============================================================================
// knip-production-ratchet — 生产可达性棘轮门（knip 的第二 profile）
// ============================================================================
//
// 为什么需要第二道 knip：
//   现有 knip.json 的 entry 含 tests/**（还有 scripts/**），所以"只有测试引用得到、
//   生产里没有任何消费方"的代码在那道门里是绿的——**"有测试"恰恰是这类孤儿的伪装色**。
//   2026-07-25 的孤儿能力审计实测：三个已确认的孤儿（editMessage / BudgetSettings /
//   designPreviewInject）喂给现行 knip 门，一个都没进网。
//
// 本门保留历史 66 基线，同时用 strict profile 关掉 Knip 自动注入的测试/配置/plugin
// 入口。普通 profile 锁存量；strict profile 只拦相对 main 新增且从发行版入口走不到的
// 源码文件，不抬历史基线，也不维护逐文件豁免名单。
//
// 它防的是最贵的那种缺陷——"建好不接电"：代码写完、测试齐全、生产零消费者。
// 已知受害史是现已删除的 src/host/index.ts Electron main 路径：
// telemetry 上传器 / Agent Registry / LogBridge / dbRetention 先后在它上面搁浅。
//
// 口径与取舍：
//   - legacy profile 保留 66 的计数棘轮，继续锁住已经清下来的存量战果。
//   - strict profile 不设第二个数字基线，也不做 allowlist；只把相对 main 新增的 src 文件
//     与纯发行入口不可达集合取交集。既有 132 个历史债不会被本工单强行核销，新债会报红。
//   - 故意只给 scripts/ 使用的实现应放在 scripts/ 或对应工具 workspace，不能靠抬生产基线放行。
//   - legacy 清理后仍手动调小 BASELINE_MAX，只降不升。
//
// 基线沿革：2026-07-25 建门，实测 132；同日 #676 把 retention 接进 webServer 后降到 131；
// 同日删 41 个死 barrel（孤儿审计 D4）后降到 90；2026-07-26 删除旧 Host
// main/bootstrap 及其两个专用辅助文件后降到 71，随即收紧；2026-07-27 复量为 67
// （#735/#741 期间把 4 个文件接回生产链路或删除），收紧锁住战果；2026-08-01 删除死组件
// TaskPanel/TaskMonitor.tsx（chip 改写与 TaskMonitor 删除工单③，无任何挂载点）连带其
// 唯一剩余消费方 Progress.tsx 以及两者共用的 taskPanelUtils.ts / useToolProgress.ts
// 一并清空（三者互为彼此的唯一消费者，`rtk proxy grep` 核实全仓零其他引用）后降到 66，收紧锁住战果。
//
// 用法：node scripts/knip-production-ratchet.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const BASELINE_MAX = 66;
export const KNIP_VERSION = '6.24.0';
export const CONFIG = 'knip.production.json';
export const STRICT_CONFIG = 'knip.production-strict.json';

// 锚点：已知必然生产不可达的文件。它若从结果里消失而文件还在，说明本门的口径已经失效
// （配置写错 / entry 被误改 / knip 报告格式变了），必须报红而不是"零命中=通过"地假绿。
export const ANCHOR = 'src/host/app/lifecycle.ts';
// 第二锚点只有测试消费者，专门防 Vitest/Playwright 或未来插件把测试重新注入 strict 入口。
export const TEST_ONLY_ANCHOR = 'src/host/app/desktopQueuedInputDrain.ts';

function fail(message) {
  throw new Error(`[knip-production-ratchet] ✗ 自检失败：${message}`);
}

export function validateConfig(configPath) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail(`${configPath} 无法读取或不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(config.entry) || config.entry.length === 0) {
    fail(`${configPath} 没有非空 entry 数组，生产入口口径已失效。`);
  }
  if (!Array.isArray(config.project) || config.project.length === 0) {
    fail(`${configPath} 没有非空 project 数组，扫描范围已失效。`);
  }

  const missingEntries = config.entry.filter((entryPath) => !entryPath.includes('*') && !existsSync(entryPath));
  if (missingEntries.length > 0) {
    fail(`${configPath} 里以下 entry 在磁盘上不存在：\n${missingEntries.map((entryPath) => `    ${entryPath}`).join('\n')}`);
  }
  return config;
}

export function parseKnipResult(result, configPath) {
  if (result.error) {
    fail(`${configPath} 的 Knip 进程无法启动：${result.error.message}`);
  }
  if (result.signal) {
    fail(`${configPath} 的 Knip 进程被 ${result.signal} 终止。`);
  }
  if (result.status !== 0 && result.status !== 1) {
    fail(`${configPath} 的 Knip 异常退出（status=${result.status ?? 'null'}）。`);
  }
  if (/^(?:ERROR:|npm error)/m.test(result.stderr ?? '')) {
    fail(`${configPath} 的 Knip stderr 含工具/配置错误：\n${result.stderr.slice(0, 2000)}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    fail(`${configPath} 的 Knip 输出不可解析（工具未装好、配置损坏或进程被 kill）：\n${result.stderr?.slice(0, 2000) || '(无 stderr)'}`);
  }
  if (!Array.isArray(report.issues)) {
    fail(`${configPath} 的 Knip JSON 里没有 issues 数组，报告格式已变化。`);
  }

  const files = [...new Set(report.issues.map((issue) => issue.file).filter((file) => typeof file === 'string'))].sort();
  if (files.length === 0) {
    fail(`${configPath} 扫描出的生产不可达文件数为 0；entry/project、插件入口或 Knip 行为很可能已失效。`);
  }
  const requiredAnchors = configPath === STRICT_CONFIG ? [ANCHOR, TEST_ONLY_ANCHOR] : [ANCHOR];
  for (const anchor of requiredAnchors) {
    if (existsSync(anchor) && !files.includes(anchor)) {
      fail(`${configPath} 的锚点 ${anchor} 仍存在，却没被判为生产不可达。`);
    }
  }
  return files;
}

export function runKnip(configPath) {
  validateConfig(configPath);
  const result = spawnSync(
    'npx',
    ['--yes', `knip@${KNIP_VERSION}`, '--config', configPath, '--include', 'files', '--no-progress', '--reporter', 'json'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return parseKnipResult(result, configPath);
}

function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`git ${args.join(' ')} 无法启动：${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    fail(`git ${args.join(' ')} 失败：${result.stderr?.trim() || `status=${result.status}`}`);
  }
  return result;
}

function resolveCommit(ref, { required = false } = {}) {
  const result = runGit(['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
  if (result.status === 0) return result.stdout.trim();
  if (required) fail(`无法解析比较基点 ${ref}；strict 新增文件检测不能在未知基点上假绿。`);
  return null;
}

export function resolveComparisonBase(env = process.env) {
  if (env.KNIP_PRODUCTION_BASE_REF) {
    return resolveCommit(env.KNIP_PRODUCTION_BASE_REF, { required: true });
  }
  if (env.GITHUB_BASE_REF) {
    return resolveCommit(`origin/${env.GITHUB_BASE_REF}`, { required: true });
  }
  if (env.GITHUB_EVENT_NAME === 'push') {
    return resolveCommit('HEAD^', { required: true });
  }

  const head = resolveCommit('HEAD', { required: true });
  const originMain = resolveCommit('origin/main');
  if (!originMain || head === originMain) return null;

  const mergeBase = runGit(['merge-base', head, originMain]);
  const base = mergeBase.stdout.trim();
  if (!base) fail('git merge-base HEAD origin/main 返回空 SHA。');
  return base;
}

function splitNullDelimited(output) {
  return output.split('\0').filter(Boolean);
}

export function collectAddedSourceFiles(env = process.env) {
  const added = new Set();
  const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', 'src']);
  const records = splitNullDelimited(status.stdout);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const file = record.slice(3);
    if (code === '??' || code.includes('A')) added.add(file);
    if (code[0] === 'R' || code[0] === 'C') index += 1;
  }

  const base = resolveComparisonBase(env);
  if (base) {
    const diff = runGit(['diff', '--name-only', '--diff-filter=A', '-z', base, 'HEAD', '--', 'src']);
    for (const file of splitNullDelimited(diff.stdout)) added.add(file);
  }
  return [...added].sort();
}

export function findNewStrictlyUnreachable(strictFiles, addedFiles) {
  const added = new Set(addedFiles);
  return strictFiles.filter((file) => added.has(file)).sort();
}

export function main() {
  const files = runKnip(CONFIG);
  const count = files.length;
  console.log(`[knip-production-ratchet] 存量口径生产不可达文件 ${count} 个（基线上限 ${BASELINE_MAX}）`);

  if (count > BASELINE_MAX) {
    console.error(`[knip-production-ratchet] ✗ 超基线 ${count - BASELINE_MAX} 个。完整名单（前 30）：`);
    for (const file of files.slice(0, 30)) console.error(`    ${file}`);
    if (files.length > 30) console.error(`    …… 其余 ${files.length - 30} 个`);
    process.exitCode = 1;
    return;
  }
  if (count < BASELINE_MAX) {
    console.log(`[knip-production-ratchet] ✓ 低于基线 ${BASELINE_MAX - count} 个，可把 BASELINE_MAX 调小到 ${count}`);
  } else {
    console.log('[knip-production-ratchet] ✓ 等于存量基线');
  }

  const strictFiles = runKnip(STRICT_CONFIG);
  const addedFiles = collectAddedSourceFiles();
  const newUnreachable = findNewStrictlyUnreachable(strictFiles, addedFiles);
  console.log(`[knip-production-ratchet] strict 口径扫描 ${strictFiles.length} 个历史不可达文件；检查新增源码 ${addedFiles.length} 个`);

  if (newUnreachable.length > 0) {
    console.error('[knip-production-ratchet] ✗ 以下新增源码从发行版入口完全走不到：');
    for (const file of newUnreachable) console.error(`    ${file}`);
    console.error('  测试、脚本或配置能 import 到不等于生产可达；请接入真实发行入口或删除该文件。');
    process.exitCode = 1;
    return;
  }
  console.log('[knip-production-ratchet] ✓ 没有新增的严格生产不可达源码');
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
