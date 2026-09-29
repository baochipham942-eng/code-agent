import express from 'express';
import http from 'http';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry, RunSessionConflictError } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { assembleDurableRun } from '../../../../src/host/app/initializeDurableRun';
import { projectDurableRunToSessionPayload } from '../../../../src/host/app/durableRunReadService';
import {
  createUnavailableNativeRecoveryPorts,
  NativeRecoveryHost,
  type NativeRecoveryHostPorts,
} from '../../../../src/host/runtime/nativeRecoveryHost';
import { createAgentDurableRouteRunLifecycle } from '../../../../src/web/routes/agentDurableRouteLifecycle';
import { registerAgentCancelRoute } from '../../../../src/web/routes/registerAgentCancelRoute';
import { MAX_AUTO_RESUME_COUNT, type PendingOperation } from '../../../../src/shared/contract/durableRun';

/**
 * ADR-075 修订三（N-RESUME-BUDGET-APPROVAL，2026-09-29）：
 * ① 崩溃自动续跑预算耗尽后又在等审批的 run，重启后被本进程认领、恢复为同一张审批卡（等审批 waiting，
 *    不出「继续」），批准后同 runId 回 loop、拒绝按现有拒绝语义喂回模型；新消息仍按等审批冲突语义（409）
 *    不吞待审批操作，「放弃」（web /api/cancel）可收尾，不再 409 死锁。
 * ② 恢复后 live 路径成功推进一轮（模型调用成功结束 / tool complete）即清零自动续跑计数，之后再崩溃仍能自动续跑。
 * 真实 SQLite 仓库 + 真实 RunRegistry + 真实 kernel；web 出口走真实 express 路由。
 */

const APPROVAL_ID = 'approval-exhausted';

function setup(label: string) {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), `durable-${label}-`)));
  const db = new Database(':memory:');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  const registries: RunRegistry[] = [];
  const registry = (processInstanceId: string) => {
    const next = new RunRegistry();
    registries.push(next);
    next.configureDurableKernel(new DurableRunKernel({ stores: repository, ownerId: 'native-host', processInstanceId, leaseDurationMs: 100 }));
    return next;
  };
  const restart = (processInstanceId: string) => {
    const next = new RunRegistry();
    registries.push(next);
    const { readService } = assembleDurableRun({
      registry: next, repository, ownerId: 'native-host', processInstanceId,
      env: { CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' }, leaseDurationMs: 100,
    });
    return { registry: next, readService };
  };
  const cleanup = () => {
    for (const r of registries) r.clear();
    rmSync(workspace, { recursive: true, force: true });
    db.close();
  };
  return { workspace, db, repository, registry, restart, cleanup };
}

type Env = ReturnType<typeof setup>;

/** 首个进程：预算已耗尽（count=MAX）的 crash_or_quit run 停在等审批（或待人工确认的未知写）后「崩溃」。 */
async function seedExhaustedApprovalRun(env: Env, runId: string, sessionId: string, variant: 'approval' | 'human_confirmation' = 'approval') {
  const first = env.registry(`${runId}-first`);
  const kernel = new DurableRunKernel({ stores: env.repository, ownerId: 'native-host', processInstanceId: 'seed', leaseDurationMs: 100 });
  await first.startDurable({ runId, sessionId, workspace: env.workspace, cwd: env.workspace }, 1_000);
  const operation: PendingOperation = variant === 'approval'
    ? {
        ...kernel.prepareOperation({
          runId, operationId: `approval:${APPROVAL_ID}`, logicalOperationId: APPROVAL_ID, attempt: 1, kind: 'approval',
          sideEffect: false, canDeduplicate: true, requiresHumanConfirmation: true, providerOperationId: `approval:${APPROVAL_ID}`, now: 1_010,
        }),
        status: 'waiting',
      }
    : {
        ...kernel.prepareOperation({
          runId, operationId: 'tool:external-write', logicalOperationId: 'external-write', attempt: 1, kind: 'tool_call',
          sideEffect: true, canDeduplicate: false, now: 1_010,
        }),
        status: 'unknown', requiresHumanConfirmation: true,
      };
  await first.checkpointDurable(runId, {
    now: 1_020,
    status: 'waiting',
    state: {
      schemaVersion: 1, kind: 'native', sourceMessageId: 'message-source', provider: 'provider', model: 'model',
      workspace: { root: env.workspace, cwd: env.workspace, fingerprint: createHash('sha256').update(env.workspace).digest('hex') },
      logicalOperationId: variant === 'approval' ? APPROVAL_ID : 'external-write',
      operationId: operation.operationId,
      phase: variant === 'approval' ? 'approval_waiting' : 'tool_dispatched',
      ...(variant === 'approval' ? { approvalId: APPROVAL_ID } : {}),
      checkpointSequence: 1,
    },
    engineCursor: { schemaVersion: 1, runtime: 'native' },
    pendingOperations: [operation],
    childRuns: [],
    interruptCause: 'crash_or_quit',
    autoResumeCount: MAX_AUTO_RESUME_COUNT,
    events: [{ type: 'approval_recovered', payload: { runId }, recordedAt: 1_020 }],
  });
  first.clear();
}

