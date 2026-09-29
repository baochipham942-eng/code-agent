#!/usr/bin/env node
/* global console */
// ============================================================================
// gc-stale-tmp — 本机临时沙箱陈量回收（N-GATES-TMP-SELFCLEAN）
// ============================================================================
//
// 背景：一次 gates:local 被打断留下 ~3G 的 `vitest*` / `code-agent-*` 临时目录，09-05 晚磁盘
// 剩 7.6G 被手动清理。tmp-sandbox 只能保证「登记过的进程自己退场时自清」，SIGKILL / 断电 / 历史
// 存量还是要有人扫。本脚本就是那把扫帚，gates:local 拿到锁之后会以 --execute 调它一次。
//
// 三重条件全满足才删；条件 1+2 都过了却删不下去的（占用/排除/判不了）逐条 fail-loud 打印原因，
// 未超龄与名字不匹配的只计入末尾汇总——它们本来就不在删除范围，逐行刷屏反而把真警告淹掉：
//   1. os.tmpdir() 的**直接子目录**，名字匹配 /^(vitest|code-agent-|gates-fast-|tmp\.)/；
//   2. mtime 早于 1 天（刚建的不碰——可能是正在跑的那轮）；
//   3. `lsof -t +D` 显示无任何进程占用（含 cwd）。
//
// 红线（08-18 教训）：只删自己**逐个点名**的路径，禁止通配符 rm、不递归扫别的目录、不碰
// 排除名单。`code-agent-npm-cache` 在排除名单里——任务书明确「不清 npm cache」（它是跨轮复用的
// 缓存，不是一次 run 的沙箱）。默认 dry-run，`--execute` 才真删。
//
// 用法：
//   node scripts/gc-stale-tmp.mjs                 # dry-run（默认）
//   node scripts/gc-stale-tmp.mjs --execute       # 真删
//   node scripts/gc-stale-tmp.mjs --root <dir>    # 换扫描根（测试/定向排查用）

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const NAME_PATTERN = /^(vitest|code-agent-|gates-fast-|tmp\.)/;
const EXCLUDED_NAMES = new Set(['code-agent-npm-cache']);
const DEFAULT_MIN_AGE_HOURS = 24;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`用法：node ${path.relative(process.cwd(), path.join(scriptDir, 'gc-stale-tmp.mjs'))} [--execute] [--root <dir>] [--min-age-hours <n>]
  默认 dry-run；--execute 才删。只删名字匹配、超龄（默认 ${DEFAULT_MIN_AGE_HOURS}h）且 lsof 确认无占用的直接子目录。`);
}

function parseArgs(argv) {
  const parsed = { execute: false, root: os.tmpdir(), minAgeHours: DEFAULT_MIN_AGE_HOURS };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') parsed.execute = true;
    else if (arg === '--dry-run') parsed.execute = false;
    else if (arg === '--root' && argv[i + 1]) { parsed.root = path.resolve(argv[++i]); }
    else if (arg === '--min-age-hours' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`FAIL: --min-age-hours 必须是正数，收到 ${argv[i]}`);
      parsed.minAgeHours = value;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`FAIL: 未知参数 ${arg}`);
    }
  }
  return parsed;
}

/** lsof 判占用：输出非空 = 有进程（含只持有 cwd 的）还在这棵目录里。判不了就当「占着」跳过。 */
function holdingPids(dir) {
  const result = spawnSync('lsof', ['-t', '+D', dir], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) {
    return { error: `lsof 跑不起来：${result.error.message}` };
  }
  // lsof 惯例：0 = 找到打开的文件，1 = 没找到；>1 才是自身出错。stdout 有 pid 一律视为占用。
  if (result.status !== 0 && result.status !== 1) {
    return { error: `lsof 退出码 ${result.status}${result.stderr?.trim() ? `：${result.stderr.trim().split('\n')[0]}` : ''}` };
  }
  return { pids: result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) };
}

function main() {
  const options = parseArgs(process.argv);
  const mode = options.execute ? 'execute' : 'dry-run';
  let stats;
  try {
    stats = fs.readdirSync(options.root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`FAIL: 扫描根读不了 ${options.root}：${error instanceof Error ? error.message : String(error)}`);
  }
  const minAgeMs = options.minAgeHours * 3_600_000;
  const now = Date.now();
  let deleted = 0;
  let skippedFresh = 0;
  let unmatched = 0;
  let failed = 0;

  // readdirSync 已按名字排序；只看直接子项，绝不递归进别人的目录树。
  for (const entry of stats) {
    if (!NAME_PATTERN.test(entry.name)) {
      unmatched += 1;
      continue;
    }
    const full = path.join(options.root, entry.name);
    if (!entry.isDirectory()) {
      failed += 1;
      console.error(`✗ 跳过 ${full}：名字匹配但不是目录（${entry.isSymbolicLink() ? '符号链接' : entry.isFile() ? '普通文件' : '其他类型'}）`);
      continue;
    }
    if (EXCLUDED_NAMES.has(entry.name)) {
      console.error(`- 跳过 ${full}：npm cache 按约定不清（跨轮复用的缓存，不是一次 run 的沙箱）`);
      continue;
    }
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue; // 扫描与删除之间被别人清掉了，正好少一个要处理的
    }
    const ageMs = now - mtimeMs;
    if (ageMs < minAgeMs) {
      skippedFresh += 1;
      continue;
    }
    const held = holdingPids(full);
    if (held.error) {
      failed += 1;
      console.error(`✗ 跳过 ${full}：判不了占用，${held.error}`);
      continue;
    }
    if (held.pids?.length) {
      console.error(`- 跳过 ${full}：仍被进程占用（pids ${held.pids.join(',')}）`);
      continue;
    }
    if (!options.execute) {
      console.log(`[dry-run] 将删除 ${full}`);
      deleted += 1;
      continue;
    }
    try {
      // 逐个点名删除，绝不通配符；rmSync 限定在这一个已确认无占用的路径上。
      fs.rmSync(full, { recursive: true, force: true });
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.error(`✗ 删除失败 ${full}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`gc-stale-tmp（${mode}，root=${options.root}）：删除 ${deleted}，占用/排除跳过见上，` +
    `${skippedFresh} 个未超龄，${unmatched} 个名字不匹配，${failed} 个失败`);
  if (failed > 0) process.exitCode = 1;
}

main();
