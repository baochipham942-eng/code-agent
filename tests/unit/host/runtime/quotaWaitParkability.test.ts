import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { isQuotaWaitParkableRun } from '../../../../src/host/runtime/quotaWaitParkability';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { getApplicationRunRegistry, resetApplicationRunRegistryForTests } from '../../../../src/host/app/applicationRunRegistry';
import { withNativeModelOperation } from '../../../../src/host/agent/runtime/contextAssembly/nativeModelCheckpoint';
import { settleQuotaWaitInference, clearQuotaWaitNote } from '../../../../src/host/agent/runtime/contextAssembly/quotaWaitTurn';
import { isQuotaWaitSuspendEligible, QuotaWaitSuspendError } from '../../../../src/host/model/providers/quotaWaitSuspend';
import type { ContextAssemblyCtx } from '../../../../src/host/agent/runtime/contextAssembly/shared';
import type { ModelConfig } from '../../../../src/shared/contract/model';

const CONFIG = { provider: 'provider', model: 'model' } as ModelConfig;

function makeCtx(runId: string): ContextAssemblyCtx {
  return {
    runtime: {
      runId,
      sessionId: 'session-quota-elig',
      messages: [{ id: 'msg-elig', role: 'user', content: 'go', timestamp: 1 }],
      turn: { currentTurnId: 'turn-elig' },
      goalMode: null,
    },
  } as unknown as ContextAssemblyCtx;
}

/** The eligibility flag the model layer sees inside withNativeModelOperation's run(). */
async function eligibilityInsideModelCall(registry: RunRegistry, runId: string): Promise<boolean> {
  return withNativeModelOperation(makeCtx(runId), CONFIG, new AbortController().signal, async () => {
    registry.hasDurableOwner(runId); // touch the registry the same way production setup would
    return isQuotaWaitSuspendEligible();
  });
}

describe('quota wait parkability gate (rework r1)', () => {
  let db: Database.Database | undefined;
  let workspace = '';

  afterEach(() => {
    resetApplicationRunRegistryForTests();
    db?.close();
    db = undefined;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = '';
  });

  function setup(): RunRegistry {
    db = new Database(':memory:');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    const registry = getApplicationRunRegistry();
    registry.clear();
    registry.configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'elig-host',
      processInstanceId: 'elig-process',
      leaseDurationMs: 60_000,
    }));
    return registry;
  }

  it('marks a parkable primary durable run suspend-eligible and settles its quota wait', async () => {
    const registry = setup();
    workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'quota-elig-primary-')));
    const handle = await registry.startDurable({
      runId: 'run-elig-primary',
      sessionId: 'session-quota-elig',
      workspace,
      cwd: workspace,
    }, 100);
    await registry.checkpointNativeModelOperation({
      runId: 'run-elig-primary',
      sourceMessageId: 'msg-elig',
      provider: 'provider',
      model: 'model',
      logicalOperationId: 'turn-elig',
      phase: 'after_model_dispatch',
      status: 'dispatched',
      now: 110,
    });
    expect(isQuotaWaitParkableRun(registry, 'run-elig-primary')).toBe(true);
    await expect(eligibilityInsideModelCall(registry, 'run-elig-primary')).resolves.toBe(true);

    const markCancelled = vi.fn();
    const settled = settleQuotaWaitInference(new QuotaWaitSuspendError(185_000, 75_000), {
      runId: 'run-elig-primary',
      markCancelled,
    });
    expect(settled).toBe(true);
    expect(markCancelled).toHaveBeenCalledTimes(1);
    clearQuotaWaitNote('run-elig-primary');
    registry.unregister('run-elig-primary', handle);
  });

  it('keeps an auxiliary durable child on the legacy path: no eligibility, settle refuses to cancel', async () => {
    const registry = setup();
    workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'quota-elig-aux-')));
    const parent = await registry.startDurable({
      runId: 'run-elig-parent',
      sessionId: 'session-quota-elig',
      workspace,
      cwd: workspace,
    }, 100);
    const child = await registry.startAuxiliaryDurableChild({
      runId: 'run-elig-child',
      sessionId: 'session-quota-elig',
      workspace,
      cwd: workspace,
    }, parent.context.runId, 110);
    await registry.checkpointNativeModelOperation({
      runId: 'run-elig-child',
      sourceMessageId: 'msg-elig',
      provider: 'provider',
      model: 'model',
      logicalOperationId: 'turn-elig',
      phase: 'after_model_dispatch',
      status: 'dispatched',
      now: 120,
    });
    expect(isQuotaWaitParkableRun(registry, 'run-elig-child')).toBe(false);
    await expect(eligibilityInsideModelCall(registry, 'run-elig-child')).resolves.toBe(false);

    const markCancelled = vi.fn();
    const settled = settleQuotaWaitInference(new QuotaWaitSuspendError(185_000, 75_000), {
      runId: 'run-elig-child',
      markCancelled,
    });
    expect(settled).toBe(false);
    expect(markCancelled).not.toHaveBeenCalled();
    registry.unregister(child.context.runId, child);
    registry.unregister(parent.context.runId, parent);
  });

  it('keeps a plain non-durable run and a run without a descriptor ineligible', async () => {
    const registry = setup();
    workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'quota-elig-plain-')));
    const plain = registry.start({
      runId: 'run-elig-plain',
      sessionId: 'session-quota-plain',
      workspace,
      cwd: workspace,
    });
    expect(isQuotaWaitParkableRun(registry, 'run-elig-plain')).toBe(false);
    await expect(eligibilityInsideModelCall(registry, 'run-elig-plain')).resolves.toBe(false);
    const plainCancelled = vi.fn();
    expect(settleQuotaWaitInference(new QuotaWaitSuspendError(185_000, 75_000), {
      runId: 'run-elig-plain',
      markCancelled: plainCancelled,
    })).toBe(false);
    expect(plainCancelled).not.toHaveBeenCalled();

    // durable run whose checkpoints have not produced a native descriptor yet
    await registry.startDurable({
      runId: 'run-elig-bare',
      sessionId: 'session-quota-bare',
      workspace,
      cwd: workspace,
    }, 100);
    expect(isQuotaWaitParkableRun(registry, 'run-elig-bare')).toBe(false);
    const bareCancelled = vi.fn();
    expect(settleQuotaWaitInference(new QuotaWaitSuspendError(185_000, 75_000), {
      runId: 'run-elig-bare',
      markCancelled: bareCancelled,
    })).toBe(false);
    expect(bareCancelled).not.toHaveBeenCalled();
    registry.unregister(plain.context.runId, plain);
  });
});