function approvalPorts(approval: 'pending' | 'approved' | 'rejected') {
  const unavailable = createUnavailableNativeRecoveryPorts();
  const continued: string[] = [];
  const dispatched: string[] = [];
  const rejected: Array<string | null | undefined> = [];
  const ports: NativeRecoveryHostPorts = {
    ...unavailable,
    continuationExecutor: 'available',
    resolveWorkspace: async (descriptor) => ({ ok: true, root: descriptor.workspace.root, cwd: descriptor.workspace.cwd, fingerprint: descriptor.workspace.fingerprint }),
    approval: {
      read: async () => (approval === 'rejected' ? { status: 'rejected' as const, feedback: '不要写' } : approval),
      queryResult: async () => null,
      dispatchPrepared: async (input) => { dispatched.push(input.operation.operationId); return { resultRef: 'message-ledger:approved' }; },
      reject: async (_input, feedback) => { rejected.push(feedback); return { resultRef: 'message-ledger:rejected' }; },
    },
    continueLoop: async (input) => { continued.push(input.plan.envelope.runId); },
  };
  return { ports, continued, dispatched, rejected };
}

describe('ADR-075 修订三 ①：预算耗尽后又等审批的 run 重启后认领为等审批', () => {
  it.each(['approval', 'human_confirmation'] as const)('reclaims an exhausted crash run waiting on %s as a same-approval wait on every restart', async (variant) => {
    const env = setup(`exhausted-${variant}`);
    const runId = 'run-exhausted-approval';
    const sessionId = 'session-exhausted-approval';
    try {
      await seedExhaustedApprovalRun(env, runId, sessionId, variant);
      for (const [index, now] of [2_000, 4_000].entries()) {
        env.repository.migrate(); // 开库迁移（markLegacyBudgetExhaustedParks）不得把它改标成停靠
        const { registry, readService } = env.restart(`exhausted-approval-restart-${index}`);
        const plans = await registry.recoverDurable(now);
        expect(plans.map((plan) => [plan.envelope.runId, plan.envelope.status, plan.envelope.interruptCause, plan.envelope.autoResumeCount, plan.resumeBlocked]))
          .toEqual([[runId, 'waiting', 'crash_or_quit', MAX_AUTO_RESUME_COUNT, undefined]]);
        expect(registry.hasDurableOwner(runId)).toBe(true);
        const payload = projectDurableRunToSessionPayload(await readService.readSessionReplay(sessionId, () => ({ status: 'idle' })));
        expect(payload.durableWaitingInput).toBe(true); // 审批卡
        expect(payload.durableResume?.mode).not.toBe('continue');
        registry.clear();
      }
    } finally {
      env.cleanup();
    }
  });

  it('never lets an exhausted waiting row with no approval left bypass the budget: it parks as budget_exhausted', async () => {
    const env = setup('exhausted-no-approval');
    const runId = 'run-exhausted-no-approval';
    try {
      // 未经开库迁移的存量停靠形状（waiting + crash_or_quit + 计数耗尽 + 无审批 op）。
      const first = env.registry('no-approval-first');
      await first.startDurable({ runId, sessionId: 'session-no-approval', workspace: env.workspace, cwd: env.workspace }, 1_000);
      await first.checkpointDurable(runId, {
        now: 1_020, status: 'waiting', state: null, pendingOperations: [], childRuns: [],
        interruptCause: 'crash_or_quit', autoResumeCount: MAX_AUTO_RESUME_COUNT,
        events: [{ type: 'run_checkpointed', payload: {}, recordedAt: 1_020 }],
      });
      first.clear();
      const plans = await env.registry('no-approval-restart').recoverDurable(2_000);
      expect(plans.map((plan) => [plan.envelope.status, plan.envelope.interruptCause, plan.envelope.autoResumeCount, plan.resumeBlocked]))
        .toEqual([['waiting', 'budget_exhausted', MAX_AUTO_RESUME_COUNT, true]]);
    } finally {
      env.cleanup();
    }
  });

  it('restores the same approval card, then approval continues the same runId and rejection feeds the denial back', async () => {
    for (const decision of ['approved', 'rejected'] as const) {
      const env = setup(`exhausted-${decision}`);
      const runId = `run-${decision}`;
      const sessionId = `session-${decision}`;
      try {
        await seedExhaustedApprovalRun(env, runId, sessionId);
        // 第一次重启：审批仍 pending → 恢复同一张审批卡，run 停在 waiting。
        const first = env.registry('restart-pending');
        const [pendingPlan] = await first.recoverDurable(2_000);
        const pending = approvalPorts('pending');
        await expect(new NativeRecoveryHost(first, pending.ports).createHandler().recover(pendingPlan, 2_000))
          .resolves.toMatchObject({ status: 'observing', reason: 'restore_same_approval' });
        expect(await env.repository.get(runId)).toMatchObject({ status: 'waiting', interruptCause: 'crash_or_quit' });
        first.clear();

        // 第二次重启：用户已裁决 → 同一 runId 收口审批并回 live loop。
        const second = env.registry('restart-decided');
        const [plan] = await second.recoverDurable(4_000);
        expect(plan.envelope).toMatchObject({ runId, status: 'waiting' });
        const decided = approvalPorts(decision);
        await expect(new NativeRecoveryHost(second, decided.ports).createHandler().recover(plan, 4_000))
          .resolves.toMatchObject({ status: 'recovered', reason: 'resume_live_loop' });
        expect(decided.continued).toEqual([runId]);
        expect(decided.dispatched).toEqual(decision === 'approved' ? [`approval:${APPROVAL_ID}`] : []);
        expect(decided.rejected).toEqual(decision === 'rejected' ? ['不要写'] : []);
        expect(await env.repository.listPendingOperations(runId)).toEqual([
          expect.objectContaining({ operationId: `approval:${APPROVAL_ID}`, status: decision === 'approved' ? 'succeeded' : 'failed' }),
        ]);
        expect(await env.repository.get(runId)).toMatchObject({ runId, status: 'running' });
        second.clear();
      } finally {
        env.cleanup();
      }
    }
  });

  it('web: a new message keeps the approval-wait conflict (409) without swallowing it, and /api/cancel gives the way out', async () => {
    const env = setup('exhausted-web');
    const runId = 'run-exhausted-web';
    const sessionId = 'session-exhausted-web';
    let server: http.Server | undefined;
    try {
      await seedExhaustedApprovalRun(env, runId, sessionId);
      const { registry } = env.restart('exhausted-web-restart');
      await registry.recoverDurable(2_000);
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const newMessage = () => createAgentDurableRouteRunLifecycle({
        runRegistry: registry, sessionId, workspace: env.workspace, durableActivation: true, logger,
      }).start();

      // 新消息：等审批 waiting 不让位（修订二），仍是会话冲突 → web 路由回 409；待审批 op 原样保留。
      await expect(newMessage()).rejects.toBeInstanceOf(RunSessionConflictError);
      expect(await env.repository.get(runId)).toMatchObject({ status: 'waiting', interruptCause: 'crash_or_quit' });
      expect(await env.repository.listPendingOperations(runId)).toEqual([expect.objectContaining({ kind: 'approval', status: 'waiting' })]);

      // 出路：「放弃」走真实 web /api/cancel 路由，把本进程认领的等审批 run 收尾。
      const app = express();
      app.use(express.json());
      const router = express.Router();
      registerAgentCancelRoute(router, registry);
      app.use('/api', router);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
      });
      expect(await response.json()).toMatchObject({ message: 'Cancelled', runId, sessionId });
      expect(await env.repository.get(runId)).toMatchObject({ status: 'cancelled' });

      const next = await newMessage();
      expect(next.runHandle.context.sessionId).toBe(sessionId);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      env.cleanup();
    }
  });
});

