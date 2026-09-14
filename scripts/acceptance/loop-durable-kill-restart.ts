import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isChildGone } from './childProcessState';
import { resolveMutationAcceptanceExitCode } from './mutationExitCode';
import { LOOP_INTERRUPTED_REASON } from '../../src/host/loop/loopDurableLedger';
import {
  LOOP_RECOVERY_RERUN_REASON,
  LOOP_RECOVERY_SLEEP_REASON,
} from '../../src/host/loop/loopRecoveryHandler';

const root = path.resolve(import.meta.dirname, '../..');
const childEntry = path.join(root, 'tests/e2e/fixtures/loopDurableProcessHost.ts');
const tsxCli = path.join(root, 'node_modules/tsx/dist/cli.mjs');
const outputArg = process.argv.indexOf('--out');
const outputPath = path.resolve(root, outputArg >= 0 && process.argv[outputArg + 1]
  ? process.argv[outputArg + 1]!
  : 'test-results/loop-durable-kill-restart.json');
const mutateArg = process.argv.indexOf('--mutate');
const mutation = mutateArg >= 0 ? process.argv[mutateArg + 1] : undefined;
if (mutation && mutation !== 'omit-adopt') {
  throw new Error(`unknown --mutate ${mutation}; expected omit-adopt`);
}

interface ReadyMarker {
  marker: 'ready';
  pid: number;
  runId: string;
  oldProcessInstanceId: string;
  heartbeatRenewed: boolean;
  scenario: 'sleeping' | 'dispatching';
  phase: string;
  turn: number;
  sendCount: number;
}

interface RecoverResult {
  marker: 'result';
  pid: number;
  runId: string;
  claimed: boolean;
  handler: string | null;
  handlerRecoverCalls: number;
  recoveryReason: string | null;
  extraMetaTurnExpected: boolean;
  envelopeStatus: string | null;
  terminalReason: string | null;
  interruptedReason: string;
  ownerEpoch: number | null;
  oldProcessInstanceId: string;
  newProcessInstanceId: string | null;
  liveStatus: string | null;
  liveTurn: number | null;
  liveStopReason: string | null;
  sendPrompts: string[];
  sendCount: number;
  leftoverRecoverable: number;
  attempts: Array<{
    attempt: number;
    owner_epoch: number;
    process_instance_id: string;
    status: string;
  }>;
  scenario: 'sleeping' | 'dispatching';
  preparePhase: string;
  prepareTurn: number;
  mutation: string | null;
}

interface ClaimResult {
  marker: 'result';
  pid: number;
  runId: string;
  claimed: boolean;
  ownerEpoch: number | null;
  processInstanceId: string;
  recoverableCount: number;
  error: string | null;
}

const startedAt = Date.now();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'code-agent-loop-durable-'));
let finalExitCode: number;

