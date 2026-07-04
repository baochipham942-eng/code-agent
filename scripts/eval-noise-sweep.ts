#!/usr/bin/env npx tsx
// ============================================================================
// eval-noise-sweep.ts — 噪声带 sweep：同子集同配置重复 K 跑，实测 run-to-run σ
// ============================================================================
// 产出 .code-agent/eval-noise-band.json（maxScoreDrop = clamp(2σ, floor, cap)），
// baselineManager.compare 优先用它替换固定 0.15 拍脑袋值。
// ⚠ 付费跑量：K × 子集成本，跑前确认预算。
//
// Usage:
//   AUTO_TEST_API_KEY=... npx tsx scripts/eval-noise-sweep.ts \
//     --runs 5 --split held-in --model LongCat-2.0 --provider longcat --concurrency 1

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { computeNoiseBand, saveNoiseBand, NOISE_BAND_LIMITS } from '../src/host/testing/ci/noiseBand';
import { loadEvalSplits, applySplitFilter, type SplitBucket } from '../src/host/testing/ci/sampleSplits';
import { getTestDirs } from '../src/host/config';

const HELP = `eval-noise-sweep — 重复 K 跑实测评测噪声带（付费！跑前确认预算）

Options:
  --runs <k>          重复次数（默认 5，至少 ${NOISE_BAND_LIMITS.minRuns}）
  --split <bucket>    用切分桶做子集（默认 held-in）
  --ids <a,b>         或显式 id 列表（优先于 --split）
  --model <m>         模型（传给 eval-ci --model）
  --provider <p>      提供商
  --concurrency <n>   并发（默认 1，降低限流噪声混入）
  --help              显示本帮助`;

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let runs = 5;
  let split: SplitBucket = 'held-in';
  let ids: string[] | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let concurrency = 1;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--runs' && i + 1 < args.length) runs = parseInt(args[++i], 10);
    else if (arg === '--split' && i + 1 < args.length) split = args[++i] as SplitBucket;
    else if (arg === '--ids' && i + 1 < args.length) ids = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--model' && i + 1 < args.length) model = args[++i];
    else if (arg === '--provider' && i + 1 < args.length) provider = args[++i];
    else if (arg === '--concurrency' && i + 1 < args.length) concurrency = parseInt(args[++i], 10);
    else if (arg === '--help' || arg === '-h') help = true;
  }
  return { runs, split, ids, model, provider, concurrency, help };
}

interface ReportJson {
  averageScore: number;
  results: Array<{ testId: string; status: string }>;
}

function listReports(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir).filter((f) => /^report-.*\.json$/.test(f)));
  } catch {
    return new Set();
  }
}

async function main() {
  const { runs, split, ids: explicitIds, model, provider, concurrency, help } = parseArgs(process.argv);
  if (help) { console.log(HELP); return; }
  if (runs < NOISE_BAND_LIMITS.minRuns) {
    console.error(`--runs 至少 ${NOISE_BAND_LIMITS.minRuns}（σ 才勉强可信）`);
    process.exit(1);
  }

  const cwd = process.cwd();
  let ids = explicitIds;
  if (!ids) {
    const splits = await loadEvalSplits(cwd);
    if (!splits) { console.error('缺切分文件，先跑 scripts/eval-split.ts（或用 --ids）'); process.exit(1); }
    ids = applySplitFilter(undefined, splits, split);
  }
  console.log(`噪声带 sweep：${ids.length} cases × ${runs} runs（${model ?? 'default model'}）\n`);

  const resultsDir = getTestDirs(cwd).results.new;
  const sweepIds = new Set(ids);
  const avgScores: number[] = [];
  const caseStatusRuns: Record<string, string[]> = {};

  for (let k = 1; k <= runs; k++) {
    const before = listReports(resultsDir);
    console.log(`— run ${k}/${runs} 开始 ${new Date().toISOString()}`);
    const cliArgs = ['tsx', 'scripts/eval-ci.ts', '--real', '--force', '--scope', 'full',
      '--ids', ids.join(','), '--concurrency', String(concurrency)];
    if (model) cliArgs.push('--model', model);
    if (provider) cliArgs.push('--provider', provider);
    // timeout 强杀：eval-ci 偶发跑完不退出（悬挂 handle 吊住进程，2026-07-04 实测
    // 挂起 100 分钟），报告在挂起前已落盘，超时杀掉不丢数据
    const res = spawnSync('npx', cliArgs, {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      timeout: 30 * 60_000,
      killSignal: 'SIGKILL',
    });
    if (res.status !== 0) console.warn(`  ⚠ run ${k} eval-ci exit ${res.status ?? `signal:${res.signal}`}（若有报告仍尝试收集）`);

    // 找本轮新增且属于本 sweep 的报告（同目录可能有并行 GAIA run 的报告，按 id 集合区分）
    const after = listReports(resultsDir);
    const fresh = [...after].filter((f) => !before.has(f));
    let picked: ReportJson | null = null;
    for (const f of fresh) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8')) as ReportJson;
        const reportIds = (parsed.results ?? []).map((r) => r.testId);
        if (reportIds.length > 0 && reportIds.every((id) => sweepIds.has(id))) { picked = parsed; break; }
      } catch { /* 非本 sweep 的报告或坏文件，跳过 */ }
    }
    if (!picked) { console.error(`  ❌ run ${k} 找不到本轮报告，跳过（不计入 σ）`); continue; }

    avgScores.push(picked.averageScore);
    for (const r of picked.results) {
      (caseStatusRuns[r.testId] ??= []).push(r.status);
    }
    console.log(`  ✓ run ${k} avgScore=${picked.averageScore.toFixed(4)}`);
  }

  if (avgScores.length < NOISE_BAND_LIMITS.minRuns) {
    console.error(`有效 runs 只有 ${avgScores.length}（< ${NOISE_BAND_LIMITS.minRuns}），不落噪声带文件`);
    process.exit(1);
  }

  const band = computeNoiseBand(avgScores, caseStatusRuns);
  await saveNoiseBand(cwd, {
    version: 1,
    runs: avgScores.length,
    avgScores,
    stdDev: band.stdDev,
    maxScoreDrop: band.maxScoreDrop,
    computedAt: new Date().toISOString(),
    ...(model ? { model } : {}),
    ...(band.caseFlipRates && Object.keys(band.caseFlipRates).length > 0 ? { caseFlipRates: band.caseFlipRates } : {}),
  });

  console.log(`\n✅ 噪声带落盘：σ=${band.stdDev.toFixed(4)}，maxScoreDrop=${band.maxScoreDrop.toFixed(4)}（原固定 0.15）`);
  if (band.caseFlipRates && Object.keys(band.caseFlipRates).length > 0) {
    console.log(`   flaky cases: ${Object.entries(band.caseFlipRates).map(([id, r]) => `${id}(${(r * 100).toFixed(0)}%)`).join(', ')}`);
  }
}

main().catch((e) => { console.error('noise-sweep failed:', e); process.exit(1); });