describe('ADR-075 修订三 ②：恢复后成功推进一轮即清零自动续跑计数', () => {
  /** 首个进程：建 run，派发一次模型调用后「崩溃」。 */
  async function seedCrashedRun(env: Env, runId: string, sessionId: string) {
    const first = env.registry(`${runId}-first`);
    await first.startDurable({ runId, sessionId, workspace: env.workspace, cwd: env.workspace }, 1_000);
    await first.checkpointNativeModelOperation({
      runId, sourceMessageId: 'message-source', provider: 'provider', model: 'model',
      logicalOperationId: 'turn-0', phase: 'after_model_dispatch', status: 'dispatched', now: 1_010,
    });
    first.clear();
  }

  it.each(['model', 'tool', 'none'] as const)('progress=%s after each auto-resume decides whether the 3rd crash still auto-resumes', async (progress) => {
    const env = setup(`budget-reset-${progress}`);
    const runId = `run-reset-${progress}`;
    const sessionId = `session-reset-${progress}`;
    try {
      await seedCrashedRun(env, runId, sessionId);
      const observed: Array<[string, number | undefined, boolean | undefined]> = [];
      for (let crash = 1; crash <= MAX_AUTO_RESUME_COUNT + 1; crash += 1) {
        const now = crash * 10_000;
        const registry = env.registry(`reset-restart-${crash}`);
        const [plan] = await registry.recoverDurable(now);
        observed.push([plan.envelope.status, plan.envelope.autoResumeCount, plan.resumeBlocked]);
        if (plan.resumeBlocked) { registry.clear(); break; }
        registry.adoptRecoveredRun({ runId, sessionId, workspace: env.workspace, cwd: env.workspace });
        // 恢复后派发（不算进展）：计数保持本次认领时的值。
        await registry.checkpointNativeModelOperation({
          runId, sourceMessageId: 'message-source', provider: 'provider', model: 'model',
          logicalOperationId: `turn-${crash}`, phase: 'after_model_dispatch', status: 'dispatched', now: now + 1,
        });
        expect((await env.repository.get(runId))?.autoResumeCount).toBe(plan.envelope.autoResumeCount);
        if (progress === 'model') {
          await registry.checkpointNativeModelOperation({
            runId, sourceMessageId: 'message-source', provider: 'provider', model: 'model',
            logicalOperationId: `turn-${crash}`, phase: 'after_model_dispatch', status: 'succeeded', now: now + 2,
          });
        } else if (progress === 'tool') {
          for (const status of ['dispatched', 'succeeded'] as const) {
            await registry.checkpointNativeToolOperation({
              runId, sourceMessageId: 'message-source', toolName: 'Read', logicalOperationId: `read-${crash}`,
              providerOperationId: `exec-${crash}`, sideEffect: false, status, now: now + 2,
            });
          }
        }
        expect((await env.repository.get(runId))?.autoResumeCount).toBe(progress === 'none' ? Math.min(crash, MAX_AUTO_RESUME_COUNT) : 0);
        registry.clear(); // 再次崩溃
      }
      expect(observed).toEqual(progress === 'none'
        ? [['recovering', 1, undefined], ['recovering', 2, undefined], ['waiting', MAX_AUTO_RESUME_COUNT, true]]
        : [['recovering', 1, undefined], ['recovering', 1, undefined], ['recovering', 1, undefined]]);
    } finally {
      env.cleanup();
    }
  });
});
