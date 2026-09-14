// ============================================================================
// N-LOOP-DURABLE-K2 刀2-b：loop durable 账本 + 收口版恢复
// - begin 落 running 行；每轮双 checkpoint；finalize 先收 op 再 terminal
// - heartbeat fence 后停写；长 sleep 心跳不停不被 sweeper 误收
// - 残留 running → interrupted_by_restart 收口 + 投影一次
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => null }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  LOOP_DURABLE_PARENT_MISSING_CODE,
  LOOP_INTERRUPTED_REASON,
  LoopDurableLedger,
  armLoopDurableLedger,
  configureLoopDurableLedger,
  resetLoopDurableLedger,
  waitForLoopDurableLedger,
  type LoopEngineCursor,
} from '../../../src/host/loop/loopDurableLedger';
import { LoopController } from '../../../src/host/loop/loopController';
import { createLoopRecoveryHandler } from '../../../src/host/loop/loopRecoveryHandler';
import { DurableRunKernel, DurableRunPersistenceUnavailableError } from '../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../src/host/task/backgroundTaskLedger';
import { getApplicationRunRegistry, resetApplicationRunRegistryForTests } from '../../../src/host/app/applicationRunRegistry';

const orchestratorState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => orchestratorState,
  }),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: vi.fn().mockResolvedValue({
      messages: [{ id: 'a1', role: 'assistant', content: '检查中', timestamp: 2 }],
    }),
  }),
}));

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: vi.fn() },
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
  }),
}));

function createStack(processInstanceId = 'process-1', leaseDurationMs = 60_000) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  const kernel = new DurableRunKernel({
    stores: repository,
    ownerId: 'native-host',
    processInstanceId,
    leaseDurationMs,
  });
  const ledger = new LoopDurableLedger(kernel);
  return { db, repository, kernel, ledger };
}

function cursor(partial: Partial<LoopEngineCursor> & Pick<LoopEngineCursor, 'turn' | 'phase'>): LoopEngineCursor {
  return {
    schemaVersion: 1,
    kind: 'loop',
    config: { prompt: '盯构建', maxTurns: 5 },
    ...partial,
  };
}

