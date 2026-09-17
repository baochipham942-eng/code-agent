import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import {
  createUnavailableNativeRecoveryPorts,
  NativeRecoveryHost,
  type NativeRecoveryHostPorts,
} from '../../../../src/host/runtime/nativeRecoveryHost';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry, RunSessionConflictError } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';

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
    leaseDurationMs: 100,
  });
}

/**
 * N-DURABLE-WAITING-NO-EXIT：重启恢复后被判 requires_review（waiting）的 native run
 * 没有 handle、没有取消入口、还挡着同会话新 run——只进不出。这里钉住修复后的闭环：
 * waiting → terminalRecoveredWaitingRun → cancelled（kernel 规范路径）→ 同会话能起新 run。
 */
describe('durable waiting-run cancellation after recovery', () => {
  it('cancels a recovered waiting native run through the kernel path and frees the session', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-waiting-cancel-')));
    const { db, repository } = createRepository();
    const firstRegistry = new RunRegistry();
    firstRegistry.configureDurableKernel(kernel(repository, 'waiting-before-crash'));

    try {
      await firstRegistry.startDurable({
        runId: 'run-waiting',
        sessionId: 'session-waiting',
        workspace,
        cwd: workspace,
      }, 1_000);
      await firstRegistry.checkpointNativeModelOperation({
        runId: 'run-waiting',
        sourceMessageId: 'message-waiting',
        provider: 'provider',
        model: 'model',
        logicalOperationId: 'waiting-turn',
        phase: 'after_model_dispatch',
        status: 'dispatched',
        now: 1_010,
      });
      firstRegistry.clear();

      const recoveredRegistry = new RunRegistry();
      recoveredRegistry.configureDurableKernel(kernel(repository, 'waiting-after-crash'));
      const [plan] = await recoveredRegistry.recoverDurable(2_000);
      // 真实 kernel 会把 dispatched 的模型操作重分类成 prepared，走 dispatchPrepared；
      // 这里用 workspace 漂移（run-a1741e36 同类现场）走真实的 review() → waiting 路径。
      const ports: NativeRecoveryHostPorts = {
        ...createUnavailableNativeRecoveryPorts(),
        continuationExecutor: 'available',
        resolveWorkspace: vi.fn(async () => ({
          ok: true as const,
          root: '/different-root',
          cwd: workspace,
          fingerprint: createHash('sha256').update(workspace).digest('hex'),
        })),
      };
      await expect(new NativeRecoveryHost(recoveredRegistry, ports).createHandler().recover(plan!, 2_000))
        .resolves.toMatchObject({ status: 'requires_review', reason: 'native_workspace_drift' });

      // 事故现场：waiting 落库、owner 在册，但 resolve() 查不到任何 handle。
      expect(await repository.get('run-waiting')).toMatchObject({ status: 'waiting' });
      expect(recoveredRegistry.hasDurableOwner('run-waiting')).toBe(true);
      expect(recoveredRegistry.resolve({ sessionId: 'session-waiting' })).toBeUndefined();
      await expect(recoveredRegistry.startDurable({
        runId: 'run-blocked',
        sessionId: 'session-waiting',
        workspace,
        cwd: workspace,
      }, 2_050)).rejects.toBeInstanceOf(RunSessionConflictError);

      const cancelled = await recoveredRegistry.terminalRecoveredWaitingRun({ sessionId: 'session-waiting' }, 3_000);
      expect(cancelled).toEqual({ runId: 'run-waiting', sessionId: 'session-waiting' });

      // 终态走的是 kernel 规范路径：attempt/owner fence 之外，事件序号与终态字段齐全。
      expect(await repository.get('run-waiting')).toMatchObject({
        status: 'cancelled',
        terminal: { status: 'cancelled', reason: 'recovered_waiting_run_cancelled' },
      });
      const events = await repository.read('run-waiting', 0, 100);
      const cancelEvent = events.find((event) => event.type === 'run_cancelled');
      expect(cancelEvent).toMatchObject({
        payload: { sessionId: 'session-waiting', reason: 'recovered_waiting_run_cancelled' },
      });
      expect(recoveredRegistry.hasDurableOwner('run-waiting')).toBe(false);
      expect(recoveredRegistry.findRecoveredWaitingRun({ sessionId: 'session-waiting' })).toBeUndefined();

      // 同一会话现在能起新 run。
      const next = await recoveredRegistry.startDurable({
        runId: 'run-next',
        sessionId: 'session-waiting',
        workspace,
        cwd: workspace,
      }, 3_010);
      expect(next.context.runId).toBe('run-next');
    } finally {
      firstRegistry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });

  it('leaves waiting runs that still hold a control handle to the normal resolve() path', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-waiting-live-')));
    const { db, repository } = createRepository();
    const registry = new RunRegistry();
    registry.configureDurableKernel(kernel(repository, 'waiting-live'));

    try {
      const handle = await registry.startDurable({
        runId: 'run-live-waiting',
        sessionId: 'session-live-waiting',
        workspace,
        cwd: workspace,
      }, 1_000);
      await registry.checkpointDurable('run-live-waiting', {
        now: 1_010,
        status: 'waiting',
        state: null,
        pendingOperations: [],
        childRuns: [],
        events: [{ type: 'native_recovery_requires_review', payload: { reason: 'fixture' }, recordedAt: 1_010 }],
      });

      expect(registry.resolve({ sessionId: 'session-live-waiting' })).toBe(handle);
      expect(registry.findRecoveredWaitingRun({ sessionId: 'session-live-waiting' })).toBeUndefined();
      await expect(registry.terminalRecoveredWaitingRun({ sessionId: 'session-live-waiting' }, 2_000))
        .resolves.toBeUndefined();
      expect(await repository.get('run-live-waiting')).toMatchObject({ status: 'waiting' });
    } finally {
      registry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });

  it('does not terminalize a waiting run whose runId does not match the selector', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'durable-waiting-mismatch-')));
    const { db, repository } = createRepository();
    const firstRegistry = new RunRegistry();
    firstRegistry.configureDurableKernel(kernel(repository, 'mismatch-before-crash'));

    try {
      await firstRegistry.startDurable({
        runId: 'run-mismatch',
        sessionId: 'session-mismatch',
        workspace,
        cwd: workspace,
      }, 1_000);
      await firstRegistry.checkpointNativeModelOperation({
        runId: 'run-mismatch',
        sourceMessageId: 'message-mismatch',
        provider: 'provider',
        model: 'model',
        logicalOperationId: 'mismatch-turn',
        phase: 'after_model_dispatch',
        status: 'dispatched',
        now: 1_010,
      });
      firstRegistry.clear();

      const recoveredRegistry = new RunRegistry();
      recoveredRegistry.configureDurableKernel(kernel(repository, 'mismatch-after-crash'));
      await recoveredRegistry.recoverDurable(2_000);
      await recoveredRegistry.checkpointDurable('run-mismatch', {
        now: 2_000,
        status: 'waiting',
        state: null,
        pendingOperations: [],
        childRuns: [],
        events: [{ type: 'native_recovery_requires_review', payload: { reason: 'fixture' }, recordedAt: 2_000 }],
      });

      expect(recoveredRegistry.findRecoveredWaitingRun({ sessionId: 'session-mismatch', runId: 'run-other' }))
        .toBeUndefined();
      await expect(recoveredRegistry.terminalRecoveredWaitingRun({ sessionId: 'session-mismatch', runId: 'run-other' }, 2_100))
        .resolves.toBeUndefined();
      expect(await repository.get('run-mismatch')).toMatchObject({ status: 'waiting' });
      expect(recoveredRegistry.hasDurableOwner('run-mismatch')).toBe(true);
    } finally {
      firstRegistry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });
  /** 两个恢复成 waiting 的 run：同会话里一个子 run（先恢复）+ 一个根 run，都没有 handle。 */
  async function recoveredRootAndChild(label: string) {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), `durable-waiting-${label}-`)));
    const { db, repository } = createRepository();
    const beforeCrash = kernel(repository, `${label}-before-crash`);
    const firstRegistry = new RunRegistry();
    firstRegistry.configureDurableKernel(beforeCrash);
    // 子 run 先落库（updated_at 更早 → 恢复顺序在前），复现「只按 sessionId 取第一个」命中子 run。
    await beforeCrash.createNativeRun({
      runId: `run-${label}-child`,
      sessionId: `session-${label}`,
      parentRunId: `run-${label}-root`,
      now: 900,
    });
    await firstRegistry.startDurable({
      runId: `run-${label}-root`,
      sessionId: `session-${label}`,
      workspace,
      cwd: workspace,
    }, 1_000);
    firstRegistry.clear();

    const recoveredRegistry = new RunRegistry();
    recoveredRegistry.configureDurableKernel(kernel(repository, `${label}-after-crash`));
    await recoveredRegistry.recoverDurable(2_000);
    for (const runId of [`run-${label}-child`, `run-${label}-root`]) {
      await recoveredRegistry.checkpointDurable(runId, {
        now: 2_000,
        status: 'waiting',
        state: null,
        pendingOperations: [],
        childRuns: [],
        events: [{ type: 'native_recovery_requires_review', payload: { reason: 'fixture' }, recordedAt: 2_000 }],
      });
    }
    return { workspace, db, repository, firstRegistry, recoveredRegistry };
  }

  it('resolves a session-only selector to the root waiting run, never an arbitrary child', async () => {
    const fixture = await recoveredRootAndChild('root-child');
    try {
      expect(fixture.recoveredRegistry.findRecoveredWaitingRun({ sessionId: 'session-root-child' }))
        .toEqual({ runId: 'run-root-child-root', sessionId: 'session-root-child' });
      await expect(fixture.recoveredRegistry.terminalRecoveredWaitingRun({ sessionId: 'session-root-child' }, 3_000))
        .resolves.toEqual({ runId: 'run-root-child-root', sessionId: 'session-root-child' });
      expect(await fixture.repository.get('run-root-child-root')).toMatchObject({ status: 'cancelled' });
      // 显式 runId 仍能精确命中子 run。
      expect(fixture.recoveredRegistry.findRecoveredWaitingRun({ runId: 'run-root-child-child' }))
        .toEqual({ runId: 'run-root-child-child', sessionId: 'session-root-child' });
    } finally {
      fixture.recoveredRegistry.clear();
      fixture.firstRegistry.clear();
      rmSync(fixture.workspace, { recursive: true, force: true });
      fixture.db.close();
    }
  });

  it('settles concurrent cancels of the same waiting run once and reports both as cancelled', async () => {
    const fixture = await recoveredRootAndChild('concurrent');
    try {
      // 桌面「放弃」与手机「停止」同时到：两边都查得到这个 run，后到的一方不能因 terminal 冲突抛错。
      const results = await Promise.allSettled([
        fixture.recoveredRegistry.terminalRecoveredWaitingRun({ sessionId: 'session-concurrent', runId: 'run-concurrent-root' }, 3_000),
        fixture.recoveredRegistry.terminalRecoveredWaitingRun({ runId: 'run-concurrent-root' }, 3_001),
      ]);
      expect(results).toEqual([
        { status: 'fulfilled', value: { runId: 'run-concurrent-root', sessionId: 'session-concurrent' } },
        { status: 'fulfilled', value: { runId: 'run-concurrent-root', sessionId: 'session-concurrent' } },
      ]);
      expect(await fixture.repository.get('run-concurrent-root')).toMatchObject({ status: 'cancelled' });
      const events = await fixture.repository.read('run-concurrent-root', 0, 100);
      expect(events.filter((event) => event.type === 'run_cancelled')).toHaveLength(1);
    } finally {
      fixture.recoveredRegistry.clear();
      fixture.firstRegistry.clear();
      rmSync(fixture.workspace, { recursive: true, force: true });
      fixture.db.close();
    }
  });
});
