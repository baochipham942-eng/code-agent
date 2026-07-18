#!/usr/bin/env node
// 设计系统静态门（W2）——契约见 docs/designs/design-system.md
//
// 棘轮基线策略：现存违规（760 裸 button / 21 手搓 modal / 81 hex）不强制一次清零，
// 而是记录到 design-system-baseline.json，门只拦"超出基线的新增"。W3 每收口一批就 --update 降基线。
//
// 规则（对应契约 §0 三条铁律 + 治理卫生批新增）：
//   1. hardcoded-hex        : 禁硬编码 #rrggbb；viz 豁免目录 + 行内 `ds-allow:viz` / `ds-allow` 注释豁免
//   2. bare-button          : 禁裸 <button>；primitives/ 目录 + 行内 `ds-allow:button` 豁免
//   3. handrolled-modal     : 禁手搓 `fixed inset-0` 遮罩；primitives/Modal.tsx + 行内 `ds-allow` 豁免
//   4. bare-px-radius       : 禁裸 px 圆角（rounded-[Npx] / border-radius: Npx），走 --radius-*；`ds-allow:radius` 豁免
//   5. bare-z-index         : 禁裸 z-index（z-[N] / zIndex: N / z-index: N）；双向 allowlist
//                             （design-system-zindex-allowlist.json）：用法不在表内即红，表项在代码中
//                             找不到也红（防 allowlist 积压）；`ds-allow:z` 豁免
//   6. important-unjustified: 禁无注册的 !important；`ds-allow:important <理由>` 登记后豁免
//   7. local-display-primitive: 禁在 primitives/ 之外新增本地 EmptyState/Badge 定义
//                             （A1 展示类 primitive 收敛，基线 0）；`ds-allow:primitive` 豁免
//
// 对比度断言（默认门已 enforce，--contrast 看明细）：四套主题 --brand-primary 按各自
// 真实用法场景核对 WCAG ≥4.5:1。2026-07-02 产品负责人拍板方案 A：dark/light brand 加深
// 至 teal-700 系（白字场景）；hc-dark 的 brand 是前景/描边用法，按"压 --bg-void"核对。
//
// 用法：
//   node scripts/check-design-system.mjs            # 校验，超基线则 exit 1
//   node scripts/check-design-system.mjs --update   # 把当前计数写回基线（收口后降棘轮用）
//   node scripts/check-design-system.mjs --report    # 只报告分布，不判定
//   node scripts/check-design-system.mjs --contrast  # 四套主题 brand 色对比度测量（只测量不判定）

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCAN_ROOT = join(ROOT, 'src/renderer');
const BASELINE_PATH = join(__dirname, 'design-system-baseline.json');

// 契约 §3：数据可视化豁免目录（这些路径下的 hex 不计违规）
const VIZ_EXEMPT = [
  'components/LivePreview/TweakPanel',
  'components/features/chat/MessageBubble/ChartBlock',
  'components/features/chat/MessageBubble/ChartRenderer',
  'components/features/workflow/DependencyEdge',
  'components/features/workflow/DAGViewer',
  'components/features/workflow/TaskNode',
  'components/features/lab/',
  'utils/vizPalette',
];

