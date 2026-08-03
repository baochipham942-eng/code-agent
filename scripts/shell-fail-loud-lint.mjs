#!/usr/bin/env node
// ============================================================================
// shell-fail-loud-lint — 全角/非 ASCII 字符紧贴裸 $VAR 的静态门
// ============================================================================
//
// 背景（2026-08-01 脚本报错路径先失明工单 §2-d）：
// macOS 自带 bash 3.2.57 在 $VAR（无花括号）后紧跟一个非 ASCII 字节时会把该
// 字节并入变量名解析，导致 set -u 下报 "unbound variable"，把真实报错信息
// （如版本号、arch 名）完全吞掉。fetch-rtk.sh / fetch-uv.sh 曾三次踩这个坑。
//
// 工单原文把检测范围定为"全角标点"，但实测（见 REPORT）bash 3.2 的这个坏
// 行为不挑标点——$VAR 后紧跟一个中文字（非标点）同样触发 unbound variable。
// 枚举标点字符集必然有维护缺口，这里改用更准确、也更简单的判据：
// 裸 $VAR 后紧跟的下一个字符若是非 ASCII（code point > 0x7F），一律报红。
// 实测该口径下现有代码库命中数与"仅标点"口径一致（0 处），未引入新噪音。
//
// 用法：node scripts/shell-fail-loud-lint.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BASELINE_MAX = 0;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const scanRoot = path.join(repoRoot, 'scripts');

const BARE_VAR_RE = /\$[A-Za-z_][A-Za-z0-9_]*/g;

function findShellFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
    // Node 22+ readdirSync({recursive:true}) 的 entry.path/parentPath 视版本而定，
    // 两者都试一遍，兜底用相对拼接，避免静默漏文件。
    const parent = entry.parentPath ?? entry.path ?? dir;
    files.push(path.join(parent, entry.name));
  }
  return files;
}

let shellFiles;
try {
  shellFiles = findShellFiles(scanRoot);
} catch (err) {
  console.error(`[shell-fail-loud-lint] ✗ 自检失败：无法枚举 ${scanRoot} 下的 .sh 文件：${err.message}`);
  process.exit(1);
}

// 锚点自检：扫到 0 个文件说明 glob/路径本身坏了，不能当成"全部合规"静默通过。
if (shellFiles.length === 0) {
  console.error(`[shell-fail-loud-lint] ✗ 自检失败：${scanRoot} 下扫到 0 个 .sh 文件，门本身失效，请检查路径`);
  process.exit(1);
}

const violations = [];
for (const file of shellFiles) {
  const relFile = path.relative(repoRoot, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    BARE_VAR_RE.lastIndex = 0;
    let match;
    while ((match = BARE_VAR_RE.exec(line))) {
      const nextChar = line[BARE_VAR_RE.lastIndex];
      if (nextChar && nextChar.codePointAt(0) > 0x7f) {
        violations.push({ file: relFile, line: idx + 1, snippet: line.trim() });
      }
    }
  });
}

console.log(`[shell-fail-loud-lint] 扫描 ${shellFiles.length} 个 .sh 文件，命中 ${violations.length} 处（基线上限 ${BASELINE_MAX}）`);

if (violations.length > BASELINE_MAX) {
  console.error(`[shell-fail-loud-lint] ✗ 超基线 ${violations.length - BASELINE_MAX} 处，裸 $VAR 紧跟非 ASCII 字符在 bash 3.2 下会被误解析成变量名的一部分：`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.snippet}`);
  }
  console.error('[shell-fail-loud-lint]   修法：给报错文案里的 $VAR 加花括号，写成 ${VAR}');
  process.exit(1);
}

console.log('[shell-fail-loud-lint] ✓ 通过');
