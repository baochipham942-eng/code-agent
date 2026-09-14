import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DurableEngineRecoveryHandler } from '../../../src/host/runtime/durableRecoveryDispatcher';
import { LOOP_DONE_MARKER } from '../../../src/shared/contract/loop';

const [phase, dataDir, scenarioArg] = process.argv.slice(2);
const mutation = process.env.LOOP_MUTATION ?? '';
if (!phase || !dataDir) {
  throw new Error('usage: loopDurableProcessHost <prepare|recover|claim> <data-dir> [sleeping|dispatching]');
}

await mkdir(dataDir, { recursive: true });

const { default: Database } = await import('better-sqlite3');
const { applyDurableRunMigrationDraft } = await import(
  '../../../src/host/services/core/database/migrations/durableRun'
);
const { DurableRunRepository } = await import(
  '../../../src/host/services/core/repositories/DurableRunRepository'
);

const dbPath = path.join(dataDir, 'durable-run.sqlite');
const identityPath = path.join(dataDir, 'identity.json');
const sendCountPath = path.join(dataDir, 'send-count.txt');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
applyDurableRunMigrationDraft(db);
const repository = new DurableRunRepository(db);

interface Identity {
  loopId: string;
  sessionId: string;
  parentRunId: string;
  scenario: 'sleeping' | 'dispatching';
  phase: 'dispatching' | 'awaiting_reply' | 'sleeping';
  turn: number;
  nextRunAt?: number;
  startedAt: number;
  oldProcessInstanceId: string;
}

const SESSION_ID = 'session-loop-durable';
const PARENT_RUN_ID = 'run-parent-loop';
const PREPARE_LEASE_MS = 400;
const SLEEP_INTERVAL_MS = 3_000;

if (phase === 'prepare') await prepareAndWait();
else if (phase === 'recover') await recoverAndExit();
else if (phase === 'claim') await claimAndExit();
else throw new Error(`unknown phase: ${phase}`);

async function prepareAndWait(): Promise<never> {
  const scenario = scenarioArg === 'dispatching' ? 'dispatching' : 'sleeping';
  const { DurableRunKernel } = await import('../../../src/host/runtime/durableRunKernel');
  const {
    LoopDurableLedger,
    armLoopDurableLedger,
    configureLoopDurableLedger,
  } = await import('../../../src/host/loop/loopDurableLedger');
  const { LoopController } = await import('../../../src/host/loop/loopController');
  const { getApplicationRunRegistry } = await import('../../../src/host/app/applicationRunRegistry');

  const startedAt = Date.now();
  const oldProcessInstanceId = `old-process-${process.pid}`;
  const kernel = new DurableRunKernel({
    stores: repository,
    ownerId: 'old-owner',
    processInstanceId: oldProcessInstanceId,
    leaseDurationMs: PREPARE_LEASE_MS,
  });
  const ledger = new LoopDurableLedger(kernel);
  armLoopDurableLedger();
  configureLoopDurableLedger(ledger);
  getApplicationRunRegistry().start({
    runId: PARENT_RUN_ID,
    sessionId: SESSION_ID,
    workspace: dataDir,
    cwd: dataDir,
  });

  const hangDispatch = scenario === 'dispatching';
  const controller = new LoopController({
    getOrchestrator: () => ({
      sendMessage: async () => {
        await bumpSendCount();
        if (hangDispatch) await new Promise<never>(() => undefined);
      },
    }),
    readSession: async () => ({
      messages: [{ role: 'assistant', content: '还在跑' }],
    }),
  });

  const state = await controller.start({
    sessionId: SESSION_ID,
    prompt: '盯构建',
    maxTurns: 5,
    intervalMs: hangDispatch ? 1_000 : SLEEP_INTERVAL_MS,
  });

  await waitUntil(() => {
    const live = controller.get(state.id);
    if (!live) return false;
    if (hangDispatch) return live.phase === 'dispatching' || live.turn >= 1;
    return live.phase === 'sleeping' && live.turn >= 1 && live.nextRunAt != null;
  }, hangDispatch ? 5_000 : 8_000);

  const live = controller.get(state.id);
  if (!live) throw new Error('prepare: loop vanished before ready');
  const identity: Identity = {
    loopId: live.id,
    sessionId: SESSION_ID,
    parentRunId: PARENT_RUN_ID,
    scenario,
    phase: live.phase ?? 'sleeping',
    turn: live.turn,
    ...(live.nextRunAt !== undefined ? { nextRunAt: live.nextRunAt } : {}),
    startedAt,
    oldProcessInstanceId,
  };
  await writeFile(identityPath, `${JSON.stringify(identity)}\n`);

  const heartbeatRenewed = await waitForHeartbeatRenewal(identity.loopId);
  marker({
    marker: 'ready',
    pid: process.pid,
    runId: identity.loopId,
    oldProcessInstanceId,
    heartbeatRenewed,
    scenario,
    phase: identity.phase,
    turn: identity.turn,
    sendCount: await readSendCount(),
  });
  await new Promise<never>(() => setInterval(() => undefined, 1_000));
  throw new Error('unreachable');
}

