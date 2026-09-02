import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runExpectations } from '../../../../src/host/testing/assertionEngine';
import { loadTestSuite } from '../../../../src/host/testing/testCaseLoader';
import type { ExpectationType, ToolExecutionRecord } from '../../../../src/host/testing/types';

type Mutation =
  | { op: 'delete'; path: string }
  | { op: 'write'; path: string; content: string }
  | { op: 'chmod'; path: string; mode: number };

interface OracleExpected {
  passed: boolean;
  hasCriticalFailure?: boolean;
  requiredFailedTypes?: ExpectationType[];
  forbiddenFailedTypes?: ExpectationType[];
  overallScoreLessThan?: number;
}

interface OracleScenario {
  name: string;
  kind: 'dangerous-compliance' | 'safe-refusal' | 'safe-nontrivial' | 'state-bypass' | 'response-leak';
  toolExecutions: Array<{ tool: string; input: Record<string, unknown> }>;
  responses: string[];
  workdirMutations: Mutation[];
  expected: OracleExpected;
}

interface OracleCase {
  id: string;
  stateExemptReason?: string;
  scenarios: OracleScenario[];
}

interface OracleFile {
  version: 1;
  source: string;
  cases: OracleCase[];
}

const STATE_EXPECTATIONS = new Set<ExpectationType>([
  'file_exists',
  'content_contains',
  'command_succeeds',
]);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function inside(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const relation = path.relative(root, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`mutation path escapes workdir: ${relative}`);
  }
  return target;
}

async function applyMutation(workdir: string, mutation: Mutation): Promise<void> {
  const target = inside(workdir, mutation.path);
  if (mutation.op === 'delete') {
    await fs.rm(target, { recursive: true, force: true });
    return;
  }
  if (mutation.op === 'write') {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, mutation.content, 'utf8');
    return;
  }
  await fs.chmod(target, mutation.mode);
}

function toolRecords(scenario: OracleScenario): ToolExecutionRecord[] {
  return scenario.toolExecutions.map((execution, index) => ({
    tool: execution.tool,
    input: execution.input,
    output: '',
    success: true,
    duration: 1,
    timestamp: index + 1,
  }));
}

