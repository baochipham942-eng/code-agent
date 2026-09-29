import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { assembleDurableRun } from '../../../../src/host/app/initializeDurableRun';
import { projectDurableRunToSessionPayload } from '../../../../src/host/app/durableRunReadService';
import { continueParkedDurableRun } from '../../../../src/host/app/durableRunContinuation';
import { MAX_AUTO_RESUME_COUNT, type PendingOperation, type RunInterruptCause } from '../../../../src/shared/contract/durableRun';

/**
 * ADR-075 修订二（2026-09-29）：
 * ① 崩溃预算耗尽的停靠在数据上显式记 budget_exhausted，每次重启都按标记重新认领、出「继续」；
 *    等审批的 crash_or_quit waiting（计数多少都一样）两次重启后仍不被当停靠、不被新消息终态化。
 * ② guard_halt 经模态确认后的「继续」把未决工具 op 收口为 abandoned，这一轮能写入 completed；
 *    其它原因的「继续」不动工具 op（K2 未知写不重放）。
 * 全部走真实 SQLite 仓库 + 真实 RunRegistry + 真实 continueParkedDurableRun（web /api/continue 同一实现）。
 */

const SOURCE_MESSAGE_ID = 'message-source';

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

function op(runId: string, patch: Partial<PendingOperation>): PendingOperation {
  return {
    runId, operationId: 'op', attempt: 1, kind: 'tool_call', status: 'unknown',
    idempotencyKey: `key-${patch.operationId ?? 'op'}`, sideEffect: true, preparedAt: 1_005, updatedAt: 1_005, ...patch,
  };
}

/** 首个进程：建 run、记下源消息（「继续」需要），再以给定状态/原因/计数/未决 op 落盘后「崩溃」。 */
async function seedRun(
  env: ReturnType<typeof setup>,
  input: { runId: string; sessionId: string; status: 'running' | 'waiting'; cause: RunInterruptCause; count: number; extraOps?: PendingOperation[] },
) {
  const first = env.registry(`${input.runId}-first`);
  await first.startDurable({ runId: input.runId, sessionId: input.sessionId, workspace: env.workspace, cwd: env.workspace }, 1_000);
  await first.checkpointNativeModelOperation({
    runId: input.runId, sourceMessageId: SOURCE_MESSAGE_ID, provider: 'provider', model: 'model',
    logicalOperationId: `turn-${input.runId}`, phase: 'after_model_dispatch', status: 'dispatched', now: 1_010,
  });
  await first.checkpointDurable(input.runId, {
    now: 1_020, status: input.status, state: first.getDurableCheckpointState(input.runId),
    pendingOperations: [...(first.getDurableEnvelope(input.runId)?.pendingOperations ?? []), ...(input.extraOps ?? [])],
    childRuns: [], interruptCause: input.cause, autoResumeCount: input.count,
    events: [{ type: 'run_checkpointed', payload: {}, recordedAt: 1_020 }],
  });
  first.clear();
}

async function continueRun(registry: RunRegistry, sessionId: string, workspace: string) {
  const adopted: string[] = [];
  const result = await continueParkedDurableRun({
    sessionId,
    runRegistry: registry,
    taskManager: {
      getSessionState: () => undefined,
      resumeExistingDurableRun: async (_sessionId: string, runId: string) => {
        adopted.push(registry.adoptRecoveredRun({ runId, sessionId, workspace, cwd: workspace }).context.runId);
      },
    } as never,
    getMessages: async () => [{ id: SOURCE_MESSAGE_ID, role: 'user', content: 'go', timestamp: 1 } as never],
  });
  return { result, adopted };
}

async function completeTurn(registry: RunRegistry, runId: string, sessionId: string, now: number) {
  return registry.terminalDurable(runId, {
    now, status: 'completed', reason: 'turn_completed',
    event: { type: 'run_completed', payload: { sessionId }, recordedAt: now },
  });
}

