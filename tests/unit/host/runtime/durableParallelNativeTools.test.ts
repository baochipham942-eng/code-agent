import { spawn } from 'node:child_process';
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

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid == null) throw new Error('spawned process has no pid');
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  return pid;
}

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
    const deadInstance = `cli-${await exitedPid()}-dead`;
    const { db, repository } = createStack(deadInstance);
    const first = new RunRegistry();
    first.configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'cli-native-host',
      processInstanceId: deadInstance,
      leaseDurationMs: 60_000,
    }));
    const second = new RunRegistry();
    second.configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'cli-native-host',
      processInstanceId: `cli-${process.pid}-live`,
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
        processInstanceId: `cli-${process.pid}-live`,
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

  it('does not steal a live unexpired cli-native-host lease', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-live-cli-')));
    workspaces.push(workspace);
    const liveInstance = `cli-${process.pid}-still-alive`;
    const { db, repository } = createStack(liveInstance);
    const first = new RunRegistry();
    first.configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'cli-native-host',
      processInstanceId: liveInstance,
      leaseDurationMs: 60_000,
    }));
    const second = new RunRegistry();
    second.configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'cli-native-host',
      processInstanceId: `cli-${process.pid}-other`,
      leaseDurationMs: 60_000,
    }));

    try {
      await first.startDurable({
        runId: 'run-live',
        sessionId: 'session-live',
        workspace,
        cwd: workspace,
      }, 1_000);

      await expect(second.cancelOrphanedSessionRoot({
        sessionId: 'session-live',
        expectedOwnerId: 'cli-native-host',
        processInstanceId: `cli-${process.pid}-other`,
        now: 3_000,
      })).resolves.toBe(false);
    } finally {
      db.close();
    }
  });

  it('still finds an orphaned root when a newer child run exists on the session', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-orphan-child-')));
    workspaces.push(workspace);
    const deadInstance = `cli-${await exitedPid()}-dead`;
    const { db, repository, registry: second } = createStack(`cli-${process.pid}-live`);
    const deadKernel = new DurableRunKernel({
      stores: repository,
      ownerId: 'cli-native-host',
      processInstanceId: deadInstance,
      leaseDurationMs: 60_000,
    });
    const first = new RunRegistry();
    first.configureDurableKernel(deadKernel);

    try {
      await first.startDurable({
        runId: 'run-dead-root',
        sessionId: 'session-child-mask',
        workspace,
        cwd: workspace,
      }, 1_000);
      await deadKernel.createNativeRun({
        runId: 'run-child',
        sessionId: 'session-child-mask',
        parentRunId: 'run-dead-root',
        now: 1_500,
      });
      first.clear();

      expect((await repository.getLatestBySession('session-child-mask'))?.runId).toBe('run-child');
      expect((await repository.getLatestActiveRootBySession('session-child-mask'))?.runId).toBe('run-dead-root');

      await expect(second.cancelOrphanedSessionRoot({
        sessionId: 'session-child-mask',
        expectedOwnerId: 'cli-native-host',
        processInstanceId: `cli-${process.pid}-live`,
        now: 3_000,
      })).resolves.toBe(true);
    } finally {
      db.close();
    }
  });
});
