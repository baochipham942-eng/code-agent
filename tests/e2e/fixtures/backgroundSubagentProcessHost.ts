import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DurableEngineRecoveryHandler } from '../../../src/host/runtime/durableRecoveryDispatcher';

const [phase, dataDir] = process.argv.slice(2);
const mutation = process.env.BGSPAWN_MUTATION ?? '';
if (!phase || !dataDir) {
  throw new Error('usage: backgroundSubagentProcessHost <prepare|recover|claim> <data-dir>');
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
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
applyDurableRunMigrationDraft(db);
const repository = new DurableRunRepository(db);

interface Identity {
  agentId: string;
  sessionId: string;
  parentRunId: string;
  title: string;
  role: string;
  treeId: string;
  startedAt: number;
  oldProcessInstanceId: string;
}

const DEFAULT_IDENTITY = {
  agentId: 'subagent-bg-kill-restart',
  sessionId: 'session-bgspawn-durable',
  parentRunId: 'run-parent-bgspawn',
  title: 'kill-restart background research',
  role: 'explore',
  treeId: 'tree-bgspawn',
} as const;

const PREPARE_LEASE_MS = 400;

if (phase === 'prepare') await prepareAndWait();
else if (phase === 'recover') await recoverAndExit();
else if (phase === 'claim') await claimAndExit();
else throw new Error(`unknown phase: ${phase}`);

async function prepareAndWait(): Promise<never> {
  const { DurableRunKernel } = await import('../../../src/host/runtime/durableRunKernel');
  const { BackgroundSubagentDurableLedger } = await import(
    '../../../src/host/agent/backgroundSubagentDurableLedger'
  );

  const startedAt = Date.now();
  const oldProcessInstanceId = `old-process-${process.pid}`;
  const identity: Identity = {
    ...DEFAULT_IDENTITY,
    startedAt,
    oldProcessInstanceId,
  };
  await writeFile(identityPath, `${JSON.stringify(identity)}\n`);

  if (mutation !== 'skip-begin') {
    const kernel = new DurableRunKernel({
      stores: repository,
      ownerId: 'old-owner',
      processInstanceId: oldProcessInstanceId,
      leaseDurationMs: PREPARE_LEASE_MS,
    });
    const ledger = new BackgroundSubagentDurableLedger(kernel);
    await ledger.begin({
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      parentRunId: identity.parentRunId,
      title: identity.title,
      role: identity.role,
      treeId: identity.treeId,
      startedAt: identity.startedAt,
    });
  }

  const heartbeatRenewed = mutation === 'skip-begin' ? false : await waitForHeartbeatRenewal(identity.agentId);
  marker({
    marker: 'ready',
    pid: process.pid,
    runId: identity.agentId,
    oldProcessInstanceId,
    heartbeatRenewed,
    skippedBegin: mutation === 'skip-begin',
  });
  await new Promise<never>(() => setInterval(() => undefined, 1_000));
  throw new Error('unreachable');
}

async function recoverAndExit(): Promise<void> {
  const identity = await loadIdentity();
  const leaseBefore = await waitUntilLeaseExpired(identity.agentId);
  const [{ initializeDurableRun }, { RunRegistry }, { getBackgroundSubagentRegistry }] = await Promise.all([
    import('../../../src/host/app/initializeDurableRun'),
    import('../../../src/host/runtime/runRegistry'),
    import('../../../src/host/agent/backgroundSubagentRegistry'),
  ]);
  const { createBackgroundSubagentRecoveryHandler } = await import(
    '../../../src/host/runtime/durableRecoveryHandlers'
  );
  const { BACKGROUND_SUBAGENT_INTERRUPTED_REASON } = await import(
    '../../../src/host/agent/backgroundSubagentDurableLedger'
  );

  const registry = new RunRegistry();
  let handlerRecoverCalls = 0;
  let projectedRecords: Array<Record<string, unknown>> = [];

  const production = createBackgroundSubagentRecoveryHandler({ registry });
  const probe: DurableEngineRecoveryHandler = {
    name: production.name,
    engineKind: production.engineKind,
    async recover(plan, now) {
      handlerRecoverCalls += 1;
      const outcome = await production.recover(plan, now);
      projectedRecords = getBackgroundSubagentRegistry()
        .drainCompletionNotifications({ sessionId: plan.envelope.sessionId })
        .map((record) => ({
          agentId: record.agentId,
          status: record.status,
          title: record.title,
          role: record.role,
          runId: record.runId,
          treeId: record.treeId,
          failureCode: record.failureCode,
          content: record.content,
        }));
      return outcome;
    },
  };
  const omitted: DurableEngineRecoveryHandler = {
    name: 'mutated_omit_handler',
    engineKind: 'subagent_single',
    async recover() {
      handlerRecoverCalls += 1;
      return { status: 'unsupported', reason: 'mutated: background subagent handler omitted' };
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
      throw new Error('background subagent recovery must not query MCP');
    },
    trustedMcpServerIdentities: new Set(),
    recoveryHandlerOverrides: {
      backgroundSubagent: mutation === 'omit-handler' ? omitted : probe,
    },
  });

  const envelopeAfterRecover = await repository.get(identity.agentId);
  const leftoverNow = Date.now() + (envelopeAfterRecover?.terminal ? 120_000 : 0);
  const leftover = await registry.recoverDurable(leftoverNow);
  const leftoverAfterDrain = getBackgroundSubagentRegistry()
    .drainCompletionNotifications({ sessionId: identity.sessionId });
  const envelope = await repository.get(identity.agentId);
  const attempts = listAttempts(identity.agentId);
  const engineResult = runtime.recoveryResults.find((result) => result.phase === 'engine');

  marker({
    marker: 'result',
    pid: process.pid,
    runId: identity.agentId,
    claimed: engineResult?.status === 'recovered',
    handler: engineResult?.handler ?? null,
    handlerRecoverCalls,
    recoveryReason: engineResult?.reason ?? null,
    envelopeStatus: envelope?.status ?? null,
    terminalReason: envelope?.terminal?.reason ?? null,
    interruptedReason: BACKGROUND_SUBAGENT_INTERRUPTED_REASON,
    ownerEpoch: envelope?.owner?.epoch ?? null,
    oldProcessInstanceId: identity.oldProcessInstanceId,
    newProcessInstanceId: envelope?.owner?.processInstanceId ?? null,
    projectedRecords,
    leftoverRecoverable: leftover.length,
    secondDrainCount: leftoverAfterDrain.length,
    leaseRemainingMsBeforeRecover: leaseBefore.remainingMs,
    recoveryResults: runtime.recoveryResults,
    attempts,
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
  marker({ marker: 'armed', pid: process.pid, runId: identity.agentId });
  await waitForGo(dataDir);
  let plans: Awaited<ReturnType<typeof kernel.recoverOnStartup>> = [];
  let error: string | null = null;
  try {
    plans = await kernel.recoverOnStartup(Date.now());
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const claimed = plans.some((plan) => plan.envelope.runId === identity.agentId);
  const claimedPlan = plans.find((plan) => plan.envelope.runId === identity.agentId);
  marker({
    marker: 'result',
    pid: process.pid,
    runId: identity.agentId,
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

function leaseRemainingMs(runId: string): number {
  const expiresAt = readLeaseExpiresAt(runId);
  if (expiresAt == null) return 0;
  return expiresAt - Date.now();
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

async function loadIdentity(): Promise<Identity> {
  return JSON.parse(await readFile(identityPath, 'utf8')) as Identity;
}

function marker(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