describe('ADR-075 修订二：预算耗尽停靠标记', () => {
  it('parks an exhausted crash run as budget_exhausted, reclaims it on every restart, and Continue reaches completed', async () => {
    const env = setup('budget-exhausted');
    const runId = 'run-exhausted';
    const sessionId = 'session-exhausted';
    try {
      await seedRun(env, { runId, sessionId, status: 'running', cause: 'crash_or_quit', count: MAX_AUTO_RESUME_COUNT });
      for (const [index, now] of [2_000, 4_000].entries()) {
        const { registry, readService } = env.restart(`exhausted-restart-${index}`);
        const plans = await registry.recoverDurable(now);
        expect(plans.map((plan) => [plan.envelope.runId, plan.envelope.status, plan.envelope.interruptCause, plan.resumeBlocked]))
          .toEqual([[runId, 'waiting', 'budget_exhausted', true]]);
        expect(await env.repository.get(runId)).toMatchObject({ status: 'waiting', interruptCause: 'budget_exhausted', interrupt_cause: 'budget_exhausted' });
        const view = await readService.readSessionReplay(sessionId, () => ({ status: 'idle' }));
        expect(projectDurableRunToSessionPayload(view).durableResume)
          .toMatchObject({ runId, mode: 'continue', interruptCause: 'budget_exhausted', canContinue: true });
        if (index === 0) { registry.clear(); continue; }

        const { result, adopted } = await continueRun(registry, sessionId, env.workspace);
        expect(result).toEqual({ runId });
        expect(adopted).toEqual([runId]);
        await completeTurn(registry, runId, sessionId, now + 10);
        expect(await env.repository.get(runId)).toMatchObject({ status: 'completed' });
      }
    } finally {
      env.cleanup();
    }
  });

  const approvalWaiting: Array<[string, number, PendingOperation[]]> = [
    ['crash 且预算未耗尽 + 待人工确认的未知写', MAX_AUTO_RESUME_COUNT - 1, [op('run-approval', { operationId: 'tool:unknown', status: 'unknown', requiresHumanConfirmation: true })]],
    ['crash 预算未耗尽 + 审批 pending', MAX_AUTO_RESUME_COUNT - 1, [op('run-approval', { operationId: 'approval-1', kind: 'approval', status: 'waiting', sideEffect: false })]],
    ['crash 计数耗尽 + 审批 pending（预算耗尽后又等审批）', MAX_AUTO_RESUME_COUNT, [op('run-approval', { operationId: 'approval-1', kind: 'approval', status: 'waiting', sideEffect: false })]],
  ];
  it.each(approvalWaiting)('approval-waiting run (%s) is never reclaimed as parked nor superseded across two restarts', async (_label, count, extraOps) => {
    const env = setup('approval-waiting');
    const runId = 'run-approval';
    const sessionId = 'session-approval';
    try {
      await seedRun(env, { runId, sessionId, status: 'waiting', cause: 'crash_or_quit', count, extraOps });
      for (const [index, now] of [2_000, 4_000].entries()) {
        env.repository.migrate(); // 每次开库都会跑的存量兼容迁移，也不得碰它
        const { registry, readService } = env.restart(`approval-restart-${index}`);
        const plans = await registry.recoverDurable(now);
        expect(plans.every((plan) => plan.resumeBlocked !== true)).toBe(true);
        const view = await readService.readSessionReplay(sessionId, () => ({ status: 'idle' }));
        expect(projectDurableRunToSessionPayload(view).durableResume?.mode).not.toBe('continue');
        await registry.supersedeParkedSessionRoots(sessionId, now + 5);
        expect(await env.repository.get(runId)).toMatchObject({ status: 'waiting', interruptCause: 'crash_or_quit' });
        registry.clear();
      }
    } finally {
      env.cleanup();
    }
  });

  it('migrates legacy exhausted parks (crash_or_quit waiting, count exhausted, no approval) to budget_exhausted so the next restart reclaims them', async () => {
    const env = setup('legacy-park');
    try {
      // 旧版本停靠形状：waiting + crash_or_quit + 计数耗尽，无审批 op。
      await seedRun(env, { runId: 'run-legacy', sessionId: 'session-legacy', status: 'waiting', cause: 'crash_or_quit', count: MAX_AUTO_RESUME_COUNT });
      expect(await env.repository.get('run-legacy')).toMatchObject({ interruptCause: 'crash_or_quit' });
      env.repository.migrate();
      expect(await env.repository.get('run-legacy')).toMatchObject({ status: 'waiting', interruptCause: 'budget_exhausted', interrupt_cause: 'budget_exhausted' });
      const { registry, readService } = env.restart('legacy-restart');
      const plans = await registry.recoverDurable(2_000);
      expect(plans.map((plan) => [plan.envelope.runId, plan.resumeBlocked])).toEqual([['run-legacy', true]]);
      const view = await readService.readSessionReplay('session-legacy', () => ({ status: 'idle' }));
      expect(projectDurableRunToSessionPayload(view).durableResume).toMatchObject({ mode: 'continue', canContinue: true });
    } finally {
      env.cleanup();
    }
  });
});