async function recoverAndExit(): Promise<void> {
  const identity = await loadIdentity();
  const leaseBefore = await waitUntilLeaseExpired(identity.loopId);
  const [{ initializeDurableRun }, { RunRegistry }] = await Promise.all([
    import('../../../src/host/app/initializeDurableRun'),
    import('../../../src/host/runtime/runRegistry'),
  ]);
  const { createLoopRecoveryHandler } = await import('../../../src/host/loop/loopRecoveryHandler');
  const { LoopController } = await import('../../../src/host/loop/loopController');
  const { LOOP_INTERRUPTED_REASON } = await import('../../../src/host/loop/loopDurableLedger');

  const registry = new RunRegistry();
  let handlerRecoverCalls = 0;
  const sendPrompts: string[] = [];
  const controller = new LoopController({
    getOrchestrator: () => ({
      sendMessage: async (prompt: string) => {
        sendPrompts.push(prompt);
        await bumpSendCount();
      },
    }),
    readSession: async () => ({
      messages: [{ role: 'assistant', content: `好了\n${LOOP_DONE_MARKER}` }],
    }),
  });

  const production = createLoopRecoveryHandler({
    registry,
    controller,
    sessionExists: () => true,
  });
  const probe: DurableEngineRecoveryHandler = {
    name: production.name,
    engineKind: production.engineKind,
    async recover(plan, now) {
      handlerRecoverCalls += 1;
      if (mutation === 'omit-adopt') {
        return { status: 'recovered', reason: 'mutated: adopt omitted' };
      }
      return production.recover(plan, now);
    },
  };

  const runtime = await initializeDurableRun({
    registry,
    repository,
    dataDir,
    ownerId: 'new-owner',
    processInstanceId: `new-process-${process.pid}`,
    env: { CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' },
    leaseDurationMs: 2_000,
    now: Date.now(),
    getMcpClient: () => {
      throw new Error('loop recovery must not query MCP');
    },
    trustedMcpServerIdentities: new Set(),
    recoveryHandlerOverrides: { loop: probe },
  });

  const terminalWaitMs = identity.scenario === 'sleeping' ? 12_000 : 8_000;
  await waitUntil(async () => {
    const envelope = await repository.get(identity.loopId);
    return envelope != null && ['completed', 'failed', 'cancelled'].includes(envelope.status);
  }, terminalWaitMs).catch(() => undefined);

  const envelopeAfterRecover = await repository.get(identity.loopId);
  const leftoverNow = Date.now() + (envelopeAfterRecover?.terminal ? 120_000 : 0);
  const leftover = await registry.recoverDurable(leftoverNow);
  const envelope = await repository.get(identity.loopId);
  const attempts = listAttempts(identity.loopId);
  const engineResult = runtime.recoveryResults.find((result) => result.phase === 'engine');
  const live = controller.get(identity.loopId);

  marker({
    marker: 'result',
    pid: process.pid,
    runId: identity.loopId,
    claimed: engineResult?.status === 'recovered' || engineResult?.status === 'duplicate',
    handler: engineResult?.handler ?? null,
    handlerRecoverCalls,
    recoveryReason: engineResult?.reason ?? null,
    extraMetaTurnExpected: Boolean(
      (engineResult?.detail as { extraMetaTurnExpected?: boolean } | undefined)?.extraMetaTurnExpected,
    ),
    envelopeStatus: envelope?.status ?? null,
    terminalReason: envelope?.terminal?.reason ?? null,
    interruptedReason: LOOP_INTERRUPTED_REASON,
    ownerEpoch: envelope?.owner?.epoch ?? null,
    oldProcessInstanceId: identity.oldProcessInstanceId,
    newProcessInstanceId: envelope?.owner?.processInstanceId ?? null,
    liveStatus: live?.status ?? null,
    liveTurn: live?.turn ?? null,
    liveStopReason: live?.stopReason ?? null,
    sendPrompts,
    sendCount: await readSendCount(),
    leftoverRecoverable: leftover.length,
    leaseRemainingMsBeforeRecover: leaseBefore.remainingMs,
    recoveryResults: runtime.recoveryResults,
    attempts,
    scenario: identity.scenario,
    preparePhase: identity.phase,
    prepareTurn: identity.turn,
    mutation: mutation || null,
  });
  await runtime.shutdown();
  db.close();
}

async function claimAndExit(): Promise<void> {
  const identity = await loadIdentity();
  const { DurableRunKernel } = await import('../../../src/host/runtime/durableRunKernel');
  const kernel = new DurableRunKernel({
    stores: repository,
    ownerId: `claim-owner-${process.pid}`,
    processInstanceId: `claim-process-${process.pid}`,
    leaseDurationMs: 2_000,
  });
  marker({ marker: 'armed', pid: process.pid, runId: identity.loopId });
  await waitForGo(dataDir);
  let plans: Awaited<ReturnType<typeof kernel.recoverOnStartup>> = [];
  let error: string | null = null;
  try {
    plans = await kernel.recoverOnStartup(Date.now());
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const claimed = plans.some((plan) => plan.envelope.runId === identity.loopId);
  const claimedPlan = plans.find((plan) => plan.envelope.runId === identity.loopId);
  marker({
    marker: 'result',
    pid: process.pid,
    runId: identity.loopId,
    claimed,
    ownerEpoch: claimedPlan?.envelope.owner?.epoch ?? null,
    processInstanceId: claimedPlan?.envelope.owner?.processInstanceId ?? `claim-process-${process.pid}`,
    recoverableCount: plans.length,
    error,
  });
  db.close();
}

async function waitForGo(dir: string): Promise<void> {
  const goPath = path.join(dir, 'go');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(goPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${goPath}`);
}

async function waitUntilLeaseExpired(runId: string): Promise<{ remainingMs: number; expired: boolean }> {
  const deadline = Date.now() + 5_000;
  let remainingMs = leaseRemainingMs(runId);
  while (remainingMs > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    remainingMs = leaseRemainingMs(runId);
  }
  if (remainingMs > 0) {
    throw new Error(`lease for ${runId} still has ${remainingMs}ms; preparer heartbeat is likely still running`);
  }
  return { remainingMs, expired: true };
}

async function waitForHeartbeatRenewal(runId: string): Promise<boolean> {
  const first = readLeaseExpiresAt(runId);
  if (first == null) return false;
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = readLeaseExpiresAt(runId);
    if (next != null && next > first) return true;
  }
  return false;
}

function readLeaseExpiresAt(runId: string): number | null {
  const row = db.prepare('SELECT lease_expires_at FROM durable_runs WHERE run_id = ?').get(runId) as
    | { lease_expires_at: number | null }
    | undefined;
  return row?.lease_expires_at == null ? null : Number(row.lease_expires_at);
}

function leaseRemainingMs(runId: string): number {
  const expiresAt = readLeaseExpiresAt(runId);
  if (expiresAt == null) return 0;
  return expiresAt - Date.now();
}

function listAttempts(runId: string): Array<{
  attempt: number;
  owner_epoch: number;
  process_instance_id: string;
  status: string;
}> {
  return db.prepare(
    'SELECT attempt, owner_epoch, process_instance_id, status FROM durable_run_attempts WHERE run_id = ? ORDER BY attempt',
  ).all(runId) as Array<{
    attempt: number;
    owner_epoch: number;
    process_instance_id: string;
    status: string;
  }>;
}

async function bumpSendCount(): Promise<number> {
  const next = (await readSendCount()) + 1;
  await writeFile(sendCountPath, `${next}\n`);
  return next;
}

async function readSendCount(): Promise<number> {
  try {
    return Number((await readFile(sendCountPath, 'utf8')).trim()) || 0;
  } catch {
    return 0;
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function loadIdentity(): Promise<Identity> {
  return JSON.parse(await readFile(identityPath, 'utf8')) as Identity;
}

function marker(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
