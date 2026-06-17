#!/usr/bin/env node
// 设计系统静态门（W2）——契约见 docs/designs/design-system.md
//
// 棘轮基线策略：现存违规（760 裸 button / 21 手搓 modal / 81 hex）不强制一次清零，
// 而是记录到 design-system-baseline.json，门只拦"超出基线的新增"。W3 每收口一批就 --update 降基线。
//
// 规则（对应契约 §0 三条铁律）：
//   1. hardcoded-hex   : 禁硬编码 #rrggbb；viz 豁免目录 + 行内 `ds-allow:viz` / `ds-allow` 注释豁免
//   2. bare-button     : 禁裸 <button>；primitives/ 目录 + 行内 `ds-allow:button` 豁免
//   3. handrolled-modal: 禁手搓 `fixed inset-0` 遮罩；primitives/Modal.tsx + 行内 `ds-allow` 豁免
//
// 用法：
//   node scripts/check-design-system.mjs            # 校验，超基线则 exit 1
//   node scripts/check-design-system.mjs --update   # 把当前计数写回基线（收口后降棘轮用）
//   node scripts/check-design-system.mjs --report    # 只报告分布，不判定

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
  'components/features/telemetry/CostCalendar',
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

function isAllowed(line, kinds) {
  for (const k of kinds) if (line.includes('ds-allow:' + k)) return true;
  // 裸 ds-allow（无 kind）放行任意规则，给特殊场景留口子但须显式
  return /ds-allow(?![:\w])/.test(line);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      yield* walk(full);
    } else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) {
      yield full;
    }
  }
}

export function scan() {
  const violations = { 'hardcoded-hex': [], 'bare-button': [], 'handrolled-modal': [] };
  for (const file of walk(SCAN_ROOT)) {
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
    });
  }
  return violations;
}

function counts(v) {
  return Object.fromEntries(Object.entries(v).map(([k, arr]) => [k, arr.length]));
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
  if (failed) {
    console.error('\n设计系统门失败：禁止引入超出基线的新违规。走 token/primitive，或加 `// ds-allow:<kind> 理由`。');
    process.exit(1);
  }
  console.log('\n✓ 设计系统门通过');
}