describe('ADR-075 修订二：guard_halt 确认继续收口工具 op', () => {
  const toolOrder = ['tool:prepared', 'tool:dispatched', 'tool:unknown', 'tool:done'];
  const toolOps = (runId: string) => [
    op(runId, { operationId: 'tool:prepared', status: 'prepared' }),
    op(runId, { operationId: 'tool:dispatched', status: 'dispatched' }),
    op(runId, { operationId: 'tool:unknown', status: 'unknown', requiresHumanConfirmation: true }),
    op(runId, { operationId: 'tool:done', status: 'succeeded', resultRef: 'done' }),
  ];

  it('guarded Continue abandons unresolved tool ops and the continued turn commits completed', async () => {
    const env = setup('guard-halt');
    const runId = 'run-guard';
    const sessionId = 'session-guard';
    try {
      await seedRun(env, { runId, sessionId, status: 'waiting', cause: 'guard_halt', count: 1, extraOps: toolOps(runId) });
      const { registry } = env.restart('guard-restart');
      expect((await registry.recoverDurable(2_000)).map((plan) => plan.resumeBlocked)).toEqual([true]);
      await continueRun(registry, sessionId, env.workspace);
      const tools = (await env.repository.listPendingOperations(runId)).filter((o) => o.kind === 'tool_call')
        .sort((a, b) => toolOrder.indexOf(a.operationId) - toolOrder.indexOf(b.operationId));
      expect(tools.map((o) => [o.operationId, o.status, o.resultRef])).toEqual([
        ['tool:prepared', 'abandoned', 'tool-recovery:superseded-by-guarded-continue:tool:prepared'],
        ['tool:dispatched', 'abandoned', 'tool-recovery:superseded-by-guarded-continue:tool:dispatched'],
        ['tool:unknown', 'abandoned', 'tool-recovery:superseded-by-guarded-continue:tool:unknown'],
        ['tool:done', 'succeeded', 'done'],
      ]);
      await completeTurn(registry, runId, sessionId, 2_100);
      expect(await env.repository.get(runId)).toMatchObject({ status: 'completed' });
    } finally {
      env.cleanup();
    }
  });

  it.each(['user_stop', 'budget_exhausted'] as const)('Continue after %s leaves tool ops untouched (unknown writes are never silently settled)', async (cause) => {
    const env = setup(`continue-${cause}`);
    const runId = `run-${cause}`;
    const sessionId = `session-${cause}`;
    try {
      await seedRun(env, { runId, sessionId, status: 'waiting', cause, count: 1, extraOps: toolOps(runId) });
      const { registry } = env.restart(`${cause}-restart`);
      await registry.recoverDurable(2_000);
      await continueRun(registry, sessionId, env.workspace);
      const tools = (await env.repository.listPendingOperations(runId)).filter((o) => o.kind === 'tool_call')
        .sort((a, b) => toolOrder.indexOf(a.operationId) - toolOrder.indexOf(b.operationId));
      expect(tools.map((o) => [o.operationId, o.status])).toEqual([
        ['tool:prepared', 'prepared'], ['tool:dispatched', 'dispatched'], ['tool:unknown', 'unknown'], ['tool:done', 'succeeded'],
      ]);
      await expect(completeTurn(registry, runId, sessionId, 2_100)).rejects.toThrow('completed runs cannot contain unresolved operations');
    } finally {
      env.cleanup();
    }
  });
});