describe('Loop durable ledger (N-LOOP-DURABLE-K2 刀2-b)', () => {
  beforeEach(() => {
    resetLoopDurableLedger();
    resetBackgroundTaskLedgerForTest();
    resetApplicationRunRegistryForTests();
    orchestratorState.sendMessage.mockReset();
    orchestratorState.sendMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetLoopDurableLedger();
    resetBackgroundTaskLedgerForTest();
    resetApplicationRunRegistryForTests();
    vi.useRealTimers();
  });

  it('begin 落 running 行：engine_kind=loop，parentRunId 必带，cursor turn=0', async () => {
    const { db, repository, ledger } = createStack();
    await ledger.begin({
      loopId: 'loop_begin',
      sessionId: 'session-loop',
      parentRunId: 'run-parent',
      config: { prompt: '盯构建', maxTurns: 5 },
      startedAt: 1_000,
    });

    const envelope = (await repository.get('loop_begin'))!;
    expect(envelope).toMatchObject({
      runId: 'loop_begin',
      sessionId: 'session-loop',
      parentRunId: 'run-parent',
      engine: { kind: 'loop' },
      status: 'running',
      attempt: 1,
    });
    expect(envelope.cursor.engineCursor).toMatchObject({
      schemaVersion: 1,
      kind: 'loop',
      turn: 0,
      phase: 'sleeping',
    });
    expect(envelope.pendingOperations ?? []).toEqual([]);
    ledger.dispose();
    db.close();
  });

  it('每轮双 checkpoint：dispatch 前 dispatched，reply 后 succeeded 且 turn/nextRunAt 推进', async () => {
    const { db, repository, ledger } = createStack();
    await ledger.begin({
      loopId: 'loop_turns',
      sessionId: 'session-loop',
      parentRunId: 'run-parent',
      config: { prompt: '盯构建', maxTurns: 5 },
      startedAt: 1_000,
    });

    await ledger.turnDispatched('loop_turns', {
      turn: 1,
      cursor: cursor({ turn: 0, phase: 'dispatching' }),
    });
    const dispatched = (await repository.get('loop_turns'))!;
    expect(dispatched.pendingOperations).toHaveLength(1);
    expect(dispatched.pendingOperations![0]).toMatchObject({
      operationId: 'loop-turn-1',
      kind: 'model_call',
      status: 'dispatched',
      sideEffect: true,
    });
    expect(dispatched.cursor.engineCursor).toMatchObject({ turn: 0, phase: 'dispatching' });

    const nextRunAt = Date.now() + 30_000;
    await ledger.turnCompleted('loop_turns', {
      turn: 1,
      cursor: cursor({ turn: 1, phase: 'sleeping', nextRunAt }),
      waitMs: 30_000,
    });
    const completed = (await repository.get('loop_turns'))!;
    expect(completed.pendingOperations![0]).toMatchObject({
      operationId: 'loop-turn-1',
      status: 'succeeded',
    });
    expect(completed.cursor.engineCursor).toMatchObject({
      turn: 1,
      phase: 'sleeping',
      nextRunAt,
    });
    const checkpoint = await repository.getLatest('loop_turns');
    expect(checkpoint?.state).toMatchObject({ turn: 1, phase: 'sleeping' });
    ledger.dispose();
    db.close();
  });

  it('finalize 先收 op 再 terminal completed', async () => {
    const { db, repository, ledger } = createStack();
    await ledger.begin({
      loopId: 'loop_done',
      sessionId: 'session-loop',
      parentRunId: 'run-parent',
      config: { prompt: '盯构建', maxTurns: 1 },
      startedAt: 1_000,
    });
    await ledger.turnDispatched('loop_done', {
      turn: 1,
      cursor: cursor({ turn: 0, phase: 'dispatching' }),
    });
    await ledger.finalize('loop_done', {
      outcome: 'completed',
      reason: 'condition_met',
      turn: 1,
      cursor: cursor({ turn: 1, phase: 'sleeping' }),
      finishedAt: Date.now(),
    });

    const envelope = (await repository.get('loop_done'))!;
    expect(envelope.status).toBe('completed');
    expect(envelope.terminal).toMatchObject({ status: 'completed', reason: 'condition_met' });
    expect(envelope.pendingOperations![0]).toMatchObject({ status: 'succeeded' });
    ledger.dispose();
    db.close();
  });

  it('heartbeat fence 后停写：认领后原账本 turnDispatched 不再改行', async () => {
    const { db, repository, ledger } = createStack('process-1', 1_000);
    await ledger.begin({
      loopId: 'loop_fence',
      sessionId: 'session-loop',
      parentRunId: 'run-parent',
      config: { prompt: '盯构建', maxTurns: 5 },
      startedAt: Date.now(),
    });

    const kernel2 = new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: 'process-2',
      leaseDurationMs: 1_000,
    });
    const recoveredRegistry = new RunRegistry();
    recoveredRegistry.configureDurableKernel(kernel2);
    const crashedAt = Date.now() + 120_000;
    const plans = await recoveredRegistry.recoverDurable(crashedAt);
    expect(plans).toHaveLength(1);

    await ledger.turnDispatched('loop_fence', {
      turn: 1,
      cursor: cursor({ turn: 0, phase: 'dispatching' }),
    });
    const after = (await repository.get('loop_fence'))!;
    expect(after.attempt).toBe(2);
    expect(after.pendingOperations ?? []).toEqual([]);
    ledger.dispose();
    recoveredRegistry.clear();
    db.close();
  });

  it('长 sleep 心跳不停，sweeper 不会误收', async () => {
    const { db, repository, ledger } = createStack('process-1', 800);
    await ledger.begin({
      loopId: 'loop_sleep',
      sessionId: 'session-loop',
      parentRunId: 'run-parent',
      config: { prompt: '盯构建', maxTurns: 5, intervalMs: 3_600_000 },
      startedAt: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await repository.get('loop_sleep'))?.status).toBe('running');

    const kernel2 = new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: 'process-2',
      leaseDurationMs: 800,
    });
    const recoveredRegistry = new RunRegistry();
    recoveredRegistry.configureDurableKernel(kernel2);
    expect(await recoveredRegistry.recoverDurable(Date.now())).toEqual([]);
    ledger.dispose();
    recoveredRegistry.clear();
    db.close();
  });

  it('残留 running 行被启动恢复收口成 interrupted_by_restart，投影一次', async () => {
    const { db, repository, ledger } = createStack('process-1');
    await ledger.begin({
      loopId: 'loop_crash',
      sessionId: 'session-crash',
      parentRunId: 'run-parent-crash',
      config: { prompt: '崩溃时还在跑', maxTurns: 8 },
      startedAt: Date.now(),
    });

    const kernel2 = new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: 'process-2',
      leaseDurationMs: 60_000,
    });
    const recoveredRegistry = new RunRegistry();
    recoveredRegistry.configureDurableKernel(kernel2);
    const crashedAt = Date.now() + 120_000;
    const plans = await recoveredRegistry.recoverDurable(crashedAt);
    expect(plans).toHaveLength(1);

    const handler = createLoopRecoveryHandler({ registry: recoveredRegistry });
    const outcome = await handler.recover(plans[0], crashedAt);
    expect(outcome).toMatchObject({ status: 'recovered', reason: LOOP_INTERRUPTED_REASON });

    const closed = (await repository.get('loop_crash'))!;
    expect(closed.status).toBe('failed');
    expect(closed.terminal?.reason).toBe(LOOP_INTERRUPTED_REASON);

    const drained = getBackgroundTaskLedger().drainNotifications('session-crash');
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      id: 'loop_crash:lost',
      taskId: 'loop_crash',
      type: 'task_failed',
    });

    expect(await recoveredRegistry.recoverDurable(crashedAt + 120_000)).toEqual([]);
    expect(getBackgroundTaskLedger().drainNotifications('session-crash')).toEqual([]);
    ledger.dispose();
    recoveredRegistry.clear();
    db.close();
  });

  it('legacy 模式（未 arm 未 configure）：LoopController 纯内存，不写 durable 行', async () => {
    const { db, repository } = createStack();
    const controller = new LoopController();
    const state = await controller.start({
      sessionId: 'session-legacy',
      prompt: 'legacy',
      maxTurns: 1,
    });
    expect(state.durable).toBe(false);
    expect(await repository.get(state.id)).toBeNull();
    db.close();
  });

  it('--ephemeral 不落账（即使 armed）', async () => {
    const { db, repository, ledger } = createStack();
    armLoopDurableLedger();
    configureLoopDurableLedger(ledger);
    const controller = new LoopController();
    const state = await controller.start({
      sessionId: 'session-eph',
      prompt: 'ephemeral',
      maxTurns: 1,
      durable: false,
    });
    expect(state.durable).toBe(false);
    expect(await repository.get(state.id)).toBeNull();
    db.close();
  });

  it('parentRunId 取不到时 durable 模式拒绝启动', async () => {
    const { db, ledger } = createStack();
    armLoopDurableLedger();
    configureLoopDurableLedger(ledger);
    const controller = new LoopController();
    await expect(controller.start({
      sessionId: 'session-empty',
      prompt: 'no parent',
      maxTurns: 1,
    })).rejects.toMatchObject({ code: LOOP_DURABLE_PARENT_MISSING_CODE });
    db.close();
  });

  it('durable 模式有前台 run 时 start 先落账再进 runLoop', async () => {
    const { db, repository, ledger } = createStack();
    armLoopDurableLedger();
    configureLoopDurableLedger(ledger);
    getApplicationRunRegistry().start({
      runId: 'run-fg',
      sessionId: 'session-fg',
      workspace: '/tmp',
      cwd: '/tmp',
    });
    const controller = new LoopController();
    const state = await controller.start({
      sessionId: 'session-fg',
      prompt: '盯构建',
      maxTurns: 1,
    });
    expect(state.durable).toBe(true);
    const envelope = (await repository.get(state.id))!;
    expect(envelope).toMatchObject({
      engine: { kind: 'loop' },
      parentRunId: 'run-fg',
      status: 'running',
    });
    await vi.waitFor(async () => {
      expect((await repository.get(state.id))?.status).not.toBe('running');
    });
    db.close();
  });

  it('waitForLoopDurableLedger：configure 后 resolve，超时 reject', async () => {
    vi.useFakeTimers();
    armLoopDurableLedger();
    const { db, ledger } = createStack();
    const pending = waitForLoopDurableLedger(5_000);
    configureLoopDurableLedger(ledger);
    await expect(pending).resolves.toBe(ledger);

    resetLoopDurableLedger();
    armLoopDurableLedger();
    const timedOut = waitForLoopDurableLedger(5_000);
    const assertion = expect(timedOut).rejects.toBeInstanceOf(DurableRunPersistenceUnavailableError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    db.close();
  });
});
