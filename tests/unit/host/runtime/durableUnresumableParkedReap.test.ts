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
const LEASE_MS = 15_000;

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
  return realpathSync(mkdtempSync(path.join(tmpdir(), `durable-unresumable-${label}-`)));
}

async function parkWaitingWithReview(
  registry: RunRegistry,
  input: { runId: string; sessionId: string; workspace: string; reviewReason: string; now?: number },
) {
  await registry.startDurable({
    runId: input.runId,
    sessionId: input.sessionId,
    workspace: input.workspace,
    cwd: input.workspace,
  }, input.now ?? 1_000);
  // 接管方（另一个活进程）的 native 恢复宿主判 requires_review：与 nativeRecoveryHost.review()
  // 同款落库——waiting + native_recovery_requires_review 事件。
  await registry.checkpointDurable(input.runId, {
    now: input.now ?? 2_000,
    status: 'waiting',
    state: null,
    pendingOperations: [],
    childRuns: [],
    events: [{
      type: 'native_recovery_requires_review',
      payload: { reason: input.reviewReason },
      recordedAt: input.now ?? 2_000,
    }],
  });
}

/**
 * N-CLI-DURABLE-TERMINAL-LOST ③：`-s` 续话撞「Session already has an active durable run」。
 * 夜巡形态：第 1 轮正常答完但终态写失败，租约过期后被其他题的活进程以 lease_expired 接管，
 * 接管方判 native_workspace_unavailable（工作区已被删）→ waiting 停靠 + 续着一条没人能用的
 * 租约。下一轮 `-s` 的 cancelOrphanedSessionRoot 因 owner 是活进程且租约未过期而拒收。
 * 修复：waiting + 末事件 native_recovery_requires_review(native_workspace_unavailable) =
 * 没人能真正续跑 → 允许收尸后起新 run。真活跑着的 run 与其他复核原因仍保持冲突语义。
 */
