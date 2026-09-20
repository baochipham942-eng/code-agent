import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry, RunSessionConflictError } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';

function createStack(processInstanceId: string) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  const registry = new RunRegistry();
  registry.configureDurableKernel(new DurableRunKernel({
    stores: repository,
    ownerId: 'cli-native-host',
    processInstanceId,
    leaseDurationMs: 60_000,
  }));
  return { db, repository, registry };
}

describe('parallel native tool checkpoints and orphaned CLI session roots', () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('lets three parallel Read checkpoints succeed without stale-cursor fences', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-parallel-tools-')));
    workspaces.push(workspace);
    const { db, registry } = createStack('cli-live');
    try {
      const handle = await registry.startDurable({
        runId: 'run-parallel-reads',
        sessionId: 'session-parallel-reads',
        workspace,
        cwd: workspace,
      }, 1_000);

      const results = await Promise.allSettled(
        ['a', 'b', 'c'].map((id) => registry.checkpointNativeToolOperation({
          runId: handle.context.runId,
          sourceMessageId: 'user-1',
          toolName: 'Read',
          logicalOperationId: `call-${id}`,
          providerOperationId: `exec-${id}`,
          sideEffect: false,
          status: 'dispatched',
          now: 1_010,
        })),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('cancels an orphaned cli-native-host root so the next process can startDurable on the same session', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-orphan-cli-')));
    workspaces.push(workspace);
    const { db, repository } = createStack('cli-dead');
    const first = new RunRegistry();
    first.configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'cli-native-host',
      processInstanceId: 'cli-dead',
      leaseDurationMs: 60_000,
    }));
    const second = new RunRegistry();
    second.configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'cli-native-host',
      processInstanceId: 'cli-live',
      leaseDurationMs: 60_000,
    }));

    try {
      await first.startDurable({
        runId: 'run-dead',
        sessionId: 'session-followup',
        workspace,
        cwd: workspace,
      }, 1_000);
      first.clear();

      await expect(second.startDurable({
        runId: 'run-live',
        sessionId: 'session-followup',
        workspace,
        cwd: workspace,
      }, 2_000)).rejects.toBeInstanceOf(RunSessionConflictError);

      await expect(second.cancelOrphanedSessionRoot({
        sessionId: 'session-followup',
        expectedOwnerId: 'cli-native-host',
        processInstanceId: 'cli-live',
        now: 3_000,
      })).resolves.toBe(true);

      await expect(second.startDurable({
        runId: 'run-live',
        sessionId: 'session-followup',
        workspace,
        cwd: workspace,
      }, 4_000)).resolves.toMatchObject({
        context: { sessionId: 'session-followup', runId: 'run-live' },
      });
    } finally {
      db.close();
    }
  });
});
