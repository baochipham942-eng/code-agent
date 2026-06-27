/**
 * 对所有现有 runs/ 下的 agent.diff 单独跑 judge，更新 result.json 加 judge 字段。
 * 不重跑 agent loop；如果 result.json 没有 executable_validation，最终状态会降级为 degraded。
 *
 * 用法: npx tsx eval/swe-bench/reevaluate-with-judge.ts
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

import { judgePatchEquivalence } from './judges/patchEquivalence';
import {
  type ExecutableValidation,
  buildDiffShapeValidation,
  decideRunOutcome,
  diffShapePassed,
} from './validation';

function missingExecutableValidation(): ExecutableValidation {
  return {
    status: 'skipped',
    applied_test_patch: false,
    fail_to_pass: [],
    test_labels: [],
    command: null,
    exit_code: null,
    duration_ms: 0,
    reason: 'not_replayed_in_reevaluate_with_judge',
    stdout_tail: '',
    stderr_tail: '',
  };
}

async function main() {
  const RUNS_DIR = path.join(REPO_ROOT, 'eval/swe-bench/runs');
  const VERIFIED = path.join(REPO_ROOT, 'eval-datasets/swe-bench/verified.jsonl');

  const cases = fs.readFileSync(VERIFIED, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const lookup = new Map(cases.map((c) => [c.instance_id, c]));

  const runs = fs.readdirSync(RUNS_DIR).filter((d) => fs.statSync(path.join(RUNS_DIR, d)).isDirectory());
  console.log(`找到 ${runs.length} 个 runs，开始复评...\n`);

  const summary: Array<Record<string, unknown>> = [];

  for (const run of runs.sort()) {
    const runDir = path.join(RUNS_DIR, run);
    const resultPath = path.join(runDir, 'result.json');
    const diffPath = path.join(runDir, 'agent.diff');

    if (!fs.existsSync(resultPath) || !fs.existsSync(diffPath)) {
      console.log(`[skip] ${run}: 缺 result.json 或 agent.diff`);
      continue;
    }

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const agentDiff = fs.readFileSync(diffPath, 'utf8');
    const caseData = lookup.get(result.instance_id);
    if (!caseData) {
      console.log(`[skip] ${run}: instance ${result.instance_id} 不在 verified.jsonl`);
      continue;
    }

    if (!agentDiff.trim()) {
      console.log(`[skip] ${run}: agent.diff 为空`);
      summary.push({ run, instance: result.instance_id, judge_score: null, status: 'EMPTY_DIFF' });
      continue;
    }

    process.stdout.write(`[judge] ${run}... `);
    const t0 = Date.now();
    const judge = await judgePatchEquivalence({
      problem_statement: caseData.problem_statement,
      agent_diff: agentDiff,
      standard_patch: caseData.patch,
    });
    console.log(
      `score=${judge.semantic_match} (intent=${judge.matches_intent} impl=${judge.matches_implementation}) ${Date.now() - t0}ms`,
    );

    const diffShapeValidation = buildDiffShapeValidation(agentDiff, caseData.patch);
    const diffShape = diffShapePassed(diffShapeValidation);
    const executableValidation = (result.executable_validation ?? missingExecutableValidation()) as ExecutableValidation;
    const outcome = decideRunOutcome({
      finished: Boolean(result.finished),
      diff_shape_passed: diffShape,
      executable_validation: executableValidation,
      judge,
    });

    // 写回 result.json，保留原有字段，但使用新口径覆盖 passed。
    result.judge = judge;
    result.diff_shape_passed = diffShape;
    result.diff_shape_validation = diffShapeValidation;
    result.executable_validation = executableValidation;
    result.status = outcome.status;
    result.failure_reasons = outcome.reasons;
    result.passed = outcome.passed;
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

    summary.push({
      run,
      instance: result.instance_id,
      diff_shape: diffShape,
      executable: executableValidation.status,
      judge_score: judge.semantic_match,
      semantic_pass: judge.semantic_match >= 70,
      final_status: outcome.status,
      combined_pass: outcome.passed,
      finished: result.finished,
      rounds: result.rounds_used,
    });
  }

  // 总结表
  console.log('\n\n══════════════════════════════════════════════════════════════════════════════');
  console.log('Run                                          | Shape | Exec   | Judge | Semantic | Final');
  console.log('─────────────────────────────────────────────|-------|--------|-------|----------|----------');
  for (const s of summary) {
    const judge = s.judge_score === null ? 'N/A' : String(s.judge_score).padStart(3);
    const shape = s.diff_shape === undefined ? '?' : s.diff_shape ? '✓' : '✗';
    const sem = s.semantic_pass === undefined ? '?' : s.semantic_pass ? '✓' : '✗';
    const combined = s.combined_pass === undefined ? '?' : s.combined_pass ? '✅' : '❌';
    const runName = String(s.run).padEnd(45);
    console.log(`${runName}|   ${shape}   | ${String(s.executable ?? '?').padEnd(6)} |  ${judge}  |    ${sem}     |    ${combined}`);
  }
  console.log('══════════════════════════════════════════════════════════════════════════════\n');

  // 关键统计
  const withJudge = summary.filter((s) => s.judge_score !== null && s.judge_score !== undefined);
  const shapePass = withJudge.filter((s) => s.diff_shape).length;
  const executablePass = withJudge.filter((s) => s.executable === 'passed').length;
  const judgePass = withJudge.filter((s) => s.semantic_pass).length;
  const combinedPass = withJudge.filter((s) => s.combined_pass).length;
  console.log(`Diff-shape pass: ${shapePass}/${withJudge.length}`);
  console.log(`Executable pass: ${executablePass}/${withJudge.length}`);
  console.log(`Judge pass:      ${judgePass}/${withJudge.length}`);
  console.log(`Final pass:      ${combinedPass}/${withJudge.length}`);
  console.log(`形状假阳性数:    ${shapePass - combinedPass}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
