import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';

describe('RunRegistry durable auxiliary child', () => {
  it('keeps the foreground owner while persisting a queryable parent/child run pair', async () => {
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

    const parent = await registry.startDurable({
      runId: 'run-parent',
      sessionId: 'session-1',
      workspace: '/tmp/project',
    }, 100);
    const child = await registry.startAuxiliaryDurableChild({
      runId: 'session-work-1',
      sessionId: 'session-1',
      workspace: '/tmp/project',
    }, parent.context.runId, 110);

    expect(registry.getBySessionId('session-1')).toBe(parent);
    expect(registry.get(child.context.runId)).toBe(child);
    expect(await repository.get(child.context.runId)).toMatchObject({
      runId: 'session-work-1',
      sessionId: 'session-1',
      parentRunId: 'run-parent',
      status: 'running',
    });
    expect(await repository.listChildRuns(parent.context.runId)).toEqual([
      expect.objectContaining({
        parentRunId: 'run-parent',
        childRunId: 'session-work-1',
        status: 'running',
      }),
    ]);
    expect(await repository.listPendingOperations(parent.context.runId)).toEqual([
      expect.objectContaining({
        operationId: 'agent-team:session-work-1',
        status: 'succeeded',
        resultRef: 'auxiliary-child:session-work-1:accepted',
      }),
    ]);

    await registry.terminalDurable(parent.context.runId, {
      now: 120,
      status: 'completed',
      event: { type: 'foreground_run_completed', payload: {}, recordedAt: 120 },
    }, parent);
    expect(await repository.listChildRuns(parent.context.runId)).toEqual([
      expect.objectContaining({ childRunId: 'session-work-1', status: 'running' }),
    ]);

    await registry.terminalDurable(child.context.runId, {
      now: 200,
      status: 'completed',
      event: { type: 'auxiliary_run_completed', payload: {}, recordedAt: 200 },
    }, child);
    expect(await repository.listChildRuns(parent.context.runId)).toEqual([
      expect.objectContaining({ childRunId: 'session-work-1', status: 'completed', terminalAt: 200 }),
    ]);

    registry.clear();
    db.close();
  });
});