try {
  const sleepingDir = path.join(tempRoot, 'sleeping');
  await mkdir(sleepingDir, { recursive: true });
  const sleeping = await runKillRestart(sleepingDir, 'sleeping');

  const dispatchingDir = path.join(tempRoot, 'dispatching');
  await mkdir(dispatchingDir, { recursive: true });
  const dispatching = await runKillRestart(dispatchingDir, 'dispatching');

  let concurrent: {
    pass: boolean;
    winners: number;
    results: ClaimResult[];
  } | null = null;
  if (!mutation) {
    const concurrentDir = path.join(tempRoot, 'epoch-fence');
    await mkdir(concurrentDir, { recursive: true });
    concurrent = await runConcurrentClaim(concurrentDir);
  }

  const gates = {
    resumeFromSleep: sleeping.recover.envelopeStatus === 'completed'
      && sleeping.recover.terminalReason === 'condition_met'
      && sleeping.recover.recoveryReason === LOOP_RECOVERY_SLEEP_REASON
      && sleeping.recover.liveTurn != null
      && sleeping.recover.liveTurn > sleeping.recover.prepareTurn,
    atLeastOnceRerun: dispatching.recover.envelopeStatus === 'completed'
      && dispatching.recover.terminalReason === 'condition_met'
      && dispatching.recover.recoveryReason === LOOP_RECOVERY_RERUN_REASON
      && dispatching.recover.extraMetaTurnExpected === true
      && dispatching.recover.sendCount >= 2
      && dispatching.ready.sendCount >= 1,
    terminalAfterRecover: sleeping.recover.envelopeStatus === 'completed'
      && dispatching.recover.envelopeStatus === 'completed'
      && sleeping.recover.liveStopReason === 'condition_met'
      && dispatching.recover.liveStopReason === 'condition_met'
      && sleeping.recover.leftoverRecoverable === 0
      && dispatching.recover.leftoverRecoverable === 0,
    heartbeatRan: sleeping.ready.heartbeatRenewed && dispatching.ready.heartbeatRenewed,
    realProcessEvidence: sleeping.recover.attempts.length >= 2
      && sleeping.recover.oldProcessInstanceId !== sleeping.recover.newProcessInstanceId
      && dispatching.recover.oldProcessInstanceId !== dispatching.recover.newProcessInstanceId,
    productionRecoveryPath: sleeping.recover.handler === 'loop'
      && dispatching.recover.handler === 'loop',
    ...(concurrent ? { epochFence: concurrent.pass } : {}),
  };
  const pass = Object.values(gates).every(Boolean);

  const testedSha = git(['rev-parse', 'HEAD']);
  const report = {
    schemaVersion: 1,
    testedSha,
    mutation: mutation ?? null,
    platform: { platform: process.platform, arch: process.arch, release: os.release() },
    nodeVersion: process.version,
    interruptedReason: LOOP_INTERRUPTED_REASON,
    sleeping,
    dispatching,
    concurrent,
    gates,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    pass,
    extraMetaTurnNote: 'dispatching 崩溃后重跑当轮是 at-least-once：session 会多一条 historyVisibility=meta 的轮次 prompt，这是拍板语义，不是泄漏到用户可见历史。',
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    pass,
    report: outputPath,
    testedSha,
    mutation: mutation ?? null,
    gates,
    sleeping: {
      envelopeStatus: sleeping.recover.envelopeStatus,
      terminalReason: sleeping.recover.terminalReason,
      recoveryReason: sleeping.recover.recoveryReason,
    },
    dispatching: {
      envelopeStatus: dispatching.recover.envelopeStatus,
      terminalReason: dispatching.recover.terminalReason,
      recoveryReason: dispatching.recover.recoveryReason,
      sendCount: dispatching.recover.sendCount,
      extraMetaTurnExpected: dispatching.recover.extraMetaTurnExpected,
    },
    concurrent: concurrent
      ? { winners: concurrent.winners, pids: concurrent.results.map((result) => result.pid) }
      : null,
  })}\n`);
  if (mutation && pass) {
    process.stderr.write(`mutation ${mutation} not caught: gates stayed green — 变异未被抓到,验收无效\n`);
  }
  finalExitCode = resolveMutationAcceptanceExitCode(pass, mutation);
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
process.exit(finalExitCode);

async function runKillRestart(
  dataDir: string,
  scenario: 'sleeping' | 'dispatching',
): Promise<{ ready: ReadyMarker; recover: RecoverResult }> {
  const preparer = startChild(['prepare', dataDir, scenario]);
  const ready = await waitForMarker(preparer, 'ready') as unknown as ReadyMarker;
  await forceKill(preparer, ready.pid);
  const recoverer = startChild(['recover', dataDir, scenario]);
  const recover = await waitForMarker(recoverer, 'result') as unknown as RecoverResult;
  const exitCode = await waitForExit(recoverer);
  if (exitCode !== 0) throw new Error(`recover child exited ${exitCode}`);
  return { ready, recover };
}

async function runConcurrentClaim(dataDir: string): Promise<{
  pass: boolean;
  winners: number;
  results: ClaimResult[];
}> {
  const preparer = startChild(['prepare', dataDir, 'sleeping']);
  const ready = await waitForMarker(preparer, 'ready') as unknown as ReadyMarker;
  await forceKill(preparer, ready.pid);
  const first = startChild(['claim', dataDir]);
  const second = startChild(['claim', dataDir]);
  await Promise.all([waitForMarker(first, 'armed'), waitForMarker(second, 'armed')]);
  const firstResult = waitForMarker(first, 'result');
  const secondResult = waitForMarker(second, 'result');
  await writeFile(path.join(dataDir, 'go'), '1\n');
  const [leftRaw, rightRaw] = await Promise.all([firstResult, secondResult]);
  const left = leftRaw as unknown as ClaimResult;
  const right = rightRaw as unknown as ClaimResult;
  const [leftExit, rightExit] = await Promise.all([waitForExit(first), waitForExit(second)]);
  if (leftExit !== 0) throw new Error(`claim child A exited ${leftExit}`);
  if (rightExit !== 0) throw new Error(`claim child B exited ${rightExit}`);
  const results = [left, right];
  const winners = results.filter((result) => result.claimed).length;
  const epochs = results.filter((result) => result.claimed).map((result) => result.ownerEpoch);
  return {
    pass: winners === 1 && epochs[0] === 2 && results.every((result) => result.error == null),
    winners,
    results,
  };
}

function childEnv(isolatedDataDir: string): NodeJS.ProcessEnv {
  return {
    ...(process.platform === 'win32' ? process.env : {}),
    PATH: process.env.PATH ?? '',
    HOME: isolatedDataDir,
    USERPROFILE: isolatedDataDir,
    NODE_ENV: 'test',
    CODE_AGENT_DATA_DIR: isolatedDataDir,
    CODE_AGENT_CLI_MODE: 'true',
    ...(mutation ? { LOOP_MUTATION: mutation } : {}),
  };
}

function startChild(args: string[]): ChildProcessByStdio<null, Readable, Readable> {
  const isolatedDataDir = args[1]!;
  return spawn(process.execPath, [tsxCli, childEntry, ...args], {
    cwd: root,
    env: childEnv(isolatedDataDir),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
}

async function waitForMarker(
  child: ChildProcessByStdio<null, Readable, Readable>,
  expected: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for ${expected}; stderr=${stderr}`));
    }, 30_000);
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

async function forceKill(
  child: ChildProcessByStdio<null, Readable, Readable>,
  scriptPid?: number,
): Promise<void> {
  const pids = [child.pid, scriptPid].filter((pid, index, all): pid is number => {
    return typeof pid === 'number' && all.indexOf(pid) === index;
  });
  if (process.platform === 'win32') {
    for (const pid of pids) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    }
    if (!isChildGone(child)) child.kill('SIGKILL');
  } else {
    for (const pid of pids) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader or already gone */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (!isChildGone(child)) child.kill('SIGKILL');
  }
  await Promise.race([
    waitForExit(child),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`forceKill: pid ${child.pid} 在 15s 内未退出`)), 15_000)),
  ]);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && pids.some(isPidAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const alive = pids.filter(isPidAlive);
  if (alive.length > 0) {
    throw new Error(`forceKill: still alive after SIGKILL: ${alive.join(',')}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcessByStdio<null, Readable, Readable>): Promise<number | null> {
  if (isChildGone(child)) return child.exitCode;
  return new Promise((resolve) => child.once('exit', resolve));
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
