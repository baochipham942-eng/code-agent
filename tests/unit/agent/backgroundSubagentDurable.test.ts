// ============================================================================
// N-BGSPAWN-DURABLE(RQ-101)：spawn_agent(run_in_background=true) 的 durable 账本
// - spawn/adopt 落 durable_runs 行 + dispatched child_run pending operation
// - 完成/失败/取消 → checkpoint 收 operation + terminal
// - 模拟崩溃后启动恢复：残留 running 收口成 interrupted_by_restart 终态，
//   父会话经 SubagentCompletionRecord 管道收到中断事实
// - legacy（未 arm 未 configure）模式纯内存不回归；armed 但账本不就绪 fail-closed
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const { scheduleIdleWakeMock } = vi.hoisted(() => ({
  scheduleIdleWakeMock: vi.fn(),
}));

// 收口后的 idle wake 会经 TaskManager 真的唤醒父会话——单测里钉住调度入口即可，
// 唤醒行为本身由 backgroundSubagentIdleWake.test.ts 覆盖。
vi.mock('../../../src/host/agent/backgroundSubagentIdleWake', () => ({
  scheduleBackgroundSubagentIdleWake: scheduleIdleWakeMock,
}));

import {
  BackgroundSubagentRegistry,
  getBackgroundSubagentRegistry,
} from '../../../src/host/agent/backgroundSubagentRegistry';
import {
  BACKGROUND_SUBAGENT_INTERRUPTED_REASON,
  BackgroundSubagentDurableLedger,
  armBackgroundSubagentDurableLedger,
  configureBackgroundSubagentDurableLedger,
  resetBackgroundSubagentDurableLedger,
  waitForBackgroundSubagentDurableLedger,
} from '../../../src/host/agent/backgroundSubagentDurableLedger';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';
import { createBackgroundSubagentRecoveryHandler } from '../../../src/host/runtime/durableRecoveryHandlers';
import { DurableRunKernel, DurableRunPersistenceUnavailableError } from '../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeResult(output: string, extra: Partial<SubagentResult> = {}): SubagentResult {
  return { success: true, output, toolsUsed: [], iterations: 1, ...extra };
}

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
  const ledger = new BackgroundSubagentDurableLedger(kernel);
  return { db, repository, kernel, ledger };
}

