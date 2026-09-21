import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry, RunSessionConflictError } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';

const OWNER_ID = 'cli-native-host';
const LEASE_MS = 1_000;

function createRepository() {
  const db = new Database(':memory:');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  return { db, repository };
}

function kernel(repository: DurableRunRepository, processInstanceId: string) {
  return new DurableRunKernel({
    stores: repository,
    ownerId: OWNER_ID,
    processInstanceId,
    leaseDurationMs: LEASE_MS,
  });
}

function createWorkspace(label: string) {
  return realpathSync(mkdtempSync(path.join(tmpdir(), `durable-orphan-${label}-`)));
}

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

/**
 * GitHub #1993：`-s` 续跑撞「Session already has an active durable run」。
 * 前一轮异常结束后留下的活跃 durable run 分两种僵尸：
 *  1. 跨进程僵尸：owner 进程 pid 已死（租约可能还没过期）——pid 探测收尸。
 *  2. 自拍僵尸：本进程启动恢复已把租约认领到名下，但没有任何活 handle 领养它，
 *     跨进程判据必然拒收——沿 terminalDurable 规范路径收尸后放行续跑。
 * 真活着的 run（有 handle 在驱动 / 其它活进程持有有效租约）必须保持原冲突语义。
 */
describe('cancelOrphanedSessionRoot zombie reaping', () => {
  it('reaps a cross-process zombie whose owner pid is gone and lets the resume start a new run', async () => {
    const deadPid = await exitedPid();
    const workspace = createWorkspace('dead-pid');
    const { db, repository } = createRepository();
    const crashedRegistry = new RunRegistry();
    crashedRegistry.configureDurableKernel(kernel(repository, `cli-${deadPid}-crashed`));

    try {
      await crashedRegistry.startDurable({
        runId: 'run-dead-pid',
        sessionId: 'session-dead-pid',
        workspace,
        cwd: workspace,
      }, 1_000);
      // 异常结束：进程死了，durable run 没有 terminal。租约写到 2_000，续跑发生在租约内。
      crashedRegistry.clear();

      const resumedRegistry = new RunRegistry();
      const resumedInstanceId = `cli-${process.pid}-resumed`;
      resumedRegistry.configureDurableKernel(kernel(repository, resumedInstanceId));
      await expect(resumedRegistry.startDurable({
        runId: 'run-resume-blocked',
        sessionId: 'session-dead-pid',
        workspace,
        cwd: workspace,
      }, 1_500)).rejects.toBeInstanceOf(RunSessionConflictError);

      await expect(resumedRegistry.cancelOrphanedSessionRoot({
        sessionId: 'session-dead-pid',
        expectedOwnerId: OWNER_ID,
        processInstanceId: resumedInstanceId,
        now: 1_500,
      })).resolves.toBe(true);
      expect(await repository.get('run-dead-pid')).toMatchObject({
        status: 'cancelled',
        terminal: { status: 'cancelled', reason: 'orphaned_cli_session_root' },
      });

      const next = await resumedRegistry.startDurable({
        runId: 'run-resume-ok',
        sessionId: 'session-dead-pid',
        workspace,
        cwd: workspace,
      }, 1_600);
      expect(next.context.runId).toBe('run-resume-ok');
      resumedRegistry.clear();
    } finally {
      crashedRegistry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });

  it('reaps a self-owned recovered run with no live handle and lets the resume start a new run', async () => {
    const workspace = createWorkspace('self-orphan');
    const { db, repository } = createRepository();
    const crashedRegistry = new RunRegistry();
    crashedRegistry.configureDurableKernel(kernel(repository, `cli-1-before-crash`));

    try {
      await crashedRegistry.startDurable({
        runId: 'run-self-orphan',
        sessionId: 'session-self-orphan',
        workspace,
        cwd: workspace,
      }, 1_000);
      crashedRegistry.clear();

      // 新一轮 CLI 进程：启动恢复把过期租约认领到本进程名下，但没有 handle 领养这个 run。
      const resumedRegistry = new RunRegistry();
      const resumedInstanceId = `cli-${process.pid}-resumed`;
      resumedRegistry.configureDurableKernel(kernel(repository, resumedInstanceId));
      const plans = await resumedRegistry.recoverDurable(5_000);
      expect(plans).toHaveLength(1);
      expect(await repository.get('run-self-orphan')).toMatchObject({
        status: 'recovering',
        owner: { processInstanceId: resumedInstanceId },
      });
      expect(resumedRegistry.hasDurableOwner('run-self-orphan')).toBe(true);
      expect(resumedRegistry.resolve({ sessionId: 'session-self-orphan' })).toBeUndefined();

      // 事故现场：续跑必撞冲突，而旧的跨进程判据因为 owner 已是本进程而拒收。
      await expect(resumedRegistry.startDurable({
        runId: 'run-resume-blocked',
        sessionId: 'session-self-orphan',
        workspace,
        cwd: workspace,
      }, 5_100)).rejects.toBeInstanceOf(RunSessionConflictError);

      await expect(resumedRegistry.cancelOrphanedSessionRoot({
        sessionId: 'session-self-orphan',
        expectedOwnerId: OWNER_ID,
        processInstanceId: resumedInstanceId,
        now: 5_100,
      })).resolves.toBe(true);

      // 收尸走 kernel 规范路径：终态字段与事件齐全，注册表 owner 清掉。
      expect(await repository.get('run-self-orphan')).toMatchObject({
        status: 'cancelled',
        terminal: { status: 'cancelled', reason: 'cli_resume_reaped_recovered_orphan' },
      });
      const events = await repository.read('run-self-orphan', 0, 100);
      const cancelEvent = events.find((event) => event.type === 'run_cancelled');
      expect(cancelEvent).toMatchObject({
        payload: { sessionId: 'session-self-orphan', reason: 'cli_resume_reaped_recovered_orphan' },
      });
      expect(resumedRegistry.hasDurableOwner('run-self-orphan')).toBe(false);

      const next = await resumedRegistry.startDurable({
        runId: 'run-resume-ok',
        sessionId: 'session-self-orphan',
        workspace,
        cwd: workspace,
      }, 5_200);
      expect(next.context.runId).toBe('run-resume-ok');
      resumedRegistry.clear();
    } finally {
      crashedRegistry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });

  it('refuses to reap a run this process is actively driving (live handle)', async () => {
    const workspace = createWorkspace('live-handle');
    const { db, repository } = createRepository();
    const registry = new RunRegistry();
    const instanceId = `cli-${process.pid}-live`;
    registry.configureDurableKernel(kernel(repository, instanceId));

    try {
      const handle = await registry.startDurable({
        runId: 'run-live',
        sessionId: 'session-live',
        workspace,
        cwd: workspace,
      }, 1_000);
      expect(registry.resolve({ sessionId: 'session-live' })).toBe(handle);

      await expect(registry.cancelOrphanedSessionRoot({
        sessionId: 'session-live',
        expectedOwnerId: OWNER_ID,
        processInstanceId: instanceId,
        now: 1_500,
      })).resolves.toBe(false);
      expect(await repository.get('run-live')).toMatchObject({ status: 'running' });
      await expect(registry.startDurable({
        runId: 'run-second',
        sessionId: 'session-live',
        workspace,
        cwd: workspace,
      }, 1_600)).rejects.toBeInstanceOf(RunSessionConflictError);
    } finally {
      registry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });

  it('refuses a live cross-process run with a valid lease', async () => {
    const workspace = createWorkspace('live-peer');
    const { db, repository } = createRepository();
    const peerRegistry = new RunRegistry();
    // 另一个还活着的 CLI 进程（pid 就是本测试进程，必然存活）持有未过期租约。
    peerRegistry.configureDurableKernel(kernel(repository, `cli-${process.pid}-peer`));

    try {
      await peerRegistry.startDurable({
        runId: 'run-live-peer',
        sessionId: 'session-live-peer',
        workspace,
        cwd: workspace,
      }, 1_000);

      const resumedRegistry = new RunRegistry();
      const resumedInstanceId = `cli-${process.pid}-resumed`;
      resumedRegistry.configureDurableKernel(kernel(repository, resumedInstanceId));
      await expect(resumedRegistry.cancelOrphanedSessionRoot({
        sessionId: 'session-live-peer',
        expectedOwnerId: OWNER_ID,
        processInstanceId: resumedInstanceId,
        now: 1_500,
      })).resolves.toBe(false);
      expect(await repository.get('run-live-peer')).toMatchObject({ status: 'running' });
      resumedRegistry.clear();
    } finally {
      peerRegistry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });
});
