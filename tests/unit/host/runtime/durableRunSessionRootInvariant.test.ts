import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';

function createKernel() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  const kernel = new DurableRunKernel({
    stores: repository,
    ownerId: 'native-host',
    processInstanceId: 'process-1',
    leaseDurationMs: 1_000,
  });
  return { db, kernel, repository };
}

describe('DurableRunKernel active session root invariant', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('allows an active native parent and active agent-team child in the same session', async () => {
    const fixture = createKernel();
    ({ db } = fixture);
    const { kernel, repository } = fixture;

    const parent = await kernel.createNativeRun({ runId: 'root-1', sessionId: 's1', now: 10 });
    const child = await kernel.createRun({
      runId: 'team-1',
      sessionId: 's1',
      engine: { kind: 'agent_team', treeId: 'tree-1' },
      parentRunId: parent.envelope.runId,
      now: 11,
    });

    expect(parent.envelope).toMatchObject({ runId: 'root-1', status: 'running' });
    expect(child.envelope).toMatchObject({ runId: 'team-1', parentRunId: 'root-1', status: 'running' });
    expect(await repository.get('root-1')).toMatchObject({ status: 'running' });
    expect(await repository.get('team-1')).toMatchObject({ parentRunId: 'root-1', status: 'running' });
  });

  it('still rejects a second active root run in the same session', async () => {
    const fixture = createKernel();
    ({ db } = fixture);
    const { kernel } = fixture;

    await kernel.createNativeRun({ runId: 'root-1', sessionId: 's1', now: 10 });
    await expect(kernel.createNativeRun({ runId: 'root-2', sessionId: 's1', now: 11 }))
      .rejects.toThrow(/UNIQUE constraint failed/i);
  });

  it('lets a completed root release its session slot for the next root', async () => {
    const fixture = createKernel();
    ({ db } = fixture);
    const { kernel, repository } = fixture;

    const first = await kernel.createNativeRun({ runId: 'root-1', sessionId: 's1', now: 10 });
    await kernel.terminal({
      runId: first.envelope.runId,
      attempt: first.attempt.attempt,
      owner: first.owner,
      now: 20,
      status: 'completed',
      event: { type: 'run_completed', payload: {}, recordedAt: 20 },
    });
    const second = await kernel.createNativeRun({ runId: 'root-2', sessionId: 's1', now: 21 });

    expect(second.envelope).toMatchObject({ runId: 'root-2', status: 'running' });
    expect(await repository.get('root-1')).toMatchObject({ status: 'completed' });
    expect(await repository.get('root-2')).toMatchObject({ status: 'running' });
  });
});
