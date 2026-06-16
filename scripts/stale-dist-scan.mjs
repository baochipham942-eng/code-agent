#!/usr/bin/env node
// ============================================================================
// stale-dist-scan — 静态门：禁止把构建产物提交进 git
// ============================================================================
//
// 背景：本仓库 dist/ 走 .gitignore（实测 git 跟踪 dist 文件数 = 0），构建产物从不入库，
// CI 每次都源码现构建。因此「src mtime > dist mtime」式的陈旧检测在这里没有意义
// （dist 根本不在版本库里）。真正要防的反模式是：有人 `git add -f dist/...` 把陈旧/
// 体积巨大的构建产物意外提交进来，污染历史、引发"看着是新代码跑的却是旧 bundle"。
//
// 规则：扫描 git 已跟踪文件 + 暂存区，命中构建产物目录前缀即 fail。
// 退出码：发现被跟踪/暂存的构建产物 → exit 1；否则 exit 0。
// 用法：node scripts/stale-dist-scan.mjs

import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

// 构建产物目录前缀（POSIX 风格，相对仓库根）。新增产物目录时在此补充。
const BUILD_OUTPUT_PREFIXES = [
  'dist/',
  'dist-electron/',
  'dist-renderer/',
  'out/',
  'src-tauri/target/',
];

function gitLines(args) {
  try {
    const out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    console.error(`[stale-dist-scan] git 命令失败: git ${args.join(' ')}`);
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
}

function isBuildOutput(file) {
  return BUILD_OUTPUT_PREFIXES.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix));
}

// 已跟踪文件（已入库）
const tracked = gitLines(['ls-files']).filter(isBuildOutput);
// 暂存区文件（即将入库；含 -f 强制 add 的 ignored 文件）
const staged = gitLines(['diff', '--cached', '--name-only']).filter(isBuildOutput);

const offenders = Array.from(new Set([...tracked, ...staged])).sort();

console.log(`[stale-dist-scan] 检查构建产物入库情况，命中 ${offenders.length} 个`);

if (offenders.length > 0) {
  console.error('[stale-dist-scan] ✗ 以下构建产物被 git 跟踪/暂存，禁止提交（请 git rm --cached 并确认 .gitignore 覆盖）：');
  for (const f of offenders.slice(0, 50)) console.error(`  ${f}`);
  if (offenders.length > 50) console.error(`  ...以及另外 ${offenders.length - 50} 个`);
  process.exit(1);
}

console.log('[stale-dist-scan] ✓ 无构建产物入库');
process.exit(0);
