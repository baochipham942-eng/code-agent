import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runExpectations } from '../../../../src/host/testing/assertionEngine';
import { loadTestSuite } from '../../../../src/host/testing/testCaseLoader';
import type { ExpectationType, ToolExecutionRecord } from '../../../../src/host/testing/types';

interface OracleExpected {
  passed: boolean;
  requiredFailedTypes?: ExpectationType[];
}

interface OracleScenario {
  name: string;
  kind: 'correct' | 'incorrect';
  shellActions: string[];
  toolExecutions: Array<{ tool: string; input: Record<string, unknown> }>;
  responses: string[];
  expected: OracleExpected;
}

interface OracleFile {
  version: 1;
  source: string;
  cases: Array<{ id: string; scenarios: OracleScenario[] }>;
}

const EXPECTED_IDS = new Set([
  'git-commit-message',
  'git-branch-create',
  'git-conflict-awareness',
]);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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

function validateShape(oracle: OracleFile, errors: string[]): void {
  if (oracle.version !== 1) errors.push('oracle version 必须是 1');
  const ids = new Set(oracle.cases.map((item) => item.id));
  if (ids.size !== oracle.cases.length) errors.push('oracle case id 重复');
  for (const id of EXPECTED_IDS) {
    if (!ids.has(id)) errors.push(`${id}: 缺少 oracle case`);
  }
  for (const id of ids) {
    if (!EXPECTED_IDS.has(id)) errors.push(`${id}: 不属于三道 L0 git 题`);
  }
  for (const oracleCase of oracle.cases) {
    for (const kind of ['correct', 'incorrect'] as const) {
      if (!oracleCase.scenarios.some((scenario) => scenario.kind === kind)) {
        errors.push(`${oracleCase.id}: 缺少 ${kind} 场景`);
      }
    }
    for (const scenario of oracleCase.scenarios) {
      if (scenario.kind === 'correct' && !scenario.expected.passed) {
        errors.push(`${oracleCase.id}/${scenario.name}: 正确样本必须期望通过`);
      }
      if (scenario.kind === 'incorrect' && scenario.expected.passed) {
        errors.push(`${oracleCase.id}/${scenario.name}: 错误样本不能期望通过`);
      }
    }
  }
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(argument('--repo-root') ?? process.cwd());
  const oraclePath = argument('--oracle');
  if (!oraclePath) throw new Error('missing --oracle <path>');
  const oracle = JSON.parse(await fs.readFile(path.resolve(oraclePath), 'utf8')) as OracleFile;
  const suite = await loadTestSuite(path.join(repoRoot, ...oracle.source.split('/')));
  const errors: string[] = [];
  validateShape(oracle, errors);

  for (const oracleCase of oracle.cases) {
    const testCase = suite.cases.find((candidate) => candidate.id === oracleCase.id);
    if (!testCase) {
      errors.push(`${oracleCase.id}: 公开题不存在`);
      continue;
    }
    for (const scenario of oracleCase.scenarios) {
      const workdir = await fs.mkdtemp(path.join(os.tmpdir(), `casebank-l0-${oracleCase.id}-`));
      try {
        for (const command of testCase.setup ?? []) {
          execSync(command, { cwd: workdir, stdio: 'pipe', shell: '/bin/sh' });
        }
        for (const action of scenario.shellActions) {
          execSync(action, { cwd: workdir, stdio: 'pipe', shell: '/bin/sh' });
        }
        const result = await runExpectations(testCase.expectations ?? [], {
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
        for (const type of scenario.expected.requiredFailedTypes ?? []) {
          if (!failedTypes.includes(type)) mismatches.push(`required failed type missing: ${type}`);
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
    console.error(`[casebank-l0-git-oracle] FAILED (${errors.length})`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  const scenarios = oracle.cases.reduce((sum, item) => sum + item.scenarios.length, 0);
  console.log(`[casebank-l0-git-oracle] PASS (${oracle.cases.length} cases / ${scenarios} scenarios)`);
}

main().catch((error) => {
  console.error(`[casebank-l0-git-oracle] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
