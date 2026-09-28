import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isChildGone } from './childProcessState';
import { resolveMutationAcceptanceExitCode } from './mutationExitCode';
import { DURABLE_RUN_SCHEMA_VERSION } from '../../src/shared/contract/durableRun';
import { DURABLE_RUN_KILL_RESTART_SCENARIOS } from '../../tests/fixtures/durableRunKillRestart';

const BASELINE_SHA = '2548c7b1cc457485c06303cd6a6e7ba4a7092b8c';
const root = path.resolve(import.meta.dirname, '../..');
const childEntry = path.join(root, 'tests/e2e/fixtures/durableRunProcessHost.ts');
const rolloutEntry = path.join(root, 'tests/e2e/fixtures/durableRunRolloutProcess.ts');
// 不走 node_modules/.bin/tsx：Windows 上无扩展名的 .bin shim 是 POSIX 脚本，
// CreateProcess 直接 ENOENT；改用 process.execPath + tsx 真实入口，两平台同一条路。
const tsxCli = path.join(root, 'node_modules/tsx/dist/cli.mjs');
const tsxPreflight = path.join(root, 'node_modules/tsx/dist/preflight.cjs');
const tsxLoader = path.join(root, 'node_modules/tsx/dist/loader.mjs');
const outputArg = process.argv.indexOf('--out');
const outputPath = path.resolve(root, outputArg >= 0 && process.argv[outputArg + 1]
  ? process.argv[outputArg + 1]!
  : 'test-results/durable-run-s9-acceptance.json');
const onlyArg = process.argv.indexOf('--only');
const onlyGroup = onlyArg >= 0 ? process.argv[onlyArg + 1] : undefined;
if (onlyGroup && onlyGroup !== 'adr075') {
  throw new Error(`unknown --only ${onlyGroup}; expected adr075`);
}
const mutateArg = process.argv.indexOf('--mutate');
const mutation = mutateArg >= 0 ? process.argv[mutateArg + 1] : undefined;
if (mutation && mutation !== 'regenerate' && mutation !== 'descriptor-only' && mutation !== 'replay-bash') {
  throw new Error(`unknown --mutate ${mutation}; expected regenerate | descriptor-only | replay-bash`);
}

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
  runId?: string;
  sameRunId?: boolean;
  loopAttached?: boolean;
  autoResumeCount?: number;
  startTaskCount?: number;
  resumeCount?: number;
  bashExecutions?: number;
  toolMessageCount?: number;
  honestPartialKept?: boolean;
  usageUnknown?: boolean;
  finalStatus?: string;
  finalAnswer?: string | null;
  mutation?: string | null;
  interruptCause?: string | null;
}

