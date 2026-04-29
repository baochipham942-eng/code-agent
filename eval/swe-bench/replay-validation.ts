/**
 * Replays existing agent.diff files without calling the model API.
 *
 * Usage:
 *   npx tsx eval/swe-bench/replay-validation.ts \
 *     eval/swe-bench/runs/2026-04-28-django__django-15987-single \
 *     eval/swe-bench/runs/2026-04-28-django__django-16642-single
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

import type { ExecutableValidation } from './validation';
import {
  applyAgentDiff,
  buildDiffShapeValidation,
  decideRunOutcome,
  diffShapePassed,
  resetSandboxToBase,
  runExecutableValidation,
  runExecutableValidationDocker,
} from './validation';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const SANDBOX_DJANGO = path.join(REPO_ROOT, 'eval/swe-bench/sandbox/django');
const RUNS_DIR = path.join(REPO_ROOT, 'eval/swe-bench/runs');
const VERIFIED_JSONL = path.join(REPO_ROOT, 'eval-datasets/swe-bench/verified.jsonl');

type CaseData = {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch: string;
  test_patch: string;
  FAIL_TO_PASS: string;
};

function loadCases(): Map<string, CaseData> {
  const cases = fs.readFileSync(VERIFIED_JSONL, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as CaseData);
  return new Map(cases.map((caseData) => [caseData.instance_id, caseData]));
}

function resolveRunDirs(argv: string[]): string[] {
  if (argv.length > 0) return argv.map((arg) => path.resolve(REPO_ROOT, arg));

  return fs
    .readdirSync(RUNS_DIR)
    .filter((entry) => fs.statSync(path.join(RUNS_DIR, entry)).isDirectory())
    .map((entry) => path.join(RUNS_DIR, entry));
}

function validationError(reason: string): ExecutableValidation {
  return {
    status: 'error',
    applied_test_patch: false,
    fail_to_pass: [],
    test_labels: [],
    command: null,
    exit_code: null,
    duration_ms: 0,
    reason,
    stdout_tail: '',
    stderr_tail: reason,
  };
}

async function main() {
  const cases = loadCases();
  // 默认 docker 模式；--mode python 切回本地 Python
  const argv = process.argv.slice(2);
  const modeIdx = argv.indexOf('--mode');
  const mode: 'docker' | 'python' = modeIdx >= 0 && argv[modeIdx + 1] === 'python' ? 'python' : 'docker';
  const positional = argv.filter((arg, i) => arg !== '--mode' && argv[i - 1] !== '--mode');
  console.log(`[mode] executable validation = ${mode}\n`);
  const runDirs = resolveRunDirs(positional);
  const summary: Array<{ run: string; instance: string; status: string; passed: boolean; reasons: string[]; executable: string }> = [];
  let lastBaseCommit: string | null = null;

  for (const runDir of runDirs) {
    const resultPath = path.join(runDir, 'result.json');
    const diffPath = path.join(runDir, 'agent.diff');
    const standardPath = path.join(runDir, 'standard.patch');
    const runName = path.basename(runDir);

    if (!fs.existsSync(resultPath) || !fs.existsSync(diffPath)) {
      console.log(`[skip] ${runName}: missing result.json or agent.diff`);
      continue;
    }

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      instance_id: string;
      finished?: boolean;
      passed?: boolean;
      judge?: { semantic_match: number; matches_intent?: boolean; matches_implementation?: boolean } | null;
      [key: string]: unknown;
    };
    const agentDiff = fs.readFileSync(diffPath, 'utf8');
    const caseData = cases.get(result.instance_id);
    if (!caseData) {
      console.log(`[skip] ${runName}: ${result.instance_id} not found in verified.jsonl`);
      continue;
    }
    lastBaseCommit = caseData.base_commit;

    const standardPatch = fs.existsSync(standardPath) ? fs.readFileSync(standardPath, 'utf8') : caseData.patch;
    const diffShapeValidation = buildDiffShapeValidation(agentDiff, standardPatch);
    const diffShape = diffShapePassed(diffShapeValidation);

    process.stdout.write(`[replay] ${runName}: ${mode} test... `);

    let executableValidation: ExecutableValidation;
    if (mode === 'docker') {
      // Docker 模式: 直接在 SWE-bench 官方 image 里 apply patches + 跑测试
      const patchesDir = path.join(runDir, '_docker-patches');
      executableValidation = runExecutableValidationDocker({
        instanceId: caseData.instance_id,
        agentDiff,
        testPatch: caseData.test_patch,
        failToPass: caseData.FAIL_TO_PASS,
        patchesDir,
      });
    } else {
      // 本地 Python 模式（兼容老路径）
      resetSandboxToBase(SANDBOX_DJANGO, caseData.base_commit);
      const applyResult = agentDiff.trim()
        ? applyAgentDiff(SANDBOX_DJANGO, agentDiff)
        : { ok: false, error: 'empty agent.diff' };
      executableValidation = applyResult.ok
        ? runExecutableValidation({
            sandboxRoot: SANDBOX_DJANGO,
            testPatch: caseData.test_patch,
            failToPass: caseData.FAIL_TO_PASS,
          })
        : validationError(`agent_diff_apply_failed: ${applyResult.error}`);
    }

    const outcome = decideRunOutcome({
      finished: Boolean(result.finished),
      diff_shape_passed: diffShape,
      executable_validation: executableValidation,
      judge: result.judge ?? null,
    });

    const replayResult = {
      run: runName,
      instance_id: result.instance_id,
      old_passed: result.passed ?? null,
      finished: Boolean(result.finished),
      passed: outcome.passed,
      status: outcome.status,
      failure_reasons: outcome.reasons,
      diff_shape_passed: diffShape,
      diff_shape_validation: diffShapeValidation,
      executable_validation: executableValidation,
      judge: result.judge ?? null,
    };

    fs.writeFileSync(path.join(runDir, 'replay-result.json'), JSON.stringify(replayResult, null, 2));
    console.log(`${outcome.status} executable=${executableValidation.status} reasons=${outcome.reasons.join(',') || 'none'}`);

    summary.push({
      run: runName,
      instance: String(result.instance_id),
      status: outcome.status,
      passed: outcome.passed,
      reasons: outcome.reasons,
      executable: executableValidation.status,
    });
  }

  console.log('\nRun                                          | Instance              | Exec   | Status   | Pass | Reasons');
  console.log('---------------------------------------------|-----------------------|--------|----------|------|------------------------------');
  for (const item of summary) {
    console.log(
      `${item.run.padEnd(45)}| ${item.instance.padEnd(21)} | ${item.executable.padEnd(6)} | ${item.status.padEnd(8)} | ${
        item.passed ? 'yes ' : 'no  '
      } | ${item.reasons.join(', ') || 'none'}`,
    );
  }

  if (mode === 'python' && lastBaseCommit) {
    resetSandboxToBase(SANDBOX_DJANGO, lastBaseCommit);
    console.log(`\n[cleanup] sandbox reset to ${lastBaseCommit.slice(0, 12)}`);
  }
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
