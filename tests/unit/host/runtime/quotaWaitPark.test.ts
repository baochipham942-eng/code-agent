import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { DurableRecoveryDispatcher } from '../../../../src/host/runtime/durableRecoveryDispatcher';
import { mapDurableRunView, projectDurableRunToSessionPayload } from '../../../../src/host/app/durableRunReadService';
import { continueParkedDurableRun } from '../../../../src/host/app/durableRunContinuation';
import { registerQuotaWaitContinuer, clearQuotaWaitTimer } from '../../../../src/host/runtime/quotaWaitTimer';

const SOURCE_ID = 'message-quota-wait';

function createRepository() {
  const db = new Database(':memory:');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  return { db, repository };
}

function kernel(repository: DurableRunRepository, processInstanceId: string) {
  return new DurableRunKernel({
    stores: repository,
    ownerId: 'native-host',
    processInstanceId,
    leaseDurationMs: 120_000,
  });
}

async function parkQuotaWait(registry: RunRegistry, input: { runId: string; sessionId: string; workspace: string; now: number; dueAt: number }) {
  const handle = await registry.startDurable({
    runId: input.runId,
    sessionId: input.sessionId,
    workspace: input.workspace,
    cwd: input.workspace,
  }, input.now);
  await registry.checkpointNativeModelOperation({
    runId: input.runId,
    sourceMessageId: SOURCE_ID,
    provider: 'provider',
    model: 'model',
    logicalOperationId: 'turn-quota',
    phase: 'after_model_dispatch',
    status: 'dispatched',
    now: input.now + 10,
  });
  await registry.parkDurable(input.runId, { now: input.now + 20, reason: 'quota_wait', dueAt: input.dueAt }, handle);
  registry.unregister(input.runId, handle);
  return handle;
}

describe('quota_wait park', () => {
  const registries: RunRegistry[] = [];
  let db: Database.Database | undefined;
  let workspace = '';

  afterEach(() => {
    registerQuotaWaitContinuer(null);
    clearQuotaWaitTimer('run-quota');
    for (const registry of registries) registry.clear();
    registries.length = 0;
    db?.close();
    db = undefined;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = '';
    vi.useRealTimers();
  });

  it('continues once from the due timer, and a retry-now claim leaves the timer with nothing to do', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T08:00:00.000Z'));
    const now = Date.now();
    const dueAt = now + 75_000;
    workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'quota-wait-live-')));
    const created = createRepository();
    db = created.db;
    const registry = new RunRegistry();
    registries.push(registry);
    registry.configureDurableKernel(kernel(created.repository, 'quota-live'));
    const resumes = vi.fn(async () => undefined);
    const taskManager = {
      getSessionState: () => ({ status: 'idle' as const }),
      resumeExistingDurableRun: resumes,
    };
    registerQuotaWaitContinuer(({ sessionId }) => continueParkedDurableRun({
      sessionId,
      runRegistry: registry,
      taskManager,
      getMessages: async () => [{ id: SOURCE_ID, role: 'user', content: 'go', timestamp: 1 } as never],
    }));
    await parkQuotaWait(registry, { runId: 'run-quota', sessionId: 'session-quota', workspace, now, dueAt });

    await vi.advanceTimersByTimeAsync(75_000);
    await vi.waitFor(() => expect(resumes).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(75_000);
    expect(resumes).toHaveBeenCalledTimes(1);

    registry.clear();
    created.db.close();
    db = undefined;
    const again = createRepository();
    db = again.db;
    const second = new RunRegistry();
    registries.push(second);
    second.configureDurableKernel(kernel(again.repository, 'quota-retry-now'));
    const secondResumes = vi.fn(async () => undefined);
    registerQuotaWaitContinuer(({ sessionId }) => continueParkedDurableRun({
      sessionId,
      runRegistry: second,
      taskManager: { getSessionState: () => ({ status: 'idle' as const }), resumeExistingDurableRun: secondResumes },
      getMessages: async () => [{ id: SOURCE_ID, role: 'user', content: 'go', timestamp: 1 } as never],
    }));
    vi.setSystemTime(new Date('2026-10-27T09:00:00.000Z'));
    const later = Date.now();
    await parkQuotaWait(second, { runId: 'run-quota', sessionId: 'session-quota', workspace, now: later, dueAt: later + 75_000 });
    await continueParkedDurableRun({
      sessionId: 'session-quota',
      runRegistry: second,
      taskManager: { getSessionState: () => ({ status: 'idle' as const }), resumeExistingDurableRun: secondResumes },
      getMessages: async () => [{ id: SOURCE_ID, role: 'user', content: 'go', timestamp: 1 } as never],
    });
    expect(secondResumes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(secondResumes).toHaveBeenCalledTimes(1);
  });

  it('cancel clears the due timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T08:00:00.000Z'));
    const now = Date.now();
    workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'quota-wait-cancel-')));
    const created = createRepository();
    db = created.db;
    const registry = new RunRegistry();
    registries.push(registry);
    registry.configureDurableKernel(kernel(created.repository, 'quota-cancel'));
    const continued = vi.fn(async () => undefined);
    registerQuotaWaitContinuer(continued);
    await parkQuotaWait(registry, { runId: 'run-quota', sessionId: 'session-quota', workspace, now, dueAt: now + 75_000 });
    await registry.terminalRecoveredWaitingRun({ sessionId: 'session-quota' }, now + 30);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(continued).not.toHaveBeenCalled();
  });

  it('restart reclaim does not arm a timer, and a passed due projects as due-passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T08:00:00.000Z'));
    const now = Date.now();
    const dueAt = now + 75_000;
    workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'quota-wait-restart-')));
    const created = createRepository();
    db = created.db;
    const registry = new RunRegistry();
    registries.push(registry);
    registry.configureDurableKernel(kernel(created.repository, 'quota-before-quit'));
    const continued = vi.fn(async () => undefined);
    registerQuotaWaitContinuer(continued);
    await parkQuotaWait(registry, { runId: 'run-quota', sessionId: 'session-quota', workspace, now, dueAt });
    clearQuotaWaitTimer('run-quota');
    registry.clear();
    continued.mockClear();

    const next = new RunRegistry();
    registries.push(next);
    next.configureDurableKernel(kernel(created.repository, 'quota-after-quit'));
    const plans = await next.recoverDurable(now + 120_001);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      envelope: { runId: 'run-quota', status: 'waiting', interruptCause: 'quota_wait', quotaWaitDueAt: dueAt },
      resumeBlocked: true,
    });
    const recover = vi.fn();
    const dispatcher = new DurableRecoveryDispatcher();
    dispatcher.registerEngineHandler({ name: 'native-spy', engineKind: 'native', serialAutoResume: true, recover });
    const results = await dispatcher.dispatch(plans, now + 120_001);
    expect(results.map((result) => result.status)).toEqual(['observing']);
    expect(recover).not.toHaveBeenCalled();
    await dispatcher.shutdown();

    const stored = await created.repository.get('run-quota');
    const before = projectDurableRunToSessionPayload(mapDurableRunView('session_replay', stored!));
    expect(before.durableResume?.quotaWait).toEqual({ dueAt, duePassed: false });

    await vi.advanceTimersByTimeAsync(80_000);
    expect(continued).not.toHaveBeenCalled();
    const after = projectDurableRunToSessionPayload(mapDurableRunView('session_replay', stored!));
    expect(after.durableResume?.quotaWait).toEqual({ dueAt, duePassed: true });
    expect(after.durableResume).toMatchObject({ mode: 'continue', interruptCause: 'quota_wait', canContinue: true });
  });
});
