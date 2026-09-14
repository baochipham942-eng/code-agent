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

const sessionState = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => orchestratorState,
  }),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: sessionState.getSession,
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
    sessionState.getSession.mockReset();
    sessionState.getSession.mockResolvedValue({
      messages: [{ id: 'a1', role: 'assistant', content: '检查中', timestamp: 2 }],
    });
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

  it('fence（被认领）后原账本 turnDispatched 上抛停写，行不被改动', async () => {
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

    // 租约已易主：checkpoint 被 fence，错误上抛且立刻停写停心跳。
    await expect(ledger.turnDispatched('loop_fence', {
      turn: 1,
      cursor: cursor({ turn: 0, phase: 'dispatching' }),
    })).rejects.toThrow(/fenced|ledger lost/i);
    expect(ledger.isTracked('loop_fence')).toBe(false);
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

  it('checkpoint 持久化失败上抛：loop 立刻收口 failed，一个模型调用都不发', async () => {
    const { db, repository, kernel, ledger } = createStack();
    armLoopDurableLedger();
    configureLoopDurableLedger(ledger);
    getApplicationRunRegistry().start({
      runId: 'run-fg-fail',
      sessionId: 'session-ckpt-fail',
      workspace: '/tmp',
      cwd: '/tmp',
    });
    // begin 走 createRun 不经 checkpoint；这一发打在 turn 1 dispatch 前的落账上
    vi.spyOn(kernel, 'checkpoint').mockRejectedValueOnce(new Error('disk full'));
    const controller = new LoopController();
    const state = await controller.start({
      sessionId: 'session-ckpt-fail',
      prompt: '盯构建',
      maxTurns: 5,
    });

    await vi.waitFor(() => {
      expect(controller.get(state.id)?.status).toBe('failed');
    });
    expect(orchestratorState.sendMessage).not.toHaveBeenCalled();
    expect(controller.get(state.id)?.error).toContain('disk full');
    expect(ledger.isTracked(state.id)).toBe(false);
    const drained = getBackgroundTaskLedger().drainNotifications('session-ckpt-fail');
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ taskId: state.id, type: 'task_failed' });
    // 本进程停写：durable 行留 running，租约到期由 sweeper 收口
    expect((await repository.get(state.id))?.status).toBe('running');
    db.close();
  });

  it('fence：另一进程认领后本进程立刻停写停跑，收口 failed 且不发第二轮', async () => {
    const { db, repository, ledger } = createStack('process-1', 60_000);
    armLoopDurableLedger();
    configureLoopDurableLedger(ledger);
    getApplicationRunRegistry().start({
      runId: 'run-fg-fence',
      sessionId: 'session-fence',
      workspace: '/tmp',
      cwd: '/tmp',
    });
    let releaseTurn: () => void = () => undefined;
    orchestratorState.sendMessage.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseTurn = resolve; }),
    );
    const controller = new LoopController();
    const state = await controller.start({
      sessionId: 'session-fence',
      prompt: '盯构建',
      maxTurns: 5,
    });
    await vi.waitFor(() => {
      expect(orchestratorState.sendMessage).toHaveBeenCalledTimes(1);
    });

    // 另一进程按崩溃恢复视角把 run 认领走（租约早已过期）
    const kernel2 = new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: 'process-2',
      leaseDurationMs: 60_000,
    });
    const recoveredRegistry = new RunRegistry();
    recoveredRegistry.configureDurableKernel(kernel2);
    const plans = await recoveredRegistry.recoverDurable(Date.now() + 120_000);
    expect(plans).toHaveLength(1);
    expect((await repository.get(state.id))?.attempt).toBe(2);

    releaseTurn();
    await vi.waitFor(() => {
      expect(controller.get(state.id)?.status).toBe('failed');
    });
    expect(controller.get(state.id)?.error).toMatch(/fenced|ledger lost/i);
    expect(orchestratorState.sendMessage).toHaveBeenCalledTimes(1);
    // 本进程停写：行归新 owner（认领后等待调度=waiting），attempt 停在 2，不替它收口
    const after = (await repository.get(state.id))!;
    expect(after.attempt).toBe(2);
    expect(after.status).toBe('waiting');
    expect(after.terminal).toBeUndefined();
    recoveredRegistry.clear();
    db.close();
  });

  it('心跳失联（账本丢失）后下一轮 checkpoint 上抛 LedgerLost，loop 收口 failed', async () => {
    const { db, kernel, ledger } = createStack('process-1', 900);
    armLoopDurableLedger();
    configureLoopDurableLedger(ledger);
    getApplicationRunRegistry().start({
      runId: 'run-fg-lost',
      sessionId: 'session-lost',
      workspace: '/tmp',
      cwd: '/tmp',
    });
    let releaseTurn: () => void = () => undefined;
    orchestratorState.sendMessage.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseTurn = resolve; }),
    );
    const controller = new LoopController();
    const state = await controller.start({
      sessionId: 'session-lost',
      prompt: '盯构建',
      maxTurns: 5,
    });
    await vi.waitFor(() => {
      expect(orchestratorState.sendMessage).toHaveBeenCalledTimes(1);
    });

    vi.spyOn(kernel, 'heartbeat').mockRejectedValue(new Error('Heartbeat fenced by stale owner'));
    await vi.waitFor(() => {
      expect(ledger.isTracked(state.id)).toBe(false);
    });

    releaseTurn();
    await vi.waitFor(() => {
      expect(controller.get(state.id)?.status).toBe('failed');
    });
    expect(controller.get(state.id)?.error).toContain('Durable ledger lost');
    expect(orchestratorState.sendMessage).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('stop 落在读回复窗口（finalize 先收口）：终态保持 stopped，无 task_failed，台账收口一次', async () => {
    const { db, repository, ledger } = createStack();
    armLoopDurableLedger();
    configureLoopDurableLedger(ledger);
    getApplicationRunRegistry().start({
      runId: 'run-fg-stop',
      sessionId: 'session-stop',
      workspace: '/tmp',
      cwd: '/tmp',
    });
    let releaseReply: (value: unknown) => void = () => undefined;
    sessionState.getSession.mockImplementationOnce(
      () => new Promise((resolve) => { releaseReply = resolve; }),
    );
    const controller = new LoopController();
    const state = await controller.start({
      sessionId: 'session-stop',
      prompt: '盯构建',
      maxTurns: 5,
    });
    // runLoop 已堵在 readLastAssistantReply
    await vi.waitFor(() => {
      expect(sessionState.getSession).toHaveBeenCalledTimes(1);
    });

    controller.stop(state.id);
    // finalizeDurable 先完成:durable 行 terminal cancelled,账本 untrack
    await vi.waitFor(async () => {
      expect((await repository.get(state.id))?.status).toBe('cancelled');
    });
    expect(ledger.isTracked(state.id)).toBe(false);

    // 在途 turnCompleted 撞上 untracked 账本 → 抛 LedgerLost → runLoop catch
    // → 终态守卫:保持 stopped,不覆写、不重跑 finalizeTask、不推 task_failed
    releaseReply({ messages: [{ id: 'a1', role: 'assistant', content: '检查中', timestamp: 2 }] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const final = controller.get(state.id)!;
    expect(final.status).toBe('stopped');
    expect(final.stopReason).toBe('user');
    expect(final.error).toBeUndefined();
    expect(getBackgroundTaskLedger().drainNotifications('session-stop')).toEqual([]);
    expect(getBackgroundTaskLedger().getTask(state.id)?.status).toBe('cancelled');
    expect((await repository.get(state.id))?.status).toBe('cancelled');
    db.close();
  });

  it('stop 落在在途 checkpoint 上（并发写被 fence）：终态保持 stopped，无 task_failed', async () => {
    const { db, repository, kernel, ledger } = createStack();
    armLoopDurableLedger();
    configureLoopDurableLedger(ledger);
    getApplicationRunRegistry().start({
      runId: 'run-fg-stop2',
      sessionId: 'session-stop2',
      workspace: '/tmp',
      cwd: '/tmp',
    });
    // 扣住 turnCompleted 的 checkpoint,让 stop() 的 finalize 抢先写
    let releaseHold: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
    let inFlightTurnCompleted: Promise<unknown> | undefined;
    const realCheckpoint = kernel.checkpoint.bind(kernel);
    vi.spyOn(kernel, 'checkpoint').mockImplementation((input) => {
      const isTurnCompleted = input.events?.[0]?.type === 'loop_turn_completed';
      const p = (async () => {
        if (isTurnCompleted) await hold;
        return realCheckpoint(input);
      })();
      if (isTurnCompleted) inFlightTurnCompleted = p;
      return p;
    });
    const controller = new LoopController();
    const state = await controller.start({
      sessionId: 'session-stop2',
      prompt: '盯构建',
      maxTurns: 5,
    });
    await vi.waitFor(() => {
      expect(inFlightTurnCompleted).toBeDefined();
    });

    controller.stop(state.id);
    await vi.waitFor(async () => {
      expect((await repository.get(state.id))?.status).toBe('cancelled');
    });

    // 放行在途 checkpoint:行已被 finalize 收成终态,写被拒(Terminal run cannot checkpoint)上抛
    releaseHold();
    await expect(inFlightTurnCompleted).rejects.toThrow(/fenced|stale|terminal/i);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const final = controller.get(state.id)!;
    expect(final.status).toBe('stopped');
    expect(final.stopReason).toBe('user');
    expect(final.error).toBeUndefined();
    expect(getBackgroundTaskLedger().drainNotifications('session-stop2')).toEqual([]);
    expect(getBackgroundTaskLedger().getTask(state.id)?.status).toBe('cancelled');
    expect(ledger.isTracked(state.id)).toBe(false);
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