const HEX_RE = /#[0-9a-fA-F]{6}\b/;
// `\b` 在 button 后做词边界，覆盖 `<button>` / `<button ` / 行尾 `<button`（多行 JSX），不误伤 `<ButtonGroup`
const BARE_BUTTON_RE = /<button\b/;
const MODAL_OVERLAY_RE = /fixed inset-0/;
// 裸 px 圆角：Tailwind 任意值 / 行内 style / CSS 声明三种写法
const BARE_RADIUS_TSX_RE = /rounded-\[\d+px\]|borderRadius:\s*['"`]?\d+px/;
const BARE_RADIUS_CSS_RE = /border-radius:\s*\d+px/;
// 裸 z-index：Tailwind 任意值 / 行内 style / CSS 声明（Tailwind 标准刻度 z-10..z-50 不算裸值）
const BARE_Z_TSX_RE = /z-\[(\d+)\]|zIndex:\s*(\d+)/;
const BARE_Z_CSS_RE = /z-index:\s*(\d+)/;
const IMPORTANT_RE = /!important/;
// 本地展示 primitive 定义（const/function EmptyState|Badge）——共享件在 components/primitives/，
// 别再各自手搓。导出供契约测试对故意违例样本做红绿验证。
export const LOCAL_DISPLAY_PRIMITIVE_RE = /\b(?:const|function)\s+(?:EmptyState|Badge)\b/;

const ZINDEX_ALLOWLIST_PATH = join(__dirname, 'design-system-zindex-allowlist.json');

function isAllowed(line, kinds) {
  for (const k of kinds) if (line.includes('ds-allow:' + k)) return true;
  // 裸 ds-allow（无 kind）放行任意规则，给特殊场景留口子但须显式
  return /ds-allow(?![:\w])/.test(line);
}

function* walk(dir, extRe = /\.tsx?$/) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      yield* walk(full, extRe);
    } else if (extRe.test(full) && !/\.test\.tsx?$/.test(full)) {
      yield full;
    }
  }
}

function loadZAllowlist() {
  if (!existsSync(ZINDEX_ALLOWLIST_PATH)) return [];
  return JSON.parse(readFileSync(ZINDEX_ALLOWLIST_PATH, 'utf8'));
}