describe('BackgroundSubagent durable ledger (N-BGSPAWN-DURABLE)', () => {
  beforeEach(() => {
    resetBackgroundSubagentDurableLedger();
  });

  afterEach(() => {
    resetBackgroundSubagentDurableLedger();
    vi.useRealTimers();
  });

  it('spawn 落账：durable_runs 出现 running 行 + dispatched child_run operation（幂等键稳定）', async () => {
    const { db, repository, ledger } = createStack();
    configureBackgroundSubagentDurableLedger(ledger);
    const reg = new BackgroundSubagentRegistry();
    const d = deferred<SubagentResult>();

    const agentId = reg.spawn(() => d.promise, {
      sessionId: 'session-bg',
      runId: 'run-parent',
      treeId: 'tree-bg',
      title: '后台调研',
      role: 'explore',
    });

    expect(agentId).toMatch(/^subagent-bg-/);
    await vi.waitFor(async () => {
      expect(await repository.get(agentId)).not.toBeNull();
    });
    const envelope = (await repository.get(agentId))!;
    expect(envelope).toMatchObject({
      runId: agentId,
      sessionId: 'session-bg',
      parentRunId: 'run-parent',
      engine: { kind: 'subagent_single' },
      status: 'running',
      attempt: 1,
    });
    expect(envelope.cursor.engineCursor).toMatchObject({
      schemaVersion: 1,
      kind: 'background_subagent_single',
      title: '后台调研',
      role: 'explore',
      treeId: 'tree-bg',
    });
    expect(envelope.pendingOperations).toHaveLength(1);
    expect(envelope.pendingOperations![0]).toMatchObject({
      runId: agentId,
      operationId: 'background-execution',
      kind: 'child_run',
      status: 'dispatched',
      sideEffect: true,
    });
    expect(envelope.pendingOperations![0].idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });

  it('完成时 terminal completed：operation 收 succeeded，成本落 checkpoint state，通知带 cost', async () => {
    const { db, repository, ledger } = createStack();
    configureBackgroundSubagentDurableLedger(ledger);
    const reg = new BackgroundSubagentRegistry();

    const agentId = reg.spawn(async () => fakeResult('done', { cost: 0.42, tokensUsed: 1234 }), {
      sessionId: 'session-bg',
      runId: 'run-parent',
      title: '付费任务',
    });

    const result = await reg.await(agentId);
    expect(result?.success).toBe(true);

    const envelope = (await repository.get(agentId))!;
    expect(envelope.status).toBe('completed');
    expect(envelope.terminal).toMatchObject({ status: 'completed' });
    expect(envelope.pendingOperations![0]).toMatchObject({ status: 'succeeded' });
    const checkpoint = await repository.getLatest(agentId);
    expect(checkpoint?.state).toMatchObject({ outcome: 'completed', cost: 0.42, tokensUsed: 1234 });

    const [record] = reg.drainCompletionNotifications({ sessionId: 'session-bg' });
    expect(record.content).toContain('"cost": 0.42');
    db.close();
  });

  it('失败时 terminal failed，operation 收 failed', async () => {
    const { db, repository, ledger } = createStack();
    configureBackgroundSubagentDurableLedger(ledger);
    const reg = new BackgroundSubagentRegistry();

    const agentId = reg.spawn(async () => ({
      success: false,
      output: '',
      error: 'budget exhausted',
      toolsUsed: [],
      iterations: 3,
      cost: 0.1,
      failureCode: AgentFailureCode.BudgetExhausted,
    }), { sessionId: 'session-bg', runId: 'run-parent' });

    await reg.await(agentId);
    const envelope = (await repository.get(agentId))!;
    expect(envelope.status).toBe('failed');
    expect(envelope.terminal?.reason).toBe('budget exhausted');
    expect(envelope.pendingOperations![0]).toMatchObject({ status: 'failed' });
    db.close();
  });

  it('取消时 terminal cancelled，operation 收 abandoned', async () => {
    const { db, repository, ledger } = createStack();
    configureBackgroundSubagentDurableLedger(ledger);
    const reg = new BackgroundSubagentRegistry();

    const agentId = reg.spawn(async () => ({
      success: false,
      output: '',
      error: 'cancelled',
      toolsUsed: [],
      iterations: 1,
      failureCode: AgentFailureCode.CancelledByUser,
    }), { sessionId: 'session-bg', runId: 'run-parent' });

    await reg.await(agentId);
    const envelope = (await repository.get(agentId))!;
    expect(envelope.status).toBe('cancelled');
    expect(envelope.pendingOperations![0]).toMatchObject({ status: 'abandoned' });
    db.close();
  });

  it('adopt（前台转后台）同样落账并收终态', async () => {
    const { db, repository, ledger } = createStack();
    configureBackgroundSubagentDurableLedger(ledger);
    const reg = new BackgroundSubagentRegistry();
    const d = deferred<SubagentResult>();

    reg.adopt(d.promise, {
      agentId: 'agent-coder-adopted',
      sessionId: 'session-adopt',
      runId: 'run-parent',
      role: 'coder',
    });

    await vi.waitFor(async () => {
      expect((await repository.get('agent-coder-adopted'))?.status).toBe('running');
    });
    d.resolve(fakeResult('adopted done', { cost: 0.01 }));
    await reg.await('agent-coder-adopted');
    expect((await repository.get('agent-coder-adopted'))?.status).toBe('completed');
    db.close();
  });

  it('模拟崩溃：残留 running 行被启动恢复收口成 interrupted_by_restart，父会话收到中断通知', async () => {
    // 租约 60s + 真实时钟：进程 1 的 heartbeat（20s 间隔）在测试期间不会触发，
    // 不会把 lease 续期到 recovery 时刻之后（lease 1s 曾因此 flake）。
    const { db, repository, ledger } = createStack('process-1');
    configureBackgroundSubagentDurableLedger(ledger);
    const spawned = new BackgroundSubagentRegistry();
    const neverFinishes = deferred<SubagentResult>();
    const agentId = spawned.spawn(() => neverFinishes.promise, {
      sessionId: 'session-crash',
      runId: 'run-parent-crash',
      treeId: 'tree-crash',
      title: '崩溃时还在跑',
      role: 'coder',
    });
    await vi.waitFor(async () => {
      expect(await repository.get(agentId)).not.toBeNull();
    });

    // 进程 1 崩溃（不调 finalize）；进程 2 用同一库启动，认领过期租约。
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
    expect(plans[0].envelope).toMatchObject({ runId: agentId, attempt: 2 });

    const handler = createBackgroundSubagentRecoveryHandler({ registry: recoveredRegistry });
    const outcome = await handler.recover(plans[0], crashedAt);
    expect(outcome).toMatchObject({ status: 'recovered', reason: BACKGROUND_SUBAGENT_INTERRUPTED_REASON });

    const closed = (await repository.get(agentId))!;
    expect(closed.status).toBe('failed');
    expect(closed.terminal?.reason).toBe(BACKGROUND_SUBAGENT_INTERRUPTED_REASON);

    // 父会话投影：中断事实进了通知管道（单例），idle wake 被调度；
    // collect_agent 也能拿到终态而不是查无此人。
    const records = getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId: 'session-crash' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      agentId,
      status: 'failed',
      title: '崩溃时还在跑',
      role: 'coder',
      runId: 'run-parent-crash',
      treeId: 'tree-crash',
      failureCode: AgentFailureCode.ParentGone,
    });
    expect(records[0].content).toContain('interrupted_by_restart');
    expect(scheduleIdleWakeMock).toHaveBeenCalledWith(records[0]);
    expect(getBackgroundSubagentRegistry().getStatus(agentId)).toMatchObject({
      status: 'failed',
      failureCode: AgentFailureCode.ParentGone,
    });
    db.close();
  });

  it('恢复收口是终态：再次 sweep 不会重复投影中断通知', async () => {
    const { db, repository, ledger } = createStack('process-1');
    configureBackgroundSubagentDurableLedger(ledger);
    const spawned = new BackgroundSubagentRegistry();
    const agentId = spawned.spawn(() => deferred<SubagentResult>().promise, {
      sessionId: 'session-sweep',
      runId: 'run-parent-sweep',
    });
    await vi.waitFor(async () => {
      expect(await repository.get(agentId)).not.toBeNull();
    });

    const kernel2 = new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: 'process-2',
      leaseDurationMs: 60_000,
    });
    const recoveredRegistry = new RunRegistry();
    recoveredRegistry.configureDurableKernel(kernel2);
    const now = Date.now() + 120_000;
    const handler = createBackgroundSubagentRecoveryHandler({ registry: recoveredRegistry });
    const [plan] = await recoveredRegistry.recoverDurable(now);
    await handler.recover(plan, now);

    expect(await recoveredRegistry.recoverDurable(now + 120_000)).toEqual([]);
    expect(getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId: 'session-sweep' }))
      .toHaveLength(1);
    expect(getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId: 'session-sweep' }))
      .toEqual([]);
    db.close();
  });

  it('legacy 模式（未 arm 未 configure）：纯内存，不写任何 durable 行', async () => {
    const { db, repository } = createStack();
    const reg = new BackgroundSubagentRegistry();
    const agentId = reg.spawn(async () => fakeResult('legacy done'), {
      sessionId: 'session-legacy',
      runId: 'run-legacy',
    });

    const result = await reg.await(agentId);
    expect(result?.output).toBe('legacy done');
    expect(reg.getStatus(agentId)?.status).toBe('completed');
    expect(await repository.get(agentId)).toBeNull();
    db.close();
  });

  it('armed 但账本始终不就绪：fail-closed，子代理不会启动（不花钱）', async () => {
    vi.useFakeTimers();
    armBackgroundSubagentDurableLedger();
    const reg = new BackgroundSubagentRegistry();
    let executed = false;
    const agentId = reg.spawn(async () => {
      executed = true;
      return fakeResult('should not happen');
    }, { sessionId: 'session-no-ledger', runId: 'run-no-ledger' });

    const done = reg.await(agentId);
    await vi.advanceTimersByTimeAsync(30_000);
    await done;

    expect(executed).toBe(false);
    expect(reg.getStatus(agentId)).toMatchObject({ status: 'failed' });
    expect(reg.getStatus(agentId)?.error).toContain('Durable Run persistence is unavailable');
  });

  it('waitForBackgroundSubagentDurableLedger：configure 后 resolve，超时 reject', async () => {
    vi.useFakeTimers();
    armBackgroundSubagentDurableLedger();
    const { db, ledger } = createStack();
    const pending = waitForBackgroundSubagentDurableLedger(5_000);
    configureBackgroundSubagentDurableLedger(ledger);
    await expect(pending).resolves.toBe(ledger);

    resetBackgroundSubagentDurableLedger();
    armBackgroundSubagentDurableLedger();
    const timedOut = waitForBackgroundSubagentDurableLedger(5_000);
    const assertion = expect(timedOut).rejects.toBeInstanceOf(DurableRunPersistenceUnavailableError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    db.close();
  });
});