const startedAt = Date.now();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'code-agent-s9-'));
const results: ScenarioResult[] = [];
let finalExitCode: number;
const selectedScenarios = DURABLE_RUN_KILL_RESTART_SCENARIOS.filter((scenario) => {
  if (mutation === 'regenerate') return scenario.id === 'adr075-model-streaming';
  if (mutation === 'descriptor-only') return scenario.id === 'adr075-parallel-readonly';
  if (mutation === 'replay-bash') return scenario.id === 'adr075-bash-executing';
  if (onlyGroup === 'adr075') return scenario.liveLoop === true;
  return true;
});
try {
  for (const scenario of selectedScenarios) {
    const scenarioDir = path.join(tempRoot, scenario.id);
    await mkdir(scenarioDir, { recursive: true });
    if (scenario.repeatedCrash) {
      results.push(await runRepeatedCrash(scenario.id, scenarioDir));
      continue;
    }
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

  const skipRoundTrips = Boolean(mutation) || onlyGroup === 'adr075';
  const rollbackRoundTrip = skipRoundTrips
    ? { pass: true, skipped: true }
    : await runRollbackRoundTrip(path.join(tempRoot, 'rollout-roundtrip'));
  const readPreferenceRoundTrip = skipRoundTrips
    ? { pass: true, skipped: true }
    : await runReadPreferenceRoundTrip(path.join(tempRoot, 'read-preference'));
  const reverseMutations = mutation || onlyGroup === 'adr075'
    ? []
    : await runReverseMutations(tempRoot);
  const testedSha = git(['rev-parse', 'HEAD']);
  const liveLoopResults = results.filter((result) => result.scenarioId.startsWith('adr075-'));
  const completedLoopResults = liveLoopResults.filter((result) => result.scenarioId !== 'adr075-repeated-crash');
  const repeatedCrash = results.find((result) => result.scenarioId === 'adr075-repeated-crash');
  const report = {
    schemaVersion: 1,
    baselineSha: BASELINE_SHA,
    testedSha,
    mutation: mutation ?? null,
    only: onlyGroup ?? null,
    platform: { platform: process.platform, arch: process.arch, release: os.release() },
    nodeVersion: process.version,
    databaseSchemaVersion: DURABLE_RUN_SCHEMA_VERSION,
    rolloutMode: 'durable_preferred',
    killSwitch: 'CODE_AGENT_DURABLE_RUN_MODE=legacy',
    scenarios: results,
    rollbackRoundTrip,
    readPreferenceRoundTrip,
    reverseMutations,
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
      productionReadPreferenceWiring: readPreferenceRoundTrip.pass,
      sameRunIdResumed: liveLoopResults.every((result) => result.sameRunId === true),
      liveLoopCompleted: completedLoopResults.every((result) => result.finalStatus === 'completed' && result.terminalCount === 1),
      autoResumeCounted: completedLoopResults.every((result) => result.autoResumeCount === 1),
      repeatedCrashParked: !repeatedCrash || (
        repeatedCrash.finalStatus === 'waiting'
        && repeatedCrash.autoResumeCount === 2
        && repeatedCrash.interruptCause === 'crash_or_quit'
        && repeatedCrash.sameRunId === true
        && (repeatedCrash.startTaskCount ?? 0) === 0
        && repeatedCrash.terminalCount === 0
      ),
      noRegenerateStartTask: results.every((result) => (result.startTaskCount ?? 0) === 0),
      reverseMutationsCaught: reverseMutations.every((entry) => entry.caught),
    },
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
  const pass = Object.values(report.gates).every(Boolean);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ ...report, pass }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ pass, report: outputPath, testedSha, scenarios: results.length, mutation: mutation ?? null, gates: report.gates })}\n`);
  if (mutation && pass) {
    process.stderr.write(`mutation ${mutation} not caught: gates stayed green — 变异未被抓到,验收无效\n`);
  }
  finalExitCode = resolveMutationAcceptanceExitCode(pass, mutation);
} finally {
  // Windows 上 Defender/索引器短暂持锁会让 rm 偶发 EPERM/EBUSY，带重试兜掉这类 CI flake
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
process.exit(finalExitCode);

// POSIX 侧保持最小白名单隔离；Windows 子进程缺 SystemRoot/ComSpec/PATHEXT 会随机炸
// （DNS 解析、二级 spawn），win32 下以完整 env 打底再覆盖隔离键。HOME 只对 POSIX 生效，
// Windows 的 os.homedir() 读 USERPROFILE，两个都设才真隔离。
function childEnv(isolatedDataDir: string): NodeJS.ProcessEnv {
  return {
    ...(process.platform === 'win32' ? process.env : {}),
    PATH: process.env.PATH ?? '', HOME: isolatedDataDir, USERPROFILE: isolatedDataDir,
    NODE_ENV: 'test', CODE_AGENT_DATA_DIR: isolatedDataDir, CODE_AGENT_CLI_MODE: 'true',
    ...(mutation ? { CODE_AGENT_ADR075_MUTATE: mutation } : {}),
  };
}

function runReverseMutations(tempRoot: string): Array<{
  mutation: string;
  caught: boolean;
  exitCode: number | null;
  summary: string;
}> {
  const script = path.join(root, 'scripts/acceptance/durable-run-kill-restart.ts');
  return (['regenerate', 'descriptor-only', 'replay-bash'] as const).map((name) => {
    const out = path.join(tempRoot, `mutate-${name}.json`);
    const result = spawnSync(process.execPath, [tsxCli, script, '--mutate', name, '--out', out], {
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
    });
    const lines = `${result.stdout}\n${result.stderr}`.split('\n').map((line) => line.trim()).filter(Boolean);
    const summary = lines.find((line) => line.startsWith('{')) ?? lines.at(-1) ?? '';
    return { mutation: name, caught: result.status === 0, exitCode: result.status, summary: summary.slice(0, 800) };
  });
}

async function runRepeatedCrash(scenarioId: string, scenarioDir: string): Promise<ScenarioResult> {
  const preparer = startChild(['prepare', scenarioId, scenarioDir]);
  await waitForMarker(preparer, 'ready');
  await forceKill(preparer);
  await new Promise((resolve) => setTimeout(resolve, 900));
  for (let restart = 0; restart < 2; restart += 1) {
    const recoverer = startChild(['recover', scenarioId, scenarioDir]);
    await waitForMarker(recoverer, 'resumed');
    await forceKill(recoverer);
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  const parked = startChild(['recover', scenarioId, scenarioDir]);
  const result = await waitForMarker(parked, 'result') as unknown as ScenarioResult;
  const exitCode = await waitForExit(parked);
  if (exitCode !== 0) throw new Error(`${scenarioId} parked recovery child exited ${exitCode}`);
  return result;
}

function startChild(args: string[]): ChildProcessByStdio<null, Readable, Readable> {
  const isolatedDataDir = args.at(-1)!;
  // Spawn the host in this process (tsx loader), not tsx/cli.mjs: the CLI
  // re-execs a grandchild, so SIGKILL on the wrapper left the prepare loop alive.
  return spawn(process.execPath, ['--require', tsxPreflight, '--import', tsxLoader, childEntry, ...args], {
    cwd: root,
    env: childEnv(isolatedDataDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForMarker(child: ChildProcessByStdio<null, Readable, Readable>, expected: string): Promise<Record<string, unknown>> {
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

async function forceKill(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    // taskkill 偶发失败（返回码非 0）时补一刀，否则下面的 waitForExit 会永久挂
    if (killed.status !== 0 && !isChildGone(child)) child.kill('SIGKILL');
  } else {
    child.kill('SIGKILL');
  }
  await Promise.race([
    waitForExit(child),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`forceKill: pid ${child.pid} 在 15s 内未退出`)), 15_000)),
  ]);
}

async function waitForExit(child: ChildProcessByStdio<null, Readable, Readable>): Promise<number | null> {
  if (isChildGone(child)) return child.exitCode;
  return new Promise((resolve) => child.once('exit', resolve));
}

async function runRollbackRoundTrip(dataDir: string): Promise<Record<string, unknown> & { pass: boolean }> {
  await mkdir(dataDir, { recursive: true });
  const phases = ['durable_preferred:create', 'legacy:verify', 'durable_preferred:restore'];
  const outputs = phases.map((phase) => {
    const result = spawnSync(process.execPath, [tsxCli, rolloutEntry, phase, dataDir], {
      cwd: root,
      env: childEnv(dataDir),
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`rollback ${phase} failed: ${result.stderr}`);
    const jsonLine = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{')).at(-1);
    if (!jsonLine) throw new Error(`rollback ${phase} produced no JSON result`);
    return JSON.parse(jsonLine) as { phase: string; mode: string; rowCount: number; tableCount: number; pass: boolean };
  });
  return { pass: outputs.every((output) => output.pass), phases: outputs };
}

async function runReadPreferenceRoundTrip(dataDir: string): Promise<Record<string, unknown> & { pass: boolean }> {
  await mkdir(dataDir, { recursive: true });
  process.env.HOME = dataDir;
  process.env.USERPROFILE = dataDir; // Windows 的 os.homedir() 读这个，不读 HOME
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_CLI_MODE = 'true';
  const [{ default: Database }, { applyDurableRunMigrationDraft }, { DurableRunRepository },
    { DurableRunKernel }, { RunRegistry }, { initializeDurableRun },
    { DurableRunReadService }, { resolveDurableRunRollout }] = await Promise.all([
    import('better-sqlite3'),
    import('../../src/host/services/core/database/migrations/durableRun'),
    import('../../src/host/services/core/repositories/DurableRunRepository'),
    import('../../src/host/runtime/durableRunKernel'),
    import('../../src/host/runtime/runRegistry'),
    import('../../src/host/app/initializeDurableRun'),
    import('../../src/host/app/durableRunReadService'),
    import('../../src/host/app/durableRunRollout'),
  ]);
  const db = new Database(path.join(dataDir, 'read-preference.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyDurableRunMigrationDraft(db);
  const repository = new DurableRunRepository(db);
  const kernel = new DurableRunKernel({
    stores: repository,
    ownerId: 'read-fixture-owner',
    processInstanceId: 'read-fixture-process',
    leaseDurationMs: 1_000,
  });
  const now = Date.now();
  const created = await kernel.createNativeRun({ runId: 'read-run', sessionId: 'read-session', now });
  await kernel.terminal({
    runId: 'read-run', attempt: 1, owner: created.owner, now: now + 1,
    status: 'completed', reason: 'read_fixture',
    event: { type: 'run_completed', payload: null, recordedAt: now + 1 },
  });

  const start = (mode: 'legacy' | 'dual_write' | 'durable_preferred', surface: string) => initializeDurableRun({
    registry: new RunRegistry(),
    repository: mode === 'legacy' ? null : repository,
    dataDir,
    ownerId: `${surface}-owner`,
    processInstanceId: `${surface}-process`,
    env: { CODE_AGENT_DURABLE_RUN_MODE: mode },
    now: now + 2,
  });
  const web = await start('durable_preferred', 'web');
  const tauri = await start('durable_preferred', 'tauri');
  const legacyProjection = () => ({ runId: 'legacy-stale', status: 'running' as const, engine: { kind: 'native' as const } });
  const consumers = [
    web.readService.readNativeStatus('read-session', legacyProjection),
    web.readService.readNativeControl('read-session', legacyProjection),
    web.readService.readAgentTeamOrAutoAgent('read-session', legacyProjection),
    web.readService.readDynamicWorkflow('read-session', legacyProjection),
    web.readService.readExternalEngine('read-session', legacyProjection),
    web.readService.readSessionReplay('read-session', legacyProjection),
  ];
  const durableViews = await Promise.all(consumers);
  const tauriView = await tauri.readService.readSessionReplay('read-session', legacyProjection);
  const dual = await start('dual_write', 'dual');
  const dualView = await dual.readService.readNativeStatus('read-session', legacyProjection);
  const legacy = await start('legacy', 'legacy');
  const legacyView = await legacy.readService.readNativeStatus('read-session', legacyProjection);
  const missingView = await web.readService.readNativeStatus('historical-session', () => ({
    runId: 'historical-legacy', status: 'idle', engine: { kind: 'native' }, terminal: true,
  }));
  let repositoryErrorPropagated = false;
  const failing = new DurableRunReadService(
    resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' }),
    { getLatestBySession: async () => { throw new Error('injected repository failure'); } },
  );
  try {
    await failing.readNativeStatus('read-session', legacyProjection);
  } catch (error) {
    repositoryErrorPropagated = error instanceof Error && error.message === 'injected repository failure';
  }
  const checks = {
    allConsumersDurable: durableViews.every((view) => view.source === 'durable' && view.status === 'completed' && view.terminal),
    dualWriteUsesLegacy: dualView.source === 'legacy' && dualView.status === 'running',
    legacyDoesNotActivate: legacy.kernel === null && legacy.recoveryRuntime === null && legacyView.source === 'legacy',
    repositoryErrorPropagated,
    missingRowFallsBack: missingView.source === 'legacy' && missingView.runId === 'historical-legacy',
    webTauriConsistent: tauriView.source === durableViews[5]!.source && tauriView.status === durableViews[5]!.status,
  };
  await Promise.all([web.shutdown(), tauri.shutdown(), dual.shutdown(), legacy.shutdown()]);
  db.close();
  return { pass: Object.values(checks).every(Boolean), checks };
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
