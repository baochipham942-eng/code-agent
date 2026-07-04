#!/usr/bin/env npx tsx
// ============================================================================
// gaia-report.ts — 汇总 GAIA 全量真跑结果 → L1/L2/L3 分级准确率报告
// ============================================================================
// 从 test-results 目录收集属于 GAIA 的 report-*.json（分批 --ids 会产出多份），
// 同一 case 多次出现取最后一跑；输出分级准确率 + 与 Manus 1.5 公开数字对比
// （口径差异在报告里注明）。
//
// Usage:
//   npx tsx scripts/gaia-report.ts [--results-dir .code-agent/test-results] [--out <md>]

import fs from 'fs';
import path from 'path';
import { getTestDirs } from '../src/host/config';

interface CaseResult {
  testId: string;
  status: string;
  score: number;
  duration: number;
  failureReason?: string;
}

interface ReportJson {
  startTime?: number;
  environment?: { model?: string; provider?: string };
  results: CaseResult[];
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let resultsDir: string | undefined;
  let out: string | undefined;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--results-dir' && i + 1 < args.length) resultsDir = args[++i];
    else if (arg === '--out' && i + 1 < args.length) out = args[++i];
    else if (arg === '--help' || arg === '-h') help = true;
  }
  return { resultsDir, out, help };
}

function main() {
  const { resultsDir: dirArg, out, help } = parseArgs(process.argv);
  if (help) {
    console.log('gaia-report — 汇总 GAIA 真跑结果为 L1/L2/L3 分级报告\n  --results-dir <dir>  报告目录（默认 .code-agent/test-results）\n  --out <md>           另存 markdown');
    return;
  }
  const resultsDir = dirArg ?? getTestDirs(process.cwd()).results.new;

  if (!fs.existsSync(resultsDir)) {
    console.error(`结果目录不存在（run 还没产出报告？）：${resultsDir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(resultsDir).filter((f) => /^report-.*\.json$/.test(f)).sort();
  const latest = new Map<string, { result: CaseResult; runStart: number; model?: string }>();
  for (const f of files) {
    let parsed: ReportJson;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8')) as ReportJson;
    } catch { continue; }
    for (const r of parsed.results ?? []) {
      if (!r.testId.startsWith('gaia-')) continue;
      const runStart = parsed.startTime ?? 0;
      const prev = latest.get(r.testId);
      if (!prev || runStart >= prev.runStart) {
        latest.set(r.testId, { result: r, runStart, model: parsed.environment?.model });
      }
    }
  }

  if (latest.size === 0) {
    console.error(`结果目录里没有 GAIA case：${resultsDir}`);
    process.exit(1);
  }

  const model = [...latest.values()].find((v) => v.model)?.model ?? 'unknown';
  const levels = ['1', '2', '3'] as const;
  // Manus 1.5 公开 GAIA validation 数字（2025-11 官方博客口径）
  const manus: Record<(typeof levels)[number], number> = { '1': 86.5, '2': 70.1, '3': 57.7 };

  const lines: string[] = [];
  lines.push(`# GAIA validation 全量真跑分级报告`);
  lines.push('');
  lines.push(`- 模型：${model}（Agent Neo eval harness，quasi-exact match 判分）`);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push('| Level | 题数 | 通过 | infra 排除 | 准确率 | Manus 1.5 | 差距 |');
  lines.push('|-------|------|------|------------|--------|-----------|------|');

  let totalPassed = 0;
  let totalCap = 0;
  const failures: Array<{ id: string; reason: string }> = [];
  for (const level of levels) {
    const inLevel = [...latest.values()].filter((v) => v.result.testId.startsWith(`gaia-l${level}-`));
    const infra = inLevel.filter((v) => v.result.status === 'infra_excluded').length;
    const capability = inLevel.length - infra;
    const passed = inLevel.filter((v) => v.result.status === 'passed').length;
    const acc = capability > 0 ? (passed / capability) * 100 : 0;
    totalPassed += passed;
    totalCap += capability;
    lines.push(
      `| L${level} | ${inLevel.length} | ${passed} | ${infra} | **${acc.toFixed(1)}%** | ${manus[level].toFixed(1)}% | ${(acc - manus[level]).toFixed(1)}pp |`,
    );
    for (const v of inLevel) {
      if (v.result.status !== 'passed' && v.result.status !== 'infra_excluded') {
        failures.push({ id: v.result.testId, reason: (v.result.failureReason ?? '').slice(0, 160) });
      }
    }
  }
  const overallAcc = totalCap > 0 ? (totalPassed / totalCap) * 100 : 0;
  const manusOverall = (86.5 * 53 + 70.1 * 86 + 57.7 * 26) / 165;
  lines.push(`| **合计** | ${latest.size} | ${totalPassed} | ${latest.size - totalCap} | **${overallAcc.toFixed(1)}%** | ${manusOverall.toFixed(1)}% | ${(overallAcc - manusOverall).toFixed(1)}pp |`);
  lines.push('');
  // 严格口径：外部榜单不会给"超时/网络"豁免——infra_excluded 全按答错算的保守数字
  const strictAcc = latest.size > 0 ? (totalPassed / latest.size) * 100 : 0;
  lines.push(`> **严格口径**（infra 排除全按答错计，与外部榜单可比的保守数）：合计 **${strictAcc.toFixed(1)}%**（${totalPassed}/${latest.size}）。`);
  lines.push('');
  lines.push('## 口径差异（对比 Manus 1.5 时必读）');
  lines.push('');
  lines.push('- 两边都是 GAIA validation 165 题、官方 quasi-exact match 语义；但 Manus 数字来自其官方博客自报，跑法/重试策略/工具面不可见，不是同 harness 复现。');
  lines.push('- 我们 infra_excluded（429/超时/网络）不进分母（上表单列）；Manus 口径未知。');
  lines.push('- 附件题（38/165）我们注入本地附件文件；音频/图片附件对纯文本模型天然不利（无多模态工具时按失败计，不粉饰）。');
  lines.push('- 单跑一次不做 best-of-N；Manus 未公布采样次数。');
  lines.push('');
  if (failures.length > 0) {
    lines.push(`## 失败清单（${failures.length} 题）`);
    lines.push('');
    for (const f of failures) lines.push(`- \`${f.id}\`：${f.reason || '(无 failureReason)'}`);
    lines.push('');
  }

  const md = lines.join('\n');
  console.log(md);
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md, 'utf-8');
    console.error(`\n已存: ${out}`);
  }
}

main();
