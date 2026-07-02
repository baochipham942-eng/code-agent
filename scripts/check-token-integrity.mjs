#!/usr/bin/env node
// token 引用完整性契约（治理卫生批③）——防"引用了没人定义的 CSS 变量"暗坑
//
// 收集 tailwind.config.js + src/renderer/**/*.{ts,tssx,css} 里的全部 var(--*) 引用，
// 对照定义集逐套核对：
//   - 全局定义 = global.css/组件 css 的 --x: 声明 + tsx/ts 行内 '--x': 自定义属性
//   - 主题定义 = styles/themes/<t>.css 各自的 --x: 声明
// 一个引用合法 = 出现在全局定义，或在【每一套】主题里都有定义；只覆盖部分主题即红。
// 带 fallback 的 var(--x, y) 自愈，不计；var(--${dyn}) 动态名不可静态核对，跳过。
// 行内 `token-scan-allow` 注释豁免。
//
// 退出码：存在未定义引用 → exit 1。自检：引用数或定义数为 0 → 直接 fail（门空转）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(root, 'src/renderer');
const THEMES_DIR = path.join(RENDERER, 'styles/themes');
const ALLOW = 'token-scan-allow';

// 已知洞登记表（双向核对：洞补上了必须从表里删，防积压）。
// zinc 刻度只在 dark/light 主题定义；hc 主题运行时靠 useTheme 给 root 挂 dark/light class
// 借级联取到值（hc-dark 实际挂 light class），不算运行时未定义，但 hc 专属 zinc 刻度
// 缺失是真实主题覆盖洞，补齐需要设计决策（hc 下该用什么灰阶），登记待产品负责人排期。
const KNOWN_HOLES = new Set(
  ['50', '100', '200', '300', '400', '500', '600', '700', '800', '850', '900', '950']
    .map((n) => `--zinc-${n}`),
);

function* walk(dir, extRe) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') yield* walk(full, extRe);
    } else if (extRe.test(e.name)) yield full;
  }
}

const DEF_RE = /(^|[^\w-])(--[a-zA-Z][\w-]*)\s*:/g; // css 声明或 tsx '--x': 值
const REF_RE = /var\(\s*(--[a-zA-Z][\w-]*)\s*([,)])/g; // 捕获是否带 fallback

function collect(re, text, out, keepFn) {
  let m;
  while ((m = re.exec(text)) !== null) if (!keepFn || keepFn(m)) out.add(m[2] ?? m[1]);
}

// 定义集
const globalDefs = new Set();
const themeDefs = new Map(); // theme -> Set
for (const f of walk(RENDERER, /\.(css|tsx?)$/)) {
  const text = fs.readFileSync(f, 'utf8');
  const isTheme = f.startsWith(THEMES_DIR + path.sep);
  const target = isTheme ? (themeDefs.get(path.basename(f, '.css')) ?? new Set()) : globalDefs;
  if (isTheme) themeDefs.set(path.basename(f, '.css'), target);
  collect(new RegExp(DEF_RE.source, 'g'), text, target);
}

// 引用集：file:line -> token（跳过带 fallback / 豁免行）
const refs = [];
const refFiles = [path.join(root, 'tailwind.config.js'), ...walk(RENDERER, /\.(css|tsx?)$/)];
for (const f of refFiles) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes(ALLOW)) return;
    let m;
    const re = new RegExp(REF_RE.source, 'g');
    while ((m = re.exec(line)) !== null) {
      if (m[2] === ',') continue; // 带 fallback，自愈
      refs.push({ token: m[1], loc: `${path.relative(root, f)}:${i + 1}` });
    }
  });
}

// 自检：引用/定义/主题任一为 0 = 门空转，fail loud
if (refs.length === 0 || globalDefs.size === 0 || themeDefs.size === 0) {
  console.error(`[token-integrity] ✗ 自检失败：引用 ${refs.length} / 全局定义 ${globalDefs.size} / 主题 ${themeDefs.size}，存在为 0 的采集目标。若目录结构调整过，请同步更新本脚本。`);
  process.exit(1);
}

const themes = [...themeDefs.keys()].sort();
const bad = [];
const holesStillOpen = new Set();
for (const { token, loc } of refs) {
  if (globalDefs.has(token)) continue;
  const missing = themes.filter((t) => !themeDefs.get(t).has(token));
  if (missing.length === 0) continue;
  if (KNOWN_HOLES.has(token)) {
    holesStillOpen.add(token);
    continue;
  }
  bad.push({ token, loc, missing });
}
// 双向核对：登记的洞已经补上（或 token 已无人引用）→ 必须从 KNOWN_HOLES 删掉
for (const token of KNOWN_HOLES) {
  if (!holesStillOpen.has(token)) {
    bad.push({ token, loc: 'KNOWN_HOLES（登记项已失效，请从表里删除）', missing: [] });
  }
}

console.log(`[token-integrity] 引用 ${refs.length} 处（去重 ${new Set(refs.map((r) => r.token)).size} 个 token）、全局定义 ${globalDefs.size}、主题 ${themes.length} 套（${themes.join(', ')}）`);

if (bad.length > 0) {
  console.error(`[token-integrity] ✗ ${bad.length} 处引用未被完整定义（既不在全局，也没铺满全部主题）：`);
  for (const b of bad.slice(0, 50)) console.error(`  ${b.loc}  ${b.token}  缺于主题: ${b.missing.join(', ')}`);
  if (bad.length > 50) console.error(`  ...以及另外 ${bad.length - 50} 处`);
  console.error(`  修复：在 global.css 或全部主题里补定义；确属特殊场景加 /* ${ALLOW} */ 行内豁免。`);
  process.exit(1);
}
console.log('[token-integrity] ✓ 全部 var(--*) 引用在每套主题下都有定义');
