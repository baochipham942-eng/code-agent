#!/usr/bin/env node
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
// 本门换一套 entry：只放真正的发行版入口（cli / webServer / mcp / renderer / bridge），
// 报 knip 的 `files` 类问题 = "从生产入口出发完全走不到的文件"。
//
// 它防的是最贵的那种缺陷——"建好不接电"：代码写完、测试齐全、生产零消费者。
// 已知受害史见 src/host/index.ts 头注释（那条死掉的 Electron main 路径，
// telemetry 上传器 / Agent Registry / LogBridge / dbRetention 先后在它上面搁浅）。
//
// 口径与取舍：
//   - **只做计数棘轮，不做 allowlist**。目的是"防新增"不是"逼人删"：存量 132 个里有一批
//     是设计如此（被 scripts/ 消费的 eval harness、acceptance 工具等，审计报告附录 A 列了
//     18 个，明确标注勿删）。给它们逐个维护豁免名单的成本远高于收益。
//   - 新增生产不可达文件 → 计数上升 → 红。若确属"故意只给 scripts 用"，在下方基线注释里
//     写明理由再调高（与本仓其他棘轮同一社会契约）。
//   - 清理后手动调小，只降不升。
//
// 基线沿革：2026-07-25 建门，实测 132；同日 #676 把 retention 接进 webServer 后降到 131，随即收紧。
//
// 用法：node scripts/knip-production-ratchet.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const BASELINE_MAX = 131;
const KNIP_VERSION = '6.24.0';
const CONFIG = 'knip.production.json';

// 锚点：已知必然生产不可达的文件。它若从结果里消失而文件还在，说明本门的口径已经失效
// （配置写错 / entry 被误改 / knip 报告格式变了），必须报红而不是"零命中=通过"地假绿。
const ANCHOR = 'src/host/index.ts';

// 自检 0：entry 必须都真实存在。
// 少了一个生产入口，它下面整棵子树都会被算成"生产不可达"，门于是红在"你新增了 N 个死代码"
// 上——归因指向改动者的 diff，而真因是配置陈旧（实测：把一个 entry 改成不存在的路径，
// 计数从 132 涨到 136，报错却只字不提配置）。这类"红得指错人"和假绿一样坏。
const entryPaths = JSON.parse(readFileSync(CONFIG, 'utf8')).entry ?? [];
const missingEntries = entryPaths.filter((p) => !p.includes('*') && !existsSync(p));
if (missingEntries.length > 0) {
  console.error(`[knip-production-ratchet] ✗ 自检失败：${CONFIG} 里以下 entry 在磁盘上不存在——`);
  for (const p of missingEntries) console.error(`    ${p}`);
  console.error('  生产入口挪了位置就必须同步这里，否则整棵子树会被误判成生产不可达。');
  process.exit(1);
}

const result = spawnSync(
  'npx',
  ['--yes', `knip@${KNIP_VERSION}`, '--config', CONFIG, '--include', 'files', '--no-progress', '--reporter', 'json'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);

// knip 有 issue 时 exit 1 属正常；以 JSON 可解析为准判断门本身是否健康（自检 fail loud）
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error('[knip-production-ratchet] ✗ 自检失败：knip 输出不可解析（工具未装好/配置损坏/被 kill）');
  console.error(result.stderr?.slice(0, 2000) || '(无 stderr)');
  process.exit(1);
}
if (!Array.isArray(report.issues)) {
  console.error('[knip-production-ratchet] ✗ 自检失败：knip JSON 里没有 issues 数组，报告格式变了，请同步更新本脚本');
  process.exit(1);
}

const files = report.issues.map((issue) => issue.file).filter(Boolean);
const count = files.length;

// 自检 1：一个都没扫出来 = 口径失效的典型症状（存量是三位数，不可能突然清零）
if (count === 0) {
  console.error('[knip-production-ratchet] ✗ 自检失败：生产不可达文件数为 0。');
  console.error('  存量是三位数量级，归零几乎必然是 entry/project 配置失效或 knip 行为变更，');
  console.error('  而不是真的清干净了。请先确认门本身，不要把这当作通过。');
  process.exit(1);
}

// 自检 2：锚点还在磁盘上却不在结果里 → 口径失效
if (existsSync(ANCHOR) && !files.includes(ANCHOR)) {
  console.error(`[knip-production-ratchet] ✗ 自检失败：锚点 ${ANCHOR} 仍存在，却没被判为生产不可达。`);
  console.error('  它是已确认的死主进程路径（见该文件头注释）。锚点失效说明本门的可达性口径已经不可信。');
  console.error('  若该文件真被接回了发行版构建，请同步更新本脚本的 ANCHOR 与那三处 DEAD PATH 标记。');
  process.exit(1);
}

console.log(`[knip-production-ratchet] 生产不可达文件 ${count} 个（基线上限 ${BASELINE_MAX}）`);

if (count > BASELINE_MAX) {
  console.error(`[knip-production-ratchet] ✗ 超基线 ${count - BASELINE_MAX} 个 —— 有新代码从发行版入口完全走不到。`);
  console.error('  这类缺陷不会被任何单测发现（测试引用得到 ≠ 生产引用得到），也不会崩，只是永远不执行。');
  console.error('  处理方式二选一：把它接到真实消费路径上；或确属只给 scripts/ 用，则在脚本基线注释里写明理由再调高。');
  console.error('  完整名单（前 30）：');
  for (const file of files.slice(0, 30)) console.error(`    ${file}`);
  if (files.length > 30) console.error(`    …… 其余 ${files.length - 30} 个`);
  process.exit(1);
}
if (count < BASELINE_MAX) {
  console.log(`[knip-production-ratchet] ✓ 低于基线 ${BASELINE_MAX - count} 个 —— 可把 BASELINE_MAX 调小到 ${count} 收紧棘轮`);
} else {
  console.log('[knip-production-ratchet] ✓ 等于基线，通过（未新增）');
}