describe('cancelOrphanedSessionRoot unresumable parked reap', () => {
  it('③ reaps a waiting run reviewed as native_workspace_unavailable by a live peer, then the resume starts a new run', async () => {
    const workspace = createWorkspace('ws-gone');
    const { db, repository } = createRepository();
    const peerRegistry = new RunRegistry();
    // owner 是另一个活进程：pid 就是本测试进程，租约 1_000+15_000 远未过期。
    peerRegistry.configureDurableKernel(kernel(repository, `cli-${process.pid}-peer`));

    try {
      await parkWaitingWithReview(peerRegistry, {
        runId: 'run-ws-gone',
        sessionId: 'session-ws-gone',
        workspace,
        reviewReason: 'native_workspace_unavailable',
      });

      const resumedRegistry = new RunRegistry();
      const resumedInstanceId = `cli-${process.pid}-resumed`;
      resumedRegistry.configureDurableKernel(kernel(repository, resumedInstanceId));

      // 事故现场：跨进程判据必拒收（租约未过期 + pid 活着），修复前这里直接 false → 抛冲突。
      await expect(resumedRegistry.cancelOrphanedSessionRoot({
        sessionId: 'session-ws-gone',
        expectedOwnerId: OWNER_ID,
        processInstanceId: resumedInstanceId,
        now: 3_000,
      })).resolves.toBe(true);

      const envelope = await repository.get('run-ws-gone');
      expect(envelope).toMatchObject({
        status: 'cancelled',
        terminal: { status: 'cancelled', reason: 'cli_resume_reaped_workspace_unavailable' },
      });
      // 原持有方的租约被作废：epoch 抬高 + 租约即刻过期，残留内存态下次心跳即 fence。
      expect(envelope?.owner).toMatchObject({ epoch: 2 });
      expect(envelope?.owner?.leaseExpiresAt).toBe(3_000);
      const events = await repository.read('run-ws-gone', 0, 100);
      expect(events.at(-1)).toMatchObject({
        type: 'run_cancelled',
        payload: { sessionId: 'session-ws-gone', reason: 'cli_resume_reaped_workspace_unavailable' },
      });
      const attempt = await repository.getAttempt('run-ws-gone', 1);
      expect(attempt?.status).toBe('ended');

      const next = await resumedRegistry.startDurable({
        runId: 'run-resume-ok',
        sessionId: 'session-ws-gone',
        workspace,
        cwd: workspace,
      }, 3_100);
      expect(next.context.runId).toBe('run-resume-ok');
      resumedRegistry.clear();
    } finally {
      peerRegistry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });

  it('③ keeps conflict semantics for other review reasons (human-reviewable)', async () => {
    const workspace = createWorkspace('other-reason');
    const { db, repository } = createRepository();
    const peerRegistry = new RunRegistry();
    peerRegistry.configureDurableKernel(kernel(repository, `cli-${process.pid}-peer`));

    try {
      await parkWaitingWithReview(peerRegistry, {
        runId: 'run-guard-halt',
        sessionId: 'session-guard-halt',
        workspace,
        reviewReason: 'unknown_write_side_effect',
      });

      const resumedRegistry = new RunRegistry();
      const resumedInstanceId = `cli-${process.pid}-resumed`;
      resumedRegistry.configureDurableKernel(kernel(repository, resumedInstanceId));
      await expect(resumedRegistry.cancelOrphanedSessionRoot({
        sessionId: 'session-guard-halt',
        expectedOwnerId: OWNER_ID,
        processInstanceId: resumedInstanceId,
        now: 3_000,
      })).resolves.toBe(false);
      expect(await repository.get('run-guard-halt')).toMatchObject({ status: 'waiting' });
      await expect(resumedRegistry.startDurable({
        runId: 'run-resume-blocked',
        sessionId: 'session-guard-halt',
        workspace,
        cwd: workspace,
      }, 3_100)).rejects.toBeInstanceOf(RunSessionConflictError);
      resumedRegistry.clear();
    } finally {
      peerRegistry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });

  it('③ keeps conflict semantics when the last event is not the review verdict (e.g. approval restored)', async () => {
    const workspace = createWorkspace('approval');
    const { db, repository } = createRepository();
    const peerRegistry = new RunRegistry();
    peerRegistry.configureDurableKernel(kernel(repository, `cli-${process.pid}-peer`));

    try {
      await peerRegistry.startDurable({
        runId: 'run-approval',
        sessionId: 'session-approval',
        workspace,
        cwd: workspace,
      }, 1_000);
      // 历史上有过 workspace 复核事件，但末事件已是 approval_recovered（等待人工审批，
      // 桌面复核收件箱语义），判据 fence 必须看末事件而不是「出现过」。
      await peerRegistry.checkpointDurable('run-approval', {
        now: 2_000,
        status: 'waiting',
        state: null,
        pendingOperations: [],
        childRuns: [],
        events: [{ type: 'native_recovery_requires_review', payload: { reason: 'native_workspace_unavailable' }, recordedAt: 2_000 }],
      });
      await peerRegistry.checkpointDurable('run-approval', {
        now: 2_500,
        status: 'waiting',
        state: null,
        pendingOperations: [],
        childRuns: [],
        events: [{ type: 'approval_recovered', payload: { runId: 'run-approval' }, recordedAt: 2_500 }],
      });

      const resumedRegistry = new RunRegistry();
      const resumedInstanceId = `cli-${process.pid}-resumed`;
      resumedRegistry.configureDurableKernel(kernel(repository, resumedInstanceId));
      await expect(resumedRegistry.cancelOrphanedSessionRoot({
        sessionId: 'session-approval',
        expectedOwnerId: OWNER_ID,
        processInstanceId: resumedInstanceId,
        now: 3_000,
      })).resolves.toBe(false);
      expect(await repository.get('run-approval')).toMatchObject({ status: 'waiting' });
      resumedRegistry.clear();
    } finally {
      peerRegistry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });

  it('repo fence: cancelUnresumableParkedRun refuses a non-waiting run even with a matching review event', async () => {
    const workspace = createWorkspace('repo-fence');
    const { db, repository } = createRepository();
    const peerRegistry = new RunRegistry();
    peerRegistry.configureDurableKernel(kernel(repository, `cli-${process.pid}-peer`));

    try {
      await peerRegistry.startDurable({
        runId: 'run-running',
        sessionId: 'session-running',
        workspace,
        cwd: workspace,
      }, 1_000);
      // running + 复核事件：判据只认 waiting，活跑着的 run 不许被旁路收尸。
      await peerRegistry.checkpointDurable('run-running', {
        now: 2_000,
        status: 'running',
        state: null,
        pendingOperations: [],
        childRuns: [],
        events: [{ type: 'native_recovery_requires_review', payload: { reason: 'native_workspace_unavailable' }, recordedAt: 2_000 }],
      });

      await expect(repository.cancelUnresumableParkedRun!({
        runId: 'run-running',
        sessionId: 'session-running',
        now: 3_000,
        reason: 'cli_resume_reaped_workspace_unavailable',
        requireLastEvent: { type: 'native_recovery_requires_review', reviewReason: 'native_workspace_unavailable' },
      })).resolves.toBe(false);
      expect(await repository.get('run-running')).toMatchObject({ status: 'running' });
    } finally {
      peerRegistry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });
});