export function scan() {
  if (!existsSync(SCAN_ROOT)) {
    throw new Error(`[check-design-system] 自检失败：扫描根不存在 ${SCAN_ROOT}。若目录结构调整过，请同步更新本脚本。`);
  }
  let tsxFileCount = 0;
  let cssFileCount = 0;
  const violations = {
    'hardcoded-hex': [],
    'bare-button': [],
    'handrolled-modal': [],
    'bare-px-radius': [],
    'bare-z-index': [],
    'important-unjustified': [],
    'local-display-primitive': [],
    'stale-zindex-allowlist': [],
  };
  // 裸 z-index 用法先收集（file+value），扫完后与 allowlist 双向核对
  const zUsages = [];
  for (const file of walk(SCAN_ROOT)) {
    tsxFileCount++;
    const rel = relative(SCAN_ROOT, file);
    const inPrimitives = rel.startsWith('components/primitives/');
    const isModalPrimitive = rel === 'components/primitives/Modal.tsx';
    const isVizExempt = VIZ_EXEMPT.some((p) => rel.includes(p));
    const lines = readFileSync(file, 'utf8').split('\n');
    // 模板字符串（反引号）内的 hex = 注入 iframe/sandbox 的自包含 HTML/CSS，
    // app 的 CSS 变量不级联进去，必须用字面色——契约 §3 自动豁免。
    let inTemplate = false;
    // 区块豁免：`ds-allow:start <理由>` … `ds-allow:end` 之间整段跳过所有规则，
    // 用于 mermaid 主题、品牌图标等成块的合法字面色。
    let inExemptRegion = false;
    lines.forEach((line, i) => {
      const loc = `${rel}:${i + 1}`;
      if (line.includes('ds-allow:start')) inExemptRegion = true;
      if (inExemptRegion) {
        if (line.includes('ds-allow:end')) inExemptRegion = false;
        return;
      }
      const startedInTemplate = inTemplate;
      const tickIdx = line.indexOf('`');
      if ((line.match(/`/g) || []).length % 2 === 1) inTemplate = !inTemplate;

      const hexMatch = HEX_RE.exec(line);
      const hexInTemplate = startedInTemplate || (tickIdx !== -1 && hexMatch && hexMatch.index > tickIdx);
      if (hexMatch && !isVizExempt && !hexInTemplate && !isAllowed(line, ['viz', 'brand'])) {
        violations['hardcoded-hex'].push(loc);
      }
      if (BARE_BUTTON_RE.test(line) && !inPrimitives && !isAllowed(line, ['button'])) {
        violations['bare-button'].push(loc);
      }
      if (MODAL_OVERLAY_RE.test(line) && !isModalPrimitive && !isAllowed(line, ['modal'])) {
        violations['handrolled-modal'].push(loc);
      }
      // 新规则不吃模板字符串豁免：className={`... rounded-[3px] ...`} 里的 Tailwind 类真实生效
      if (BARE_RADIUS_TSX_RE.test(line) && !isAllowed(line, ['radius'])) {
        violations['bare-px-radius'].push(loc);
      }
      const zm = BARE_Z_TSX_RE.exec(line);
      if (zm && !isAllowed(line, ['z'])) {
        zUsages.push({ file: rel, value: Number(zm[1] ?? zm[2]), loc });
      }
      if (IMPORTANT_RE.test(line) && !isAllowed(line, ['important'])) {
        violations['important-unjustified'].push(loc);
      }
      if (LOCAL_DISPLAY_PRIMITIVE_RE.test(line) && !inPrimitives && !isAllowed(line, ['primitive'])) {
        violations['local-display-primitive'].push(loc);
      }
    });
  }

  // CSS 文件只跑三条新规则（hex/button/modal 语义不适用；主题定义文件的 hex 是合法 token 定义）
  for (const file of walk(SCAN_ROOT, /\.css$/)) {
    cssFileCount++;
    const rel = relative(SCAN_ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const loc = `${rel}:${i + 1}`;
      if (BARE_RADIUS_CSS_RE.test(line) && !isAllowed(line, ['radius'])) {
        violations['bare-px-radius'].push(loc);
      }
      const zm = BARE_Z_CSS_RE.exec(line);
      if (zm && !isAllowed(line, ['z'])) {
        zUsages.push({ file: rel, value: Number(zm[1]), loc });
      }
      if (IMPORTANT_RE.test(line) && !isAllowed(line, ['important'])) {
        violations['important-unjustified'].push(loc);
      }
    });
  }

  // 自检：扫到 0 个文件 = 门在空转（目录拆分/改名后静默恒绿），必须 fail loud
  if (tsxFileCount === 0 || cssFileCount === 0) {
    throw new Error(`[check-design-system] 自检失败：tsx/ts 文件 ${tsxFileCount} 个、css 文件 ${cssFileCount} 个，存在匹配数为 0 的扫描目标。若目录结构调整过，请同步更新本脚本。`);
  }

  // 双向 allowlist 核对：用法不在表内 → bare-z-index；表项在代码中找不到 → stale-zindex-allowlist
  const allowlist = loadZAllowlist();
  const key = (f, v) => `${f}#${v}`;
  const allowSet = new Set(allowlist.map((e) => key(e.file, e.value)));
  const usedKeys = new Set();
  for (const u of zUsages) {
    const k = key(u.file, u.value);
    if (allowSet.has(k)) usedKeys.add(k);
    else violations['bare-z-index'].push(u.loc);
  }
  for (const e of allowlist) {
    if (!usedKeys.has(key(e.file, e.value))) {
      violations['stale-zindex-allowlist'].push(`${e.file}#${e.value}（allowlist 项在代码中已不存在，请从表里删除）`);
    }
  }
  return violations;
}

function counts(v) {
  return Object.fromEntries(Object.entries(v).map(([k, arr]) => [k, arr.length]));
}

// ---- 对比度测量（--contrast，只测量不判定；锁断言需产品负责人拍板色板后再做）----

function relLum(hex) {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrastRatio(hexA, hexB) {
  const [l1, l2] = [relLum(hexA), relLum(hexB)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

const CONTRAST_MIN = 4.5;
// 每套主题 brand 色的真实用法场景（2026-07-02 方案 A 拍板口径）：
// - dark / light / hc-light：brand 作按钮底色（白字）与 checked 控件底色（白勾/白 thumb）→ 对白色前景核对
// - hc-dark：brand（cyan）是前景/描边用法（focus outline 压黑底），实际 UI 无"白字压 cyan"→ 对 --bg-void 核对
const CONTRAST_SCENARIOS = {
  'dark': { against: '#FFFFFF', label: '白色前景（按钮白字/checked 白勾）' },
  'light': { against: '#FFFFFF', label: '白色前景（按钮白字/checked 白勾）' },
  'high-contrast-light': { against: '#FFFFFF', label: '白色前景（按钮白字/checked 白勾）' },
  'high-contrast-dark': { against: 'bg-void', label: '前景用法压 --bg-void（focus outline/描边）' },
};

export function measureBrandContrast() {
  const themesDir = join(SCAN_ROOT, 'styles/themes');
  if (!existsSync(themesDir)) throw new Error(`[check-design-system] 主题目录不存在：${themesDir}`);
  const results = [];
  for (const f of readdirSync(themesDir).filter((n) => n.endsWith('.css')).sort()) {
    const theme = f.replace('.css', '');
    const css = readFileSync(join(themesDir, f), 'utf8');
    const m = css.match(/--brand-primary:\s*(#[0-9a-fA-F]{6})/);
    if (!m) throw new Error(`[check-design-system] ${f} 里找不到 --brand-primary 的 hex 定义，测量失败`);
    const scenario = CONTRAST_SCENARIOS[theme];
    if (!scenario) throw new Error(`[check-design-system] 主题 ${theme} 没有登记对比度场景，请在 CONTRAST_SCENARIOS 补一行`);
    let against = scenario.against;
    if (against === 'bg-void') {
      const bg = css.match(/--bg-void:\s*(#[0-9a-fA-F]{6})/);
      if (!bg) throw new Error(`[check-design-system] ${f} 里找不到 --bg-void 的 hex 定义，测量失败`);
      against = bg[1];
    }
    results.push({ theme, brand: m[1], against, label: scenario.label, ratio: contrastRatio(m[1], against) });
  }
  if (results.length === 0) throw new Error('[check-design-system] 未找到任何主题文件，测量失败');
  return results;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

// CLI（被 import 时不执行）
if (process.argv[1] && process.argv[1].endsWith('check-design-system.mjs')) {
  const mode = process.argv[2];
  const v = scan();
  const c = counts(v);

  if (mode === '--report') {
    console.log('设计系统违规分布：', JSON.stringify(c, null, 2));
    process.exit(0);
  }
  if (mode === '--contrast') {
    console.log(`四套主题 --brand-primary 按各自用法场景的 WCAG 对比度（阈值 ${CONTRAST_MIN}:1）：`);
    for (const r of measureBrandContrast()) {
      console.log(`  ${r.ratio >= CONTRAST_MIN ? '✓' : '✗'} ${r.theme.padEnd(20)} ${r.brand} vs ${r.against} = ${r.ratio.toFixed(2)}:1  （${r.label}）`);
    }
    process.exit(0);
  }
  if (mode === '--update') {
    writeFileSync(BASELINE_PATH, JSON.stringify(c, null, 2) + '\n');
    console.log('✓ 基线已更新：', JSON.stringify(c));
    process.exit(0);
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error('✗ 缺少基线，先跑 `node scripts/check-design-system.mjs --update` 生成');
    process.exit(1);
  }

  let failed = false;
  for (const [rule, count] of Object.entries(c)) {
    const base = baseline[rule] ?? 0;
    if (count > base) {
      failed = true;
      console.error(`✗ [${rule}] 新增违规：${count} > 基线 ${base}（+${count - base}）`);
      v[rule].slice(0, 20).forEach((loc) => console.error(`    ${loc}`));
    } else if (count < base) {
      console.log(`↓ [${rule}] 收口了：${count} < 基线 ${base}，跑 --update 降棘轮`);
    } else {
      console.log(`= [${rule}] 守住基线：${count}`);
    }
  }
  // 对比度硬断言（非棘轮：方案 A 落地后全绿，任何回退直接红）
  for (const r of measureBrandContrast()) {
    if (r.ratio < CONTRAST_MIN) {
      failed = true;
      console.error(`✗ [brand-contrast] ${r.theme} ${r.brand} vs ${r.against} = ${r.ratio.toFixed(2)}:1 < ${CONTRAST_MIN}:1（${r.label}）`);
    } else {
      console.log(`= [brand-contrast] ${r.theme} ${r.ratio.toFixed(2)}:1 达标`);
    }
  }

  if (failed) {
    console.error('\n设计系统门失败：禁止引入超出基线的新违规。走 token/primitive，或加 `// ds-allow:<kind> 理由`。');
    process.exit(1);
  }
  console.log('\n✓ 设计系统门通过');
}
