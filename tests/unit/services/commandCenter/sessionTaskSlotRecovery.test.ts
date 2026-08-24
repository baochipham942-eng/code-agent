import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';

const PROJECT_SCOPE = createWorkspaceScope('slot-recovery-session', [{
  sourceId: 'slot-recovery-source',
  path: '/tmp/slot-recovery-project',
  role: 'primary',
  access: 'read_write',
}]);

class FakeTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
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

  it('marks the abandoned text task failed in human-readable history and launches its lane successor', async () => {
    const manager = new FakeTaskManager();
    const projectTerminalResult = vi.fn().mockResolvedValue(undefined);
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult,
      wakeForegroundBrain: vi.fn().mockResolvedValue(undefined),
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
        detail: expect.stringContaining('lane「report」占用 1 秒后仍未收到终态事件'),
      },
      { status: 'running' },
    ]);
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
});
