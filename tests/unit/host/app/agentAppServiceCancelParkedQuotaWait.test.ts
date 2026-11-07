import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { AgentAppServiceImpl } from '../../../../src/host/app/agentAppService';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { clearQuotaWaitTimer, registerQuotaWaitContinuer } from '../../../../src/host/runtime/quotaWaitTimer';

const RUN_ID = 'run-quota-cancel';
const SESSION_ID = 'session-quota-cancel';
const SOURCE_ID = 'message-quota-cancel';

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

/** 卡片 Cancel 时的宿主现状：TaskManager idle、orchestrator loop 已结束（cancel 只发事件）。 */
function idleTaskManager(legacyOrchestratorCancel: ReturnType<typeof vi.fn>) {
  return {
    getSessionState: () => ({ status: 'idle' as const }),
    getOrCreateCurrentOrchestrator: () => ({ cancel: legacyOrchestratorCancel }),
  };
}

describe('agentAppService.cancel terminalizes a parked quota_wait run', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    registerQuotaWaitContinuer(null);
    clearQuotaWaitTimer(RUN_ID);
    while (cleanups.length > 0) cleanups.pop()?.();
    vi.useRealTimers();
  });

  it('cancel from the quota-wait card cancels the parked run and disarms the due timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T08:00:00.000Z'));
    const now = Date.now();
    const dueAt = now + 75_000;
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'quota-cancel-card-')));
    const { db, repository } = createRepository();
    const registry = new RunRegistry();
    registry.configureDurableKernel(kernel(repository, 'quota-cancel-card'));
    cleanups.push(() => {
      registry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    });

    // 与 finalizeOrParkDurableRun 的 quota_wait 停靠同款：checkpoint → park(reason/quota_wait) → 卸 handle。
    const handle = await registry.startDurable({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workspace,
      cwd: workspace,
    }, now);
    await registry.checkpointNativeModelOperation({
      runId: RUN_ID,
      sourceMessageId: SOURCE_ID,
      provider: 'provider',
      model: 'model',
      logicalOperationId: 'turn-quota-cancel',
      phase: 'after_model_dispatch',
      status: 'dispatched',
      now: now + 10,
    });
    await registry.parkDurable(RUN_ID, { now: now + 20, reason: 'quota_wait', dueAt }, handle);
    registry.unregister(RUN_ID, handle);

    const autoResume = vi.fn(async () => undefined);
    registerQuotaWaitContinuer(autoResume);

    const legacyOrchestratorCancel = vi.fn(async () => undefined);
    const appService = new AgentAppServiceImpl(
      () => idleTaskManager(legacyOrchestratorCancel) as never,
      () => null,
      () => SESSION_ID,
      vi.fn(),
      registry,
    );

    await appService.cancel(SESSION_ID);

    const parked = await repository.get(RUN_ID);
    expect(parked).toMatchObject({ status: 'cancelled' });
    expect(parked?.terminal).toMatchObject({ reason: 'recovered_waiting_run_cancelled' });
    expect(registry.findRecoveredWaitingRun({ sessionId: SESSION_ID })).toBeUndefined();
    expect(legacyOrchestratorCancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(90_000);
    expect(autoResume).not.toHaveBeenCalled();
  });
});
