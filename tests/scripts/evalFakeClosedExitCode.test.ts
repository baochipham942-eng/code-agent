import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

describe('eval 未跑满退出码', () => {
  it('子进程真实跑出 not_run 后返回 exit 2', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-fakeclosed-child-'));
    const casesDir = path.join(root, 'cases');
    await mkdir(casesDir, { recursive: true });
    await writeFile(path.join(casesDir, 'suite.yaml'), [
      'name: child',
      'cases:',
      '  - id: first',
      '    type: task',
      '    description: first',
      '    prompt: ok',
      '    expect: { response_contains: [ok] }',
      '  - id: abort',
      '    type: task',
      '    description: abort',
      '    prompt: abort',
      '    depends_on: [first]',
      '    expect: { response_contains: [ok] }',
      '  - id: last',
      '    type: task',
      '    description: last',
      '    prompt: never',
      '    depends_on: [abort]',
      '    expect: { response_contains: [ok] }',
      '',
    ].join('\n'));
    const source = [
      "import { TestRunner } from './src/host/testing/testRunner.ts';",
      "import { getEvalProcessExitCode } from './src/host/testing/ci/evalRunOutcome.ts';",
      `const root=${JSON.stringify(root)};`,
      `const casesDir=${JSON.stringify(casesDir)};`,
      "const agent={sendMessage:async(p:string)=>p==='abort'?{responses:[],toolExecutions:[],turnCount:0,errors:['Insufficient account balance']}:{responses:['ok'],toolExecutions:[],turnCount:1,errors:[]},reset:async()=>{},getAgentInfo:()=>({name:'child',model:'fixture',provider:'mock'})};",
      "const runner=new TestRunner({testCaseDir:casesDir,resultsDir:root,workingDirectory:root,defaultTimeout:1000,stopOnFailure:false,verbose:false,parallel:false,maxParallel:1,enableEvalCritic:false},agent);",
      '(async()=>{const summary=await runner.runAll();if(summary.total!==3||summary.results[2]?.status!==\'not_run\')process.exit(9);process.exit(getEvalProcessExitCode(summary));})().catch(()=>process.exit(8));',
    ].join('');

    try {
      await expect(execFileAsync(process.execPath, [tsxCli, '-e', source], {
        cwd: repoRoot,
        timeout: 30_000,
      })).rejects.toMatchObject({ code: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('GAIA 报告口径', () => {
  it('无效题不计 passed，环境故障单列且输出使用用户词表', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gaia-fakeclosed-report-'));
    await writeFile(path.join(root, 'report-fixture.json'), JSON.stringify({
      startTime: 1,
      environment: { model: 'fixture-model' },
      results: [
        { testId: 'gaia-l1-pass', status: 'passed', score: 1, duration: 1 },
        { testId: 'gaia-l1-invalid', status: 'passed', score: 1, duration: 1, invalid: { reason: 'usage_unavailable' } },
        { testId: 'gaia-l1-infra', status: 'infra_excluded', score: 0, duration: 1, failureReason: 'fetch failed' },
      ],
    }));

    try {
      const { stdout } = await execFileAsync(process.execPath, [
        tsxCli,
        'scripts/gaia-report.ts',
        '--results-dir',
        root,
      ], { cwd: repoRoot, timeout: 30_000 });

      expect(stdout).toContain('| L1 | 3 | 1 | 1 | **50.0%** |');
      expect(stdout).toContain('usage_unavailable');
      expect(stdout).not.toMatch(/假跑|标废|已作废|分母/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
