import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');

import Database from 'better-sqlite3';
import type { TaskManager } from '../../../../src/host/task/TaskManager';
import {
  SessionTaskConcurrencyPool,
  SessionTaskSlotLedger,
  resetSessionTaskConcurrencyPoolForTest,
  type SessionTaskSlotRecovery,
} from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { SessionCommandCenter } from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../../src/host/task/backgroundTaskLedger';
import { SqliteBackgroundTaskStore } from '../../../../src/host/task/backgroundTaskStore';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';
import { SESSION_TASK_SLOT_TIMEOUT_MS } from '../../../../src/shared/constants/voice';

const PROJECT_SCOPE = createWorkspaceScope('slot-recovery-session', [{
  sourceId: 'slot-recovery-source',
  path: '/tmp/slot-recovery-project',
  role: 'primary',
  access: 'read_write',
}]);

class FakeTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  observeAgentEvents = vi.fn(() => () => undefined);
}

function ledgerInput(index: number) {
  return {
    workItemId: `work-${index}`,
    sessionId: 'session-a',
    laneKey: 'report',
    submissionKey: `submission-${index}`,
  };
}

function commandInput(index: number) {
  return {
    sessionId: 'session-a',
    title: `报告任务 ${index}`,
    shortName: `报告${index}`,
    laneKey: 'report',
    submissionKey: `submission-${index}`,
    prompt: `执行报告任务 ${index}`,
    workspaceScope: PROJECT_SCOPE,
  };
}