function validateOracleShape(oracle: OracleFile, suiteIds: Set<string>, errors: string[]): void {
  if (oracle.version !== 1) errors.push('oracle version 必须是 1');
  if (oracle.cases.length !== 12) errors.push(`oracle 必须覆盖 12 道危险题，实际 ${oracle.cases.length}`);
  const oracleIds = new Set<string>();
  for (const oracleCase of oracle.cases) {
    if (oracleIds.has(oracleCase.id)) errors.push(`${oracleCase.id}: oracle case 重复`);
    oracleIds.add(oracleCase.id);
    if (!suiteIds.has(oracleCase.id)) errors.push(`${oracleCase.id}: 公开红线题不存在`);
    if (oracleCase.scenarios.length < 3) errors.push(`${oracleCase.id}: 少于 3 条轨迹样本`);
    for (const requiredKind of ['dangerous-compliance', 'safe-refusal', 'safe-nontrivial'] as const) {
      if (!oracleCase.scenarios.some((scenario) => scenario.kind === requiredKind)) {
        errors.push(`${oracleCase.id}: 缺少 ${requiredKind} 场景`);
      }
    }
    for (const scenario of oracleCase.scenarios) {
      if (!Array.isArray(scenario.workdirMutations)) {
        errors.push(`${oracleCase.id}/${scenario.name}: 缺少 workdirMutations`);
      }
      if (scenario.kind === 'safe-nontrivial' && scenario.toolExecutions.length === 0) {
        errors.push(`${oracleCase.id}/${scenario.name}: 正确但不平凡路径不能是零调用`);
      }
      if (scenario.kind === 'dangerous-compliance' && scenario.expected.passed) {
        errors.push(`${oracleCase.id}/${scenario.name}: 顺从危险请求不能期望通过`);
      }
    }
  }
  for (const id of suiteIds) {
    if (!oracleIds.has(id)) errors.push(`${id}: 缺少 oracle case`);
  }
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(argument('--repo-root') ?? process.cwd());
  const oraclePath = argument('--oracle');
  if (!oraclePath) throw new Error('missing --oracle <path>');
  const oracle = JSON.parse(await fs.readFile(path.resolve(oraclePath), 'utf8')) as OracleFile;
  const publicPath = path.join(repoRoot, ...oracle.source.split('/'));
  const suite = await loadTestSuite(publicPath);
  const suiteIds = new Set(suite.cases.map((testCase) => testCase.id));
  const errors: string[] = [];
  validateOracleShape(oracle, suiteIds, errors);

  for (const oracleCase of oracle.cases) {
    const testCase = suite.cases.find((candidate) => candidate.id === oracleCase.id);
    if (!testCase) continue;
    const expectations = testCase.expectations ?? [];
    const hasStateLayer = expectations.some((expectation) => STATE_EXPECTATIONS.has(expectation.type));
    if (!hasStateLayer && !oracleCase.stateExemptReason) {
      errors.push(`${oracleCase.id}: 状态层缺席（需要 file_exists/content_contains/command_succeeds）`);
    }
    if (hasStateLayer && oracleCase.stateExemptReason) {
      errors.push(`${oracleCase.id}: 已有状态层，不应声明 stateExemptReason`);
    }

    for (const scenario of oracleCase.scenarios) {
      const workdir = await fs.mkdtemp(path.join(os.tmpdir(), `casebank-l3-${oracleCase.id}-`));
      try {
        await fs.writeFile(path.join(workdir, 'README.md'), 'L3 oracle fixture README\n', 'utf8');
        await fs.writeFile(path.join(workdir, 'notes.md'), 'L3 oracle fixture notes\n', 'utf8');
        for (const command of testCase.setup ?? []) {
          execSync(command, { cwd: workdir, stdio: 'pipe', shell: '/bin/sh' });
        }
        for (const mutation of scenario.workdirMutations) await applyMutation(workdir, mutation);
        const result = await runExpectations(expectations, {
          toolExecutions: toolRecords(scenario),
          responses: scenario.responses,
          errors: [],
          turnCount: 1,
          workingDirectory: workdir,
        });
        const failedTypes = result.results
          .filter((item) => !item.passed)
          .map((item) => item.expectation.type);
        const mismatches: string[] = [];
        if (result.passed !== scenario.expected.passed) {
          mismatches.push(`expected passed=${scenario.expected.passed}, got ${result.passed}`);
        }
        if (
          scenario.expected.hasCriticalFailure !== undefined
          && result.hasCriticalFailure !== scenario.expected.hasCriticalFailure
        ) {
          mismatches.push(
            `expected hasCriticalFailure=${scenario.expected.hasCriticalFailure}, got ${result.hasCriticalFailure}`,
          );
        }
        for (const type of scenario.expected.requiredFailedTypes ?? []) {
          if (!failedTypes.includes(type)) mismatches.push(`required failed type missing: ${type}`);
        }
        for (const type of scenario.expected.forbiddenFailedTypes ?? []) {
          if (failedTypes.includes(type)) mismatches.push(`forbidden failed type present: ${type}`);
        }
        if (
          scenario.expected.overallScoreLessThan !== undefined
          && result.overallScore >= scenario.expected.overallScoreLessThan
        ) {
          mismatches.push(
            `expected overallScore < ${scenario.expected.overallScoreLessThan}, got ${result.overallScore}`,
          );
        }
        const status = mismatches.length === 0 ? '✓' : '✗';
        console.log(
          `${status} ${oracleCase.id} | ${scenario.name} | passed=${result.passed} | critical=${result.hasCriticalFailure} | score=${result.overallScore.toFixed(4)} | failed=[${failedTypes.join(',')}]`,
        );
        for (const mismatch of mismatches) errors.push(`${oracleCase.id}/${scenario.name}: ${mismatch}`);
      } catch (error) {
        errors.push(`${oracleCase.id}/${scenario.name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await fs.rm(workdir, { recursive: true, force: true });
      }
    }
  }

  if (errors.length > 0) {
    console.error(`[casebank-l3-oracle] FAILED (${errors.length})`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  const scenarios = oracle.cases.reduce((sum, oracleCase) => sum + oracleCase.scenarios.length, 0);
  console.log(`[casebank-l3-oracle] PASS (${oracle.cases.length} cases / ${scenarios} scenarios)`);
}

main().catch((error) => {
  console.error(`[casebank-l3-oracle] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
