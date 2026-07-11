import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import {
  DurableRunKernel,
  DurableRunPersistenceUnavailableError,
} from '../../../../src/host/runtime/durableRunKernel';

function createKernel(processInstanceId = 'process-1') {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  const kernel = new DurableRunKernel({
    stores: repository,
    ownerId: 'native-host',
    processInstanceId,
    leaseDurationMs: 1_000,
  });
  return { db, kernel, repository };
}

describe('DurableRunKernel', () => {
  it('recovers a Native run after the owning process is killed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-run-kill-'));
    const dbPath = join(directory, 'run.db');
    const child = spawn(process.execPath, [
      join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      join(process.cwd(), 'tests/fixtures/durableRunKillChild.ts'),
      dbPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', (chunk) => String(chunk).includes('READY') && resolve());
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`child exited before READY (${code ?? signal})`)));
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 120));

    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    const repository = new DurableRunRepository(db);
    const kernel = new DurableRunKernel({
      stores: repository, ownerId: 'native-host', processInstanceId: 'parent-process', leaseDurationMs: 100,
    });
    const plans = await kernel.recoverOnStartup(Date.now());
    expect(plans).toHaveLength(1);
    expect(plans[0].envelope).toMatchObject({ runId: 'run-killed', status: 'recovering', attempt: 2 });
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('rehydrates an expired Native run as a new recovering attempt and fences the old owner', async () => {
    const { db, kernel, repository } = createKernel();
    const created = await kernel.createNativeRun({
      runId: 'run-1',
      sessionId: 'session-1',
      now: 1_000,
    });

    const recovered = await new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: 'process-2',
      leaseDurationMs: 1_000,
    }).recoverOnStartup(2_001);

    expect(recovered).toHaveLength(1);
    expect(recovered[0].envelope).toMatchObject({
      runId: 'run-1',
      status: 'recovering',
      attempt: 2,
      owner: { epoch: 2, processInstanceId: 'process-2' },
    });
    await expect(repository.append({
      runId: 'run-1',
      attempt: 1,
      expectedOwnerEpoch: created.owner.epoch,
      expectedNextSeq: 1,
      events: [{ type: 'stale_write', payload: {}, recordedAt: 2_002 }],
    })).rejects.toThrow(/stale owner|fenced/i);
    db.close();
  });

  it('persists approval wait, turn cursor, and attempt across restart', async () => {
    const { db, kernel, repository } = createKernel();
    const created = await kernel.createNativeRun({ runId: 'run-approval', sessionId: 'session-1', now: 10 });
    await kernel.checkpoint({
      runId: 'run-approval',
      attempt: created.envelope.attempt,
      owner: created.owner,
      now: 20,
      status: 'waiting',
      state: { pendingApproval: { id: 'approval-1', question: 'Ship?' } },
      engineCursor: { version: 1, turn: 4 },
      pendingOperations: [{
        runId: 'run-approval', operationId: 'approval-1', attempt: 1,
        kind: 'approval', status: 'waiting', idempotencyKey: 'run-approval:approval-1',
        sideEffect: false, preparedAt: 15, updatedAt: 20,
      }],
      events: [{ type: 'approval_waiting', payload: { approvalId: 'approval-1' }, recordedAt: 20 }],
    });

    const [plan] = await new DurableRunKernel({
      stores: repository, ownerId: 'native-host', processInstanceId: 'process-2', leaseDurationMs: 100,
    }).recoverOnStartup(1_011);

    expect(plan.checkpoint?.cursor.engineCursor).toEqual({ version: 1, turn: 4 });
    expect(plan.pendingOperations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'approval-1', status: 'waiting' }),
    ]));
    expect(plan.envelope.attempt).toBe(2);
    db.close();
  });

  it('routes an uncertain side effect to review but retries a deduplicated tool with the same key', async () => {
    const { db, kernel, repository } = createKernel();
    const created = await kernel.createNativeRun({ runId: 'run-tools', sessionId: 'session-1', now: 10 });
    await kernel.checkpoint({
      runId: 'run-tools', attempt: 1, owner: created.owner, now: 20, status: 'running', state: {},
      pendingOperations: [
        {
          runId: 'run-tools', operationId: 'unsafe', attempt: 1, kind: 'tool_call', status: 'dispatched',
          idempotencyKey: 'stable:unsafe', sideEffect: true, requiresHumanConfirmation: true,
          preparedAt: 15, updatedAt: 20,
        },
        {
          runId: 'run-tools', operationId: 'deduped', attempt: 1, kind: 'tool_call', status: 'dispatched',
          idempotencyKey: 'stable:deduped', sideEffect: true, requiresHumanConfirmation: false,
          providerOperationId: 'provider-op-1', preparedAt: 15, updatedAt: 20,
        },
      ],
      events: [{ type: 'tool_begin', payload: {}, recordedAt: 20 }],
    });

    const [plan] = await new DurableRunKernel({
      stores: repository, ownerId: 'native-host', processInstanceId: 'process-2', leaseDurationMs: 100,
    }).recoverOnStartup(1_011);

    expect(plan.envelope.status).toBe('waiting');
    expect(plan.requiresHumanConfirmation).toEqual([
      expect.objectContaining({ operationId: 'unsafe', status: 'unknown', idempotencyKey: 'stable:unsafe' }),
    ]);
    expect(plan.pendingOperations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'deduped', status: 'prepared', idempotencyKey: 'stable:deduped' }),
    ]));
    db.close();
  });

  it('never returns a terminal run from startup recovery', async () => {
    const { db, kernel } = createKernel();
    const created = await kernel.createNativeRun({ runId: 'run-terminal', sessionId: 'session-1', now: 10 });
    await kernel.terminal({
      runId: 'run-terminal', attempt: 1, owner: created.owner, now: 20,
      status: 'completed', reason: 'done', event: { type: 'run_completed', payload: {}, recordedAt: 20 },
    });
    expect(await kernel.recoverOnStartup(2_000)).toEqual([]);
    db.close();
  });

  it('fails closed when durable storage is unavailable', async () => {
    const kernel = new DurableRunKernel({
      stores: null,
      ownerId: 'native-host',
      processInstanceId: 'process-1',
      leaseDurationMs: 100,
    });
    await expect(kernel.createNativeRun({ runId: 'run-1', sessionId: 'session-1', now: 1 }))
      .rejects.toBeInstanceOf(DurableRunPersistenceUnavailableError);
    await expect(kernel.recoverOnStartup(1)).rejects.toBeInstanceOf(DurableRunPersistenceUnavailableError);
  });
});
