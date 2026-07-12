import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DURABLE_RUN_SCHEMA_VERSION } from '../../src/shared/contract/durableRun';
import { DURABLE_RUN_KILL_RESTART_SCENARIOS } from '../../tests/fixtures/durableRunKillRestart';

const BASELINE_SHA = 'b7f2e2ca9ca59967c07072845cfac05bd6d57624';
const root = path.resolve(import.meta.dirname, '../..');
const childEntry = path.join(root, 'tests/e2e/fixtures/durableRunProcessHost.ts');
const rolloutEntry = path.join(root, 'tests/e2e/fixtures/durableRunRolloutProcess.ts');
const tsx = path.join(root, 'node_modules/.bin/tsx');
const outputArg = process.argv.indexOf('--out');
const outputPath = path.resolve(root, outputArg >= 0 && process.argv[outputArg + 1]
  ? process.argv[outputArg + 1]!
  : 'test-results/durable-run-s9-acceptance.json');

interface ScenarioResult {
  scenarioId: string;
  coreId: string;
  pass: boolean;
  recoveryAction: string;
  oldOwnerEpoch: number;
  newOwnerEpoch: number;
  attempt: number;
  terminalCount: number;
  duplicateSideEffectCount: number;
  requiresReviewReason: string | null;
  rolloutMode: string;
  staleWriteRejected: boolean;
  eventSequenceMonotonic: boolean;
  completedNodesReexecuted: number;
  operationKeyStable: boolean;
  identityLinked: boolean;
  oldProcessInstanceId: string;
  newProcessInstanceId: string;
  counters: Record<string, number>;
  productionRecoveryPath: boolean;
}

const startedAt = Date.now();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'code-agent-s9-'));
const results: ScenarioResult[] = [];
let finalExitCode = 1;
try {
  for (const scenario of DURABLE_RUN_KILL_RESTART_SCENARIOS) {
    const scenarioDir = path.join(tempRoot, scenario.id);
    await mkdir(scenarioDir, { recursive: true });
    const preparer = startChild(['prepare', scenario.id, scenarioDir]);
    await waitForMarker(preparer, 'ready');
    await forceKill(preparer);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const recoverer = startChild(['recover', scenario.id, scenarioDir]);
    const result = await waitForMarker(recoverer, 'result') as unknown as ScenarioResult;
    const exitCode = await waitForExit(recoverer);
    if (exitCode !== 0) throw new Error(`${scenario.id} recovery child exited ${exitCode}`);
    results.push(result);
  }

  const rollbackRoundTrip = await runRollbackRoundTrip(path.join(tempRoot, 'rollout-roundtrip'));
  const testedSha = git(['rev-parse', 'HEAD']);
  const report = {
    schemaVersion: 1,
    baselineSha: BASELINE_SHA,
    testedSha,
    platform: { platform: process.platform, arch: process.arch, release: os.release() },
    nodeVersion: process.version,
    databaseSchemaVersion: DURABLE_RUN_SCHEMA_VERSION,
    rolloutMode: 'durable_preferred',
    killSwitch: 'CODE_AGENT_DURABLE_RUN_MODE=legacy',
    scenarios: results,
    rollbackRoundTrip,
    gates: {
      allKillPointsPassed: results.every((result) => result.pass),
      noDuplicateSideEffects: results.every((result) => result.duplicateSideEffectCount === 0),
      staleOwnersFenced: results.every((result) => result.staleWriteRejected),
      terminalUnique: results.every((result) => result.terminalCount <= 1),
      reviewBoundariesPreserved: results.every((result) => {
        const scenario = DURABLE_RUN_KILL_RESTART_SCENARIOS.find((candidate) => candidate.id === result.scenarioId)!;
        return scenario.expectedOutcome !== 'waiting_review'
          || result.requiresReviewReason === scenario.requiresReviewReason;
      }),
      rollbackRoundTripPassed: rollbackRoundTrip.pass,
      realProcessEvidence: results.every((result) => result.oldProcessInstanceId !== result.newProcessInstanceId),
      productionExecutorRecovery: results.every((result) => result.productionRecoveryPath),
      productionReadPreferenceWiring: false,
    },
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
  const pass = Object.values(report.gates).every(Boolean);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ ...report, pass }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ pass, report: outputPath, testedSha, scenarios: results.length, gates: report.gates })}\n`);
  finalExitCode = pass ? 0 : 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
process.exit(finalExitCode);

function startChild(args: string[]): ChildProcessWithoutNullStreams {
  const isolatedDataDir = args.at(-1)!;
  return spawn(tsx, [childEntry, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: isolatedDataDir, NODE_ENV: 'test',
      CODE_AGENT_DATA_DIR: isolatedDataDir, CODE_AGENT_CLI_MODE: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForMarker(child: ChildProcessWithoutNullStreams, expected: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expected}; stderr=${stderr}`)), 20_000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.marker === expected) {
          clearTimeout(timeout);
          resolve(parsed);
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      if (code !== null && expected !== 'result') {
        clearTimeout(timeout);
        reject(new Error(`child exited ${code} before ${expected}; stderr=${stderr}`));
      }
    });
  });
}

async function forceKill(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  } else {
    child.kill('SIGKILL');
  }
  await waitForExit(child);
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once('exit', resolve));
}

async function runRollbackRoundTrip(dataDir: string): Promise<Record<string, unknown> & { pass: boolean }> {
  await mkdir(dataDir, { recursive: true });
  const phases = ['durable_preferred:create', 'legacy:verify', 'durable_preferred:restore'];
  const outputs = phases.map((phase) => {
    const result = spawnSync(tsx, [rolloutEntry, phase, dataDir], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '', HOME: dataDir, NODE_ENV: 'test',
        CODE_AGENT_DATA_DIR: dataDir, CODE_AGENT_CLI_MODE: 'true',
      },
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`rollback ${phase} failed: ${result.stderr}`);
    const jsonLine = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{')).at(-1);
    if (!jsonLine) throw new Error(`rollback ${phase} produced no JSON result`);
    return JSON.parse(jsonLine) as { phase: string; mode: string; rowCount: number; tableCount: number; pass: boolean };
  });
  return { pass: outputs.every((output) => output.pass), phases: outputs };
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
