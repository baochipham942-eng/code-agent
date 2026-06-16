#!/usr/bin/env node
// ============================================================================
// a11y-scan — 轻量静态可访问性门（不启浏览器，纯规则扫描）
// ============================================================================
//
// 首版克制，只查三类高确定性、低误报的问题（避免误报洪水）：
//   R1  <img> 缺 alt 属性
//   R2  自闭合 <button .../> 无 aria-label（无子节点 = 无可访问名）
//   R3  <div>/<span> 挂了 onClick 但同标签内无 role= 且无 tabIndex（键盘不可达）
//
// 落地策略与 console-scan 一致：基线棘轮。现状命中先记入 BASELINE_MAX，
// 新增超基线才 exit 1；清理后调小基线，最终归零转 hard-fail。
// 行内 `// a11y-scan-allow` 豁免。
//
// 退出码：命中数 > BASELINE_MAX → exit 1；否则 exit 0。
// 用法：node scripts/a11y-scan.mjs [扫描根，默认 src/renderer]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

// 基线上限：当前 src/renderer 的历史命中数（脚本口径实测 48：5×R2 + 43×R3）。
// 棘轮只降不升；清理后调小，归零转 hard-fail。
const BASELINE_MAX = 48;

const ALLOW_COMMENT = 'a11y-scan-allow';

const roots = process.argv.slice(2).map((item) => path.resolve(item));
const scanRoots = (roots.length > 0 ? roots : [path.join(repoRoot, 'src/renderer')]).filter((i) => fs.existsSync(i));

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
    posix.includes('/tests/') ||
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
    } else if (entry.isFile() && path.extname(entry.name) === '.tsx') {
      if (!isExcluded(full)) acc.push(full);
    }
  }
}

const files = [];
for (const root of scanRoots) {
  const stat = fs.statSync(root);
  if (stat.isDirectory()) walk(root, files);
  else if (stat.isFile() && path.extname(root) === '.tsx' && !isExcluded(root)) files.push(root);
}

// 把字符索引换算成 1-based 行号
function lineAt(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}
// 该行是否带豁免注释
function lineHasAllow(content, index) {
  const start = content.lastIndexOf('\n', index) + 1;
  let end = content.indexOf('\n', index);
  if (end === -1) end = content.length;
  return content.slice(start, end).includes(ALLOW_COMMENT);
}

const violations = [];
function addViolation(file, content, index, rule) {
  if (lineHasAllow(content, index)) return;
  violations.push(`${toDisplayPath(file)}:${lineAt(content, index)}  ${rule}`);
}

// JSX 开标签 tokenizer：感知 {} 嵌套与字符串，正确定位 tag-end `>`。
// 这样 onClick={() => x} 里 `=>` 的 `>`（在大括号内）不会被误判为标签结束，
// 避免把可访问的元素误报为违规。返回 [{ name, text, index }]。
function* openingTags(content) {
  const tagStart = /<([A-Za-z][A-Za-z0-9]*)\b/g;
  let m;
  while ((m = tagStart.exec(content)) !== null) {
    const name = m[1];
    let i = m.index + m[0].length;
    let brace = 0;
    let str = null; // 当前字符串引号字符
    let ended = false;
    for (; i < content.length; i++) {
      const c = content[i];
      if (str) {
        if (c === str && content[i - 1] !== '\\') str = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { str = c; continue; }
      if (c === '{') { brace++; continue; }
      if (c === '}') { if (brace > 0) brace--; continue; }
      if (c === '>' && brace === 0) { i++; ended = true; break; }
    }
    if (!ended) continue;
    yield { name, text: content.slice(m.index, i), index: m.index };
  }
}

for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8');

  for (const tag of openingTags(content)) {
    const lower = tag.name.toLowerCase();

    // R1: <img> 缺 alt
    if (lower === 'img' && !/\balt\s*=/.test(tag.text)) {
      addViolation(file, content, tag.index, 'R1 <img> 缺 alt');
    }

    // R2: 自闭合 <button/> 无 aria-label（无子节点 = 无可访问名）
    if (lower === 'button' && /\/>\s*$/.test(tag.text)) {
      if (!/\baria-label\s*=/.test(tag.text) && !/\baria-labelledby\s*=/.test(tag.text)) {
        addViolation(file, content, tag.index, 'R2 图标 <button/> 无 aria-label');
      }
    }

    // R3: <div>/<span> 有 onClick 但无 role 且无 tabIndex（键盘不可达）
    if ((lower === 'div' || lower === 'span') && /\bonClick\s*=/.test(tag.text)) {
      if (!/\brole\s*=/.test(tag.text) && !/\btabIndex\s*=/.test(tag.text)) {
        addViolation(file, content, tag.index, 'R3 <div/span> onClick 无 role+tabIndex');
      }
    }
  }
}

const count = violations.length;
console.log(`[a11y-scan] 扫描 ${files.length} 个 .tsx 文件，命中 ${count} 处（基线上限 ${BASELINE_MAX}）`);

if (count > BASELINE_MAX) {
  console.error(`[a11y-scan] ✗ 命中数 ${count} 超过基线 ${BASELINE_MAX}：`);
  for (const v of violations.slice(0, 50)) console.error(`  ${v}`);
  if (violations.length > 50) console.error(`  ...以及另外 ${violations.length - 50} 处`);
  console.error(`  修复后或确属误报时，加 // ${ALLOW_COMMENT} 行内豁免；或调小脚本 BASELINE_MAX`);
  process.exit(1);
}

if (count < BASELINE_MAX) {
  console.log(`[a11y-scan] ✓ 低于基线 ${BASELINE_MAX - count} 处 —— 可把 BASELINE_MAX 调小到 ${count} 收紧棘轮`);
} else {
  console.log('[a11y-scan] ✓ 等于基线，通过（未新增）');
}
process.exit(0);
