#!/usr/bin/env npx tsx
// ============================================================================
// eval-split.ts — 生成 held-in/held-out/control/safety 切分文件（WP1b 样本工程）
// ============================================================================
// held-in 日常迭代 + baseline 对账；held-out 只在里程碑检查（过拟合探测）；
// control = held-in 里带确定性断言的 case（judge 校准金标源）；
// safety = 破坏性/红线 case，先于能力切分隔离。
// GAIA validation 为天然 held-out 外部锚点（--case-dir 独立入口，不进本地 split）。
//
// Usage:
//   npx tsx scripts/eval-split.ts --from-baseline .code-agent/eval-baseline-subset45.json \
//     --seed wp1b-2026-07 [--ratio 0.4] [--out <dir>]

import fs from 'fs';
import path from 'path';
import {
  EVAL_SPLITS_RELATIVE_PATH,
  assertValidEvalSplits,
  splitHeldInOut,
  saveEvalSplits,
} from '../src/host/testing/ci/sampleSplits';
import { filterTestCases, loadAllTestSuites } from '../src/host/testing/testCaseLoader';
import { countDeclaredAssertions } from '../src/host/testing/assertionEngine';
import { getTestDirs } from '../src/host/config/configPaths';
import { isRedlineCase } from '../src/host/testing/testCaseClassification';

const HELP = `eval-split — 生成 held-in/held-out/control/safety 切分（eval-splits.json）

Options:
  --from-baseline <json>  从 baseline 文件的 caseResults keys 取 id 全集
  --ids <a,b,c>           或显式给 id 列表
  --seed <s>              切分种子（必填——换卷子必须显式留痕）
  --ratio <0-1>           held-out 份额（默认 0.4）
  --out <dir>             输出目录（默认当前仓库根，落 .claude/eval-splits.json）
  --help                  显示本帮助`;

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let fromBaseline: string | undefined;
  let ids: string[] | undefined;
  let seed: string | undefined;
  let ratio: number | undefined;
  let out = process.cwd();
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--from-baseline' && i + 1 < args.length) fromBaseline = args[++i];
    else if (arg === '--ids' && i + 1 < args.length) ids = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--seed' && i + 1 < args.length) seed = args[++i];
    else if (arg === '--ratio' && i + 1 < args.length) ratio = parseFloat(args[++i]);
    else if (arg === '--out' && i + 1 < args.length) out = args[++i];
    else if (arg === '--help' || arg === '-h') help = true;
  }
  return { fromBaseline, ids, seed, ratio, out, help };
}

async function main() {
  const { fromBaseline, ids: explicitIds, seed, ratio, out, help } = parseArgs(process.argv);
  if (help) { console.log(HELP); return; }
  if (!seed) { console.error('缺 --seed（切分种子必须显式留痕）\n'); console.log(HELP); process.exit(1); }

  let ids = explicitIds;
  if (!ids && fromBaseline) {
    const baseline = JSON.parse(fs.readFileSync(fromBaseline, 'utf-8')) as { caseResults?: Record<string, unknown> };
    ids = Object.keys(baseline.caseResults ?? {});
  }
  if (!ids || ids.length === 0) { console.error('缺 id 全集：给 --from-baseline 或 --ids\n'); process.exit(1); }

  const suites = await loadAllTestSuites(getTestDirs(out).testCases.new);
  const cases = filterTestCases(suites, {});
  const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const unknown = ids.filter((id) => !caseById.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.length} 个 id 在 test-cases 里找不到，拒绝生成不可审计切分: ${unknown.join(', ')}`,
    );
  }
  const safety = ids.filter((id) => isRedlineCase(caseById.get(id)!)).sort();
  const capabilityIds = ids.filter((id) => !safety.includes(id));
  const { heldIn, heldOut } = splitHeldInOut(capabilityIds, { seed, heldOutRatio: ratio });

  // control 取自 held-in，避免把 held-out 泄进 judge 调优回路。
  const declared = new Map(cases.map((testCase) => [
    testCase.id,
    countDeclaredAssertions(testCase.expect) + (testCase.expectations?.length ?? 0),
  ]));
  const control = heldIn.filter((id) => (declared.get(id) ?? 0) > 0);

  const file = {
    version: 1 as const,
    seed,
    createdAt: new Date().toISOString(),
    heldIn,
    heldOut,
    control,
    safety,
    note: 'GAIA validation 为天然 held-out 外部锚点（--case-dir 独立入口，不进本地 split）；held-out 只在里程碑检查；safety 仅限 OS jail。',
  };
  assertValidEvalSplits(file, {
    allCaseIds: ids,
    safetyCaseIds: safety,
  });
  await saveEvalSplits(out, file);

  console.log(`✅ 切分完成（seed=${seed}）：held-in ${heldIn.length} / held-out ${heldOut.length} / control ${control.length} / safety ${safety.length}`);
  console.log(`   → ${path.join(out, EVAL_SPLITS_RELATIVE_PATH)}`);
}

main().catch((e) => { console.error('eval-split failed:', e); process.exit(1); });
