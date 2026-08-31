import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EVAL_RUN_STAMP_KEYS,
  EVAL_RUN_EVENT_SCHEMA_VERSION,
  type EvalRunEvent,
} from '../../src/shared/contract/evaluation';

const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const evalScript = path.join(repoRoot, 'packages', 'internal', 'evaluation-center', 'scripts', 'eval-ci.ts');
const tempDirs: string[] = [];

async function runJsonEval(extraArgs: string[] = []): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-json-events-'));
  tempDirs.push(dataDir);

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, evalScript, '--scope', 'smoke', '--max-cases', '1', '--json-events', ...extraArgs],
      {
        cwd: repoRoot,
        env: { ...process.env, CODE_AGENT_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

async function runJsonEvalFailure(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-json-events-error-'));
  tempDirs.push(dataDir);
  const failureRunner = path.join(dataDir, 'failure-runner.mjs');
  await writeFile(
    failureRunner,
    `import { Console } from 'node:console';\n`
      + `import fs from 'node:fs';\n`
      + `import { Writable } from 'node:stream';\n`
      + `let runEnded = false;\n`
      + `const originalWriteSync = fs.writeSync.bind(fs);\n`
      + `fs.writeSync = (...args) => {\n`
      + `  if (args[0] === process.stdout.fd && String(args[1]).includes('"type":"run_end"')) runEnded = true;\n`
      + `  return originalWriteSync(...args);\n`
      + `};\n`
      + `const errorSink = new Writable({ write(chunk, encoding, callback) {\n`
      + `  (runEnded ? process.stdout : process.stderr).write(chunk, encoding, callback);\n`
      + `} });\n`
      + `globalThis.console = new Console({ stdout: process.stderr, stderr: errorSink });\n`
      + `process.argv[1] = ${JSON.stringify(evalScript)};\n`
      + `await import(${JSON.stringify(pathToFileURL(evalScript).href)});\n`,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        tsxCli,
        failureRunner,
        '--scope',
        'smoke',
        '--json-events',
        '--real',
        '--model',
        'mock-model',
        '--provider',
        'custom-json-events-error',
        '--max-cases',
        '1',
        '--force',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          AUTO_TEST_API_KEY: 'test-key',
          AUTO_TEST_BASE_URL: '',
          CODE_AGENT_DATA_DIR: dataDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

async function runJsonEvalWithoutPolicy(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-json-events-policy-'));
  tempDirs.push(dataDir);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        tsxCli,
        evalScript,
        '--scope', 'smoke',
        '--json-events',
        '--real',
        '--model', 'policy-gate-model',
        '--provider', 'openai',
        '--max-cases', '1',
        '--force',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          AUTO_TEST_API_KEY: 'test-key',
          CODE_AGENT_DATA_DIR: dataDir,
          NEO_SCRIPTED_APPROVAL_POLICY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('eval-ci --json-events', () => {
  it('keeps stdout as a complete NDJSON run protocol and writes one report group', async () => {
    const result = await runJsonEval();
    const lines = result.stdout.trim().split('\n');
    const events = lines.map((line) => JSON.parse(line) as EvalRunEvent);

    expect(lines.length).toBeGreaterThan(2);
    expect(events.every((event) => event.schemaVersion === EVAL_RUN_EVENT_SCHEMA_VERSION)).toBe(true);
    expect(events[0]).toMatchObject({ type: 'run_start', schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION });
    expect(events.at(-1)).toMatchObject({ type: 'run_end', schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION });
    expect(events.every((event) => event.runId === events[0].runId)).toBe(true);

    const runStart = events[0] as Extract<EvalRunEvent, { type: 'run_start' }>;
    const runEnd = events.at(-1) as Extract<EvalRunEvent, { type: 'run_end' }>;
    for (const key of EVAL_RUN_STAMP_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(runStart.config, key), key).toBe(true);
      expect(runStart.config[key], key).not.toBeUndefined();
      expect(runStart.config[key], key).not.toBeNull();
    }
    expect(runStart.config).toMatchObject({
      mode: 'mock',
      model: 'mock-model',
      keySource: 'none',
    });
    expect(runStart.config.caseBankSha).toMatch(/^[0-9a-f]{40}(?:-dirty)?$/);
    expect(JSON.stringify(runStart.config)).not.toContain('undefined');
    const caseEnds = events.filter(
      (event): event is Extract<EvalRunEvent, { type: 'case_end' }> => event.type === 'case_end',
    );
    const toolCalls = events.filter(
      (event): event is Extract<EvalRunEvent, { type: 'tool_call' }> => event.type === 'tool_call',
    );
    const toolResults = events.filter(
      (event): event is Extract<EvalRunEvent, { type: 'tool_result' }> => event.type === 'tool_result',
    );
    const plannedCaseIds = new Set(runStart.plannedCaseIds);
    expect(runStart.plannedCaseIds).toHaveLength(1);
    expect(caseEnds).toHaveLength(runStart.plannedCaseIds.length);
    expect(caseEnds.every((event) => !('responses' in event) && !('toolExecutions' in event))).toBe(true);
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls.every((event) => plannedCaseIds.has(event.testId) && event.tool.length > 0)).toBe(true);
    expect(toolResults.every(
      (event) => plannedCaseIds.has(event.testId)
        && event.tool.length > 0
        && typeof event.success === 'boolean',
    )).toBe(true);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(runEnd.exitCode, result.stderr.slice(-3000)).toBe(result.exitCode);
    // 退出码语义：0 跑满无回归 / 1 回归 / 2 未跑满或 abort。mock smoke 是否对
    // .claude/eval-mock-baseline.json 判出回归取决于跑测机器（08-29 CI ubuntu 上判了回归、
    // 本机 20/20 绿），那是基线口径的事不是事件协议的事——本测试只钉「跑满且 run_end 与
    // 真实退出码一致」；exit 2 的 abort 路径由 evalCiPromoteReport.test.ts 单测覆盖。
    expect(runEnd.aborted, result.stderr.slice(-3000)).toBe(false);
    expect([0, 1], result.stderr.slice(-3000)).toContain(result.exitCode);

    expect(runEnd.reportFiles).toHaveLength(2);
    await Promise.all(runEnd.reportFiles.map((reportFile) => stat(reportFile)));
    const reportGroups = new Set(
      runEnd.reportFiles.map((reportFile) => path.basename(reportFile).replace(/\.(md|json)$/, '')),
    );
    expect(reportGroups.size).toBe(1);

    // Mutation guard: all paths share the one persistence choke point.
    const evalSource = await readFile(evalScript, 'utf8');
    expect(evalSource.match(/\bsaveReport\(/g)).toHaveLength(1);
  }, 120_000);

  it('lets --force bypass --max-cases and plan the full filtered suite', async () => {
    const result = await runJsonEval(['--force']);
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as EvalRunEvent);
    const runStart = events[0] as Extract<EvalRunEvent, { type: 'run_start' }>;

    expect(runStart.plannedCaseIds.length).toBeGreaterThan(1);
    expect(runStart.config.maxCases).toBe(runStart.plannedCaseIds.length);
  }, 120_000);

  it('keeps a thrown run failure as NDJSON ending in run_end and reports details on stderr', async () => {
    const result = await runJsonEvalFailure();
    const lines = result.stdout.trim().split('\n');
    const events = lines.map((line) => JSON.parse(line) as EvalRunEvent);
    const errorIndex = events.findIndex((event) => event.type === 'error');
    const runEndIndex = events.findIndex((event) => event.type === 'run_end');

    expect(result.exitCode).not.toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'run_end', exitCode: result.exitCode });
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeLessThan(runEndIndex);
    expect(result.stderr).toContain('eval-ci failed:');
  }, 120_000);

  it('rejects a real event-stream run without a readable approval policy', async () => {
    const result = await runJsonEvalWithoutPolicy();
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as EvalRunEvent);

    expect(result.exitCode).toBe(2);
    expect(events.some((event) => event.type === 'error' && event.error.includes('审批策略'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run_end', exitCode: 2 });
    expect(result.stderr).toContain('审批策略');
  }, 120_000);
});