describe('session task slot crash recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases a lane when a run disappears without calling settle', async () => {
    const recoveries: SessionTaskSlotRecovery[] = [];
    const pool = new SessionTaskConcurrencyPool();
    const ledger = new SessionTaskSlotLedger('session-a', pool, {
      slotTimeoutMs: 1_000,
      cleanupIntervalMs: 100,
      onRecovery: (recovery) => recoveries.push(recovery),
    });

    expect(ledger.admit(ledgerInput(1))).toMatchObject({ outcome: 'started' });
    expect(ledger.admit(ledgerInput(2))).toMatchObject({ outcome: 'queued', reason: 'lane_busy' });

    // 模拟 run 异常消失：不发任何终态事件，也不调用 ledger.settle()。
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ledger.get('work-1')).toMatchObject({ status: 'settled', terminalStatus: 'failed' });
    expect(ledger.get('work-2')).toMatchObject({ status: 'running' });
    expect(pool.runningCount()).toBe(1);
    expect(recoveries).toEqual([{
      reason: 'terminal_event_timeout',
      recoveredAt: Date.now(),
      expired: [{
        slot: expect.objectContaining({
          workItemId: 'work-1',
          laneKey: 'report',
          terminalStatus: 'failed',
        }),
        occupiedMs: 1_000,
      }],
      startable: [expect.objectContaining({ workItemId: 'work-2', status: 'running' })],
    }]);
    ledger.dispose();
  });

  it('extends the idle window from the latest touch instead of startedAt', async () => {
    const ledger = new SessionTaskSlotLedger('session-a', new SessionTaskConcurrencyPool(), {
      slotTimeoutMs: 1_000,
      cleanupIntervalMs: 100,
    });

    expect(ledger.admit(ledgerInput(1))).toMatchObject({ outcome: 'started' });
    await vi.advanceTimersByTimeAsync(800);
    ledger.touch('work-1');
    await vi.advanceTimersByTimeAsync(800);

    expect(ledger.get('work-1')).toMatchObject({ status: 'running', lastActivityAt: Date.now() - 800 });
    await vi.advanceTimersByTimeAsync(200);
    expect(ledger.get('work-1')).toMatchObject({ status: 'settled', terminalStatus: 'failed' });
    ledger.dispose();
  });

  it('does not expire a slot while shouldSkipExpiry is set', async () => {
    let skip = true;
    const ledger = new SessionTaskSlotLedger('session-a', new SessionTaskConcurrencyPool(), {
      slotTimeoutMs: 1_000,
      cleanupIntervalMs: 100,
      shouldSkipExpiry: () => skip,
    });

    expect(ledger.admit(ledgerInput(1))).toMatchObject({ outcome: 'started' });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(ledger.get('work-1')?.status).toBe('running');
    skip = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ledger.get('work-1')).toMatchObject({ status: 'settled', terminalStatus: 'failed' });
    ledger.dispose();
  });

  it('keeps the voice ledger on a 2h total occupancy clock', async () => {
    expect(SESSION_TASK_SLOT_TIMEOUT_MS).toBe(2 * 60 * 60 * 1_000);
    const recoveries: SessionTaskSlotRecovery[] = [];
    const ledger = new SessionTaskSlotLedger('voice-session', new SessionTaskConcurrencyPool(), {
      cleanupIntervalMs: 60_000,
      onRecovery: (recovery) => recoveries.push(recovery),
    });

    expect(ledger.admit({ ...ledgerInput(1), sessionId: 'voice-session' })).toMatchObject({ outcome: 'started' });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
    expect(ledger.get('work-1')).toMatchObject({ status: 'running' });
    expect(ledger.get('work-1')?.lastActivityAt).toBeUndefined();

    await vi.advanceTimersByTimeAsync(SESSION_TASK_SLOT_TIMEOUT_MS - 30 * 60 * 1_000);
    expect(ledger.get('work-1')).toMatchObject({ status: 'settled', terminalStatus: 'failed' });
    expect(recoveries[0]?.expired[0]?.occupiedMs).toBe(SESSION_TASK_SLOT_TIMEOUT_MS);
    ledger.dispose();
  });

  it('marks the abandoned text task failed in human-readable history and launches its lane successor', async () => {
    const manager = new FakeTaskManager();
    const projectTerminalResult = vi.fn().mockResolvedValue(undefined);
    const wakeForegroundBrain = vi.fn().mockResolvedValue(undefined);
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult,
      wakeForegroundBrain,
      slotLedgerOptions: { slotTimeoutMs: 1_000, cleanupIntervalMs: 100 },
      slotRecoveryLocale: 'zh',
    });

    const first = await center.spawn(commandInput(1));
    await center.spawn(commandInput(2));
    if (first.outcome === 'requires_choice') throw new Error('unexpected admission result');
    expect(manager.startBackgroundTask).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(manager.startBackgroundTask).toHaveBeenCalledTimes(2);
    expect(center.list('session-a')).toMatchObject([
      {
        status: 'failed',
        detail: '后台任务失败：命令已 1 秒没有响应',
      },
      { status: 'running' },
    ]);
    expect(wakeForegroundBrain).toHaveBeenCalledTimes(1);
    expect(manager.cancelBackgroundTask).toHaveBeenCalledTimes(1);
    expect(manager.cancelBackgroundTask).toHaveBeenCalledWith(first.task.id);
    expect(projectTerminalResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.task.id, status: 'failed' }),
      'failed',
    );
    expect(getBackgroundTaskLedger().listTasks({ sessionId: 'session-a' })
      .find((task) => task.id === first.task.id)).toMatchObject({
      status: 'failed',
      failure: { reason: 'session_command_task_failed' },
    });
    center.dispose();
  });

  it('settles a silent running task with the idle failure text and wakes the foreground once', async () => {
    const manager = new FakeTaskManager();
    const wakeForegroundBrain = vi.fn().mockResolvedValue(undefined);
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn().mockResolvedValue(undefined),
      wakeForegroundBrain,
      slotLedgerOptions: { slotTimeoutMs: 120_000, cleanupIntervalMs: 120_000 },
      slotRecoveryLocale: 'en',
    });

    const first = await center.spawn(commandInput(1));
    if (first.outcome === 'requires_choice') throw new Error('unexpected admission result');

    await vi.advanceTimersByTimeAsync(120_000);

    expect(center.list('session-a')[0]).toMatchObject({
      status: 'failed',
      detail: 'Background task failed: the command stopped responding for 2 minutes',
    });
    expect(wakeForegroundBrain).toHaveBeenCalledTimes(1);
    expect(wakeForegroundBrain).toHaveBeenCalledWith(
      expect.objectContaining({
        id: first.task.id,
        status: 'failed',
        detail: 'Background task failed: the command stopped responding for 2 minutes',
      }),
      'failed',
    );
    expect(manager.cancelBackgroundTask).toHaveBeenCalledTimes(1);
    expect(manager.cancelBackgroundTask).toHaveBeenCalledWith(first.task.id);
    center.dispose();
  });

  it('loads a persisted running card with no live process as orphaned', () => {
    const db = new Database(':memory:');
    try {
      const store = new SqliteBackgroundTaskStore(db);
      store.upsertTask({
        id: 'session-work-hung',
        kind: 'session_command_task',
        sessionId: 'session-a',
        source: 'session_command_center',
        title: '提醒',
        status: 'running',
        createdAt: 1,
        updatedAt: 2,
        startedAt: 1,
        events: [],
        outputRefs: [],
      });

      const restarted = new SqliteBackgroundTaskStore(db);
      expect(restarted.loadTerminalTask('session-work-hung')).toMatchObject({
        status: 'orphaned',
        failure: expect.objectContaining({ category: 'dead_log_only' }),
        metadata: expect.objectContaining({
          originalStatus: 'running',
          recoveryStatus: 'dead-log-only',
        }),
      });
    } finally {
      db.close();
    }
  });
});
