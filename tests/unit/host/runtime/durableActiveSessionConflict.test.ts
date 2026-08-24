import { describe, expect, it } from 'vitest';

import { vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { RunRegistry, RunSessionConflictError } from '../../../../src/host/runtime/runRegistry';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import {
  DURABLE_ACTIVE_SESSION_CONFLICT_CODE,
  DurableActiveSessionConflictError,
} from '../../../../src/shared/contract/durableRun';
import type { RunKernelAdapter } from '../../../../src/host/runtime/durableRunKernel';

function createRegistryWithRealStore() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  const registry = new RunRegistry();
  registry.configureDurableKernel(new DurableRunKernel({
    stores: repository,
    ownerId: 'test-host',
    processInstanceId: 'test-process',
    leaseDurationMs: 60_000,
  }));
  return { db, registry };
}

/** 只有 createNativeRun 会被 startDurable 走到，其余方法留空即可。 */
function createThrowingRegistry(error: unknown) {
  const registry = new RunRegistry();
  registry.configureDurableKernel({
    createNativeRun: async () => { throw error; },
  } as unknown as RunKernelAdapter);
  return registry;
}

const start = (registry: RunRegistry, runId: string, sessionId: string, now: number) =>
  registry.startDurable({ runId, sessionId, workspace: '/tmp/project' }, now);

describe('durable active-session conflict is judged by our own code, not driver wording', () => {
  it('maps a real second-root insert to RunSessionConflictError through the storage layer', async () => {
    const { db, registry } = createRegistryWithRealStore();
    try {
      await start(registry, 'root-1', 'session-1', 100);
      // 同 session 第二条根 run：绕开内存索引（换 runId），必须落到库上的唯一索引。
      registry.clear();
      await expect(start(registry, 'root-2', 'session-1', 110))
        .rejects.toBeInstanceOf(RunSessionConflictError);
    } finally {
      db.close();
    }
  });

  it('repository raises our own error code, carrying the driver error as cause', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    const kernel = new DurableRunKernel({
      stores: repository,
      ownerId: 'test-host',
      processInstanceId: 'test-process',
      leaseDurationMs: 60_000,
    });
    try {
      await kernel.createNativeRun({ runId: 'root-1', sessionId: 's1', now: 10 });
      const failure = await kernel.createNativeRun({ runId: 'root-2', sessionId: 's1', now: 11 })
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(DurableActiveSessionConflictError);
      expect((failure as { code?: unknown }).code).toBe(DURABLE_ACTIVE_SESSION_CONFLICT_CODE);
      expect(String((failure as Error).cause)).toMatch(/UNIQUE constraint failed/i);
    } finally {
      db.close();
    }
  });

  it('still recognises the conflict when the driver message wording changes', async () => {
    const registry = createThrowingRegistry(Object.assign(
      new Error('totally different wording from some future driver'),
      { code: DURABLE_ACTIVE_SESSION_CONFLICT_CODE },
    ));
    await expect(start(registry, 'root-1', 'session-1', 100))
      .rejects.toBeInstanceOf(RunSessionConflictError);
  });

  it('falls back to the constraint name when a raw driver error reaches the judgement', async () => {
    const registry = createThrowingRegistry(Object.assign(
      new Error('constraint violation on index idx_durable_runs_active_session'),
      { code: 'SQLITE_CONSTRAINT_UNIQUE' },
    ));
    await expect(start(registry, 'root-1', 'session-1', 100))
      .rejects.toBeInstanceOf(RunSessionConflictError);
  });

  it('leaves unrelated constraint failures untouched', async () => {
    const registry = createThrowingRegistry(Object.assign(
      new Error('UNIQUE constraint failed: durable_run_attempts.run_id'),
      { code: 'SQLITE_CONSTRAINT_UNIQUE' },
    ));
    await expect(start(registry, 'root-1', 'session-1', 100))
      .rejects.toThrow(/durable_run_attempts/);
  });
});
