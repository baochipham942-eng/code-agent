import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskManager, TaskManagerEvent } from '../../../src/host/task/TaskManager';
import {
  SessionCommandCenter,
  type SessionCommandTask,
} from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../src/host/task/backgroundTaskLedger';

class FakeTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);

  emitTask(event: TaskManagerEvent): void {
    this.emit(event.type, event);
  }
}

function input(index: number, laneKey = `lane-${index}`) {
  return {
    sessionId: 'session-a',
    title: `任务 ${index}`,
    shortName: `任务${index}`,
    laneKey,
    submissionKey: `submission-${index}`,
    prompt: `执行任务 ${index}`,
  };
}

describe('SessionCommandCenter', () => {
  beforeEach(() => {
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });

  it('projects one stable identity across task control, UI ledger and durable relation metadata', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
    });
    const spawned = await center.spawn({
      ...input(1),
      parentRunId: 'run-parent-1',
      parentTurnId: 'turn-parent-1',
      toolCallId: 'call-spawn-1',
    });
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

    expect(manager.startBackgroundTask).toHaveBeenCalledWith(
      spawned.task.id,
      'session-a',
      '执行任务 1',
      undefined,
      expect.objectContaining({
        runRegistration: 'auxiliary',
        runId: spawned.task.id,
        parentRunId: 'run-parent-1',
      }),
      undefined,
    );
    expect(getBackgroundTaskLedger().listTasks({ sessionId: 'session-a' })).toEqual([
      expect.objectContaining({
        id: spawned.task.id,
        runId: spawned.task.id,
        parentTurnId: 'turn-parent-1',
        toolCallId: 'call-spawn-1',
        status: 'running',
        metadata: expect.objectContaining({
          parentRunId: 'run-parent-1',
          childRunId: spawned.task.id,
        }),
      }),
    ]);
    center.dispose();
  });

  it('enforces lanes, session capacity and idempotent submissions', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
    });

    const first = await center.spawn(input(1, 'report'));
    const sameLane = await center.spawn(input(2, 'report'));
    const secondLane = await center.spawn(input(3, 'research'));
    const overCapacity = await center.spawn(input(4, 'build'));
    const repeated = await center.spawn({ ...input(9), submissionKey: 'submission-1' });

    expect(first.outcome).toBe('started');
    expect(sameLane.outcome).toBe('queued');
    expect(secondLane.outcome).toBe('started');
    expect(overCapacity.outcome).toBe('requires_choice');
    expect(repeated).toMatchObject({ outcome: 'reused', task: { shortName: '任务1' } });
    expect(manager.startBackgroundTask).toHaveBeenCalledTimes(2);
    center.dispose();
  });

  it('returns terminal results to the foreground and starts the next lane item', async () => {
    const manager = new FakeTaskManager();
    const projected: Array<{ task: SessionCommandTask; status: string }> = [];
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(async (task, status) => {
        projected.push({ task: { ...task }, status });
      }),
    });
    const first = await center.spawn(input(1, 'report'));
    const second = await center.spawn(input(2, 'report'));
    if (first.outcome === 'requires_choice' || second.outcome === 'requires_choice') {
      throw new Error('unexpected admission result');
    }

    manager.emitTask({
      type: 'task_completed',
      sessionId: 'session-a',
      data: { taskId: first.task.id, conclusion: '报告已生成并通过检查。' },
    });

    await vi.waitFor(() => {
      expect(projected).toMatchObject([
        { status: 'completed', task: { shortName: '任务1', summary: '报告已生成并通过检查。' } },
      ]);
      expect(manager.startBackgroundTask).toHaveBeenCalledTimes(2);
    });
    expect(center.list('session-a')).toMatchObject([
      { status: 'completed' },
      { status: 'running' },
    ]);
    center.dispose();
  });

  it('resolves short names for steer and cancel without guessing ambiguous targets', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
    });
    const first = await center.spawn(input(1, 'report'));
    await center.spawn(input(2, 'research'));
    if (first.outcome === 'requires_choice') throw new Error('unexpected admission result');

    expect(center.resolve('session-a').outcome).toBe('ambiguous');
    await expect(center.steer('session-a', '任务1', '优先给业务结论'))
      .resolves.toMatchObject({ outcome: 'resolved' });
    expect(manager.interruptBackgroundTask).toHaveBeenCalledWith(
      first.task.id,
      '优先给业务结论',
      undefined,
      undefined,
    );

    await expect(center.cancel('session-a', '任务1'))
      .resolves.toMatchObject({ outcome: 'resolved', task: { status: 'cancelling' } });
    expect(manager.cancelBackgroundTask).toHaveBeenCalledWith(first.task.id);
    center.dispose();
  });
});
