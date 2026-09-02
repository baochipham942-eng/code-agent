import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvalRunEvent } from '../../src/shared/contract/evaluation';

const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const evalScript = path.join(repoRoot, 'packages', 'internal', 'evaluation-center', 'scripts', 'eval-ci.ts');
let tempRoot: string;
let caseDir: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'eval-retired-'));
  caseDir = path.join(tempRoot, 'cases');
  await mkdir(caseDir);
  await writeFile(path.join(caseDir, 'rotation.yaml'), [
    'name: rotation-cli-suite',
    'cases:',
    '  - id: retired-cli-case',
    '    type: task',
    '    prompt: retired prompt',
    '    expect:',
    '      no_crash: true',
    '    rotation:',
    "      retire_after: '2026-09-30'",
    '  - id: active-cli-case',
    '    type: task',
    '    prompt: active prompt',
    '    expect:',
    '      no_crash: true',
    '',
  ].join('\n'));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function runEval(extraArgs: string[] = []): Promise<EvalRunEvent[]> {
  const dataDir = await mkdtemp(path.join(tempRoot, 'data-'));
  const output = await new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      tsxCli,
      evalScript,
      '--scope', 'smoke',
      '--case-dir', caseDir,
      '--json-events',
      '--max-cases', '2',
      '--force',
      ...extraArgs,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODE_AGENT_DATA_DIR: dataDir,
        NEO_EVAL_ANSWERS_DIR: 'none',
        NEO_EVAL_TODAY: '2026-10-01',
        TSX_TSCONFIG_PATH: path.join(repoRoot, 'tsconfig.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, exitCode: code ?? -1 }));
  });
  expect(output.exitCode).toBe(0);
  return output.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as EvalRunEvent);
}

describe('eval-ci retired case replay', () => {
  it('默认从计划排除到期题，并在 run_end 记录 retiredSkipped', async () => {
    const events = await runEval();
    const start = events.find((event) => event.type === 'run_start');
    const end = events.find((event) => event.type === 'run_end');

    expect(start).toMatchObject({ plannedCaseIds: ['active-cli-case'] });
    expect(end).toMatchObject({ summary: { retiredSkipped: ['retired-cli-case'] } });
  });

  it('--include-retired 把到期题放回执行计划', async () => {
    const events = await runEval(['--include-retired']);
    const start = events.find((event) => event.type === 'run_start');
    const end = events.find((event) => event.type === 'run_end');

    expect(start).toMatchObject({
      plannedCaseIds: ['retired-cli-case', 'active-cli-case'],
      config: { includeRetired: true },
    });
    expect(end?.type === 'run_end' ? end.summary.retiredSkipped : undefined).toBeUndefined();
  });
});
