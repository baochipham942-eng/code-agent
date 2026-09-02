import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskManager, TaskManagerEvent } from '../../../src/host/task/TaskManager';
import type { AgentEvent } from '../../../src/shared/contract';
import {
  SessionCommandCenter,
  type SessionCommandTask,
} from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { describeDelegateTaskResult } from '../../../src/host/tools/modules/commandCenter/sessionCommandCenter';
import {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../src/host/task/backgroundTaskLedger';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

const PROJECT_SCOPE = createWorkspaceScope('project-session-a', [{
  sourceId: 'source-session-a',
  path: '/tmp/session-a-project',
  role: 'primary',
  access: 'read_write',
}]);

class FakeTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  private readonly agentObservers = new Set<(sessionId: string, event: AgentEvent, taskId?: string) => void>();

  observeAgentEvents(observer: (sessionId: string, event: AgentEvent, taskId?: string) => void): () => void {
    this.agentObservers.add(observer);
    return () => this.agentObservers.delete(observer);
  }

  emitAgent(sessionId: string, event: AgentEvent, taskId?: string): void {
    this.agentObservers.forEach((observer) => observer(sessionId, event, taskId));
  }

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
    workspaceScope: PROJECT_SCOPE,
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
      wakeForegroundBrain: vi.fn(),
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
      PROJECT_SCOPE,
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
      wakeForegroundBrain: vi.fn(),
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

  it('projects task_progress to the exact taskId when two background runs share one session', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
    });
    const first = await center.spawn(input(1, 'report'));
    const second = await center.spawn(input(2, 'research'));
    if (first.outcome === 'requires_choice' || second.outcome === 'requires_choice') {
      throw new Error('unexpected admission result');
    }

    manager.emitAgent('session-a', {
      type: 'task_progress',
      data: {
        turnId: 'turn-a',
        phase: 'tool_running',
        step: '执行 Read',
        tool: 'Read',
        toolIndex: 0,
        toolTotal: 2,
        target: '/repo/a.md',
      },
    }, first.task.id);
    manager.emitAgent('session-a', {
      type: 'task_progress',
      data: {
        turnId: 'turn-b',
        phase: 'tool_running',
        step: '执行 Bash',
        tool: 'Bash',
        toolIndex: 1,
        toolTotal: 3,
        target: 'npm test',
      },
    }, second.task.id);
    manager.emitAgent('session-a', {
      type: 'task_progress',
      data: { turnId: 'turn-front', phase: 'tool_running', tool: 'Write' },
    });

    const ledgerTasks = getBackgroundTaskLedger().listTasks({ sessionId: 'session-a' });
    expect(ledgerTasks.find((task) => task.id === first.task.id)?.progress?.lastToolStep).toEqual({
      tool: 'Read',
      toolIndex: 0,
      toolTotal: 2,
      target: '/repo/a.md',
      at: expect.any(Number),
    });
    expect(ledgerTasks.find((task) => task.id === second.task.id)?.progress?.lastToolStep).toEqual({
      tool: 'Bash',
      toolIndex: 1,
      toolTotal: 3,
      target: 'npm test',
      at: expect.any(Number),
    });
    center.dispose();
  });

  it('returns terminal results to the foreground and starts the next lane item', async () => {
    const manager = new FakeTaskManager();
    const projected: Array<{ task: SessionCommandTask; status: string }> = [];
    const wakeForegroundBrain = vi.fn();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(async (task, status) => {
        projected.push({ task: { ...task }, status });
      }),
      wakeForegroundBrain,
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
    expect(wakeForegroundBrain).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.task.id, summary: '报告已生成并通过检查。' }),
      'completed',
    );
    center.dispose();
  });

  it('releases the next slot when the fire-and-forget foreground wake rejects', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
      wakeForegroundBrain: vi.fn().mockRejectedValue(new Error('wake failed')),
    });
    const first = await center.spawn(input(1, 'report'));
    await center.spawn(input(2, 'report'));
    if (first.outcome === 'requires_choice') throw new Error('unexpected admission result');

    manager.emitTask({
      type: 'task_completed',
      sessionId: 'session-a',
      data: { taskId: first.task.id, conclusion: 'done' },
    });

    await vi.waitFor(() => expect(manager.startBackgroundTask).toHaveBeenCalledTimes(2));
    expect(center.list('session-a')).toMatchObject([
      { status: 'completed' },
      { status: 'running' },
    ]);
    center.dispose();
  });

  it('projects existing deliverable artifact metadata into completed task outputRefs', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
    });
    const spawned = await center.spawn(input(1));
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

    manager.emitTask({
      type: 'task_completed',
      sessionId: 'session-a',
      data: {
        taskId: spawned.task.id,
        conclusion: '报告已生成。',
        artifacts: [{
          artifactId: 'report-1',
          kind: 'document',
          role: 'deliverable',
          label: '最终报告',
          path: '/repo/report.md',
          mimeType: 'text/markdown',
        }],
      },
    });

    await vi.waitFor(() => {
      expect(getBackgroundTaskLedger().listTasks({ sessionId: 'session-a' })[0]?.outputRefs).toEqual([
        expect.objectContaining({
          type: 'file',
          label: '最终报告',
          path: '/repo/report.md',
          mimeType: 'text/markdown',
        }),
      ]);
    });
    center.dispose();
  });

  it('retries a failed submission key as a new attempt and preserves the failure in its receipt', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
      wakeForegroundBrain: vi.fn(),
    });
    const first = await center.spawn(input(1));
    if (first.outcome === 'requires_choice') throw new Error('unexpected admission result');

    manager.emitTask({
      type: 'task_error',
      sessionId: 'session-a',
      data: { taskId: first.task.id, error: '上游超时' },
    });
    await vi.waitFor(() => expect(center.list('session-a')[0]).toMatchObject({ status: 'failed' }));

    const retry = await center.spawn({ ...input(2), submissionKey: 'submission-1' });
    if (retry.outcome === 'requires_choice') throw new Error('unexpected admission result');
    expect(retry).toMatchObject({
      outcome: 'started',
      task: {
        attempt: 2,
        retryOf: { taskId: first.task.id, status: 'failed', detail: '上游超时' },
      },
    });
    expect(retry.task.id).not.toBe(first.task.id);
    expect(center.list('session-a')).toHaveLength(2);
    expect(describeDelegateTaskResult(retry)).toContain('上一次 [failed]：上游超时');
    center.dispose();
  });

  it('resolves short names for steer and cancel without guessing ambiguous targets', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
      wakeForegroundBrain: vi.fn(),
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

  // 顺手抓到的老病：resolve() 经 list() 返回快照拷贝，steer 改的 prompt 从没落到台账那份，
  // 排队任务开工时读到的还是老任务书。断言落在台账（list 再读）而不是 steer 的返回值上。
  it('steer on a queued task appends to the ledger copy of the prompt, not a snapshot', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
      wakeForegroundBrain: vi.fn(),
    });
    await center.spawn(input(1, 'report'));
    const queued = await center.spawn({ ...input(2, 'report'), queueWhenFull: true });
    if (queued.outcome !== 'queued') throw new Error(`expected queued, got ${queued.outcome}`);

    await center.steer('session-a', queued.task.id, '顺便把页码加上');
    expect(center.list('session-a').find((task) => task.id === queued.task.id)?.prompt)
      .toContain('补充要求：顺便把页码加上');
    expect(manager.interruptBackgroundTask).not.toHaveBeenCalled();
    center.dispose();
  });

  // N-SUBAGENT-INPUT：用户在成员视图亲手补的话，与团长 steer_task 走同一条 interruptBackgroundTask，
  // 但要带两档指令行 + runtimeInputMode/memberInput 元数据，并给终态唤醒摘要计数。
  it('user-origin steer carries the runtime input line, member metadata and counts toward the wake summary', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
      wakeForegroundBrain: vi.fn(),
    });
    const first = await center.spawn(input(1, 'report'));
    if (first.outcome === 'requires_choice') throw new Error('unexpected admission result');

    const result = await center.steer('session-a', first.task.id, '顺便把页码加上', {
      origin: 'user', mode: 'redirect', memberName: '报告任务',
    });
    expect(result).toMatchObject({ outcome: 'resolved', task: { userInputCount: 1 } });
    expect(manager.interruptBackgroundTask).toHaveBeenCalledWith(
      first.task.id,
      '顺便把页码加上',
      undefined,
      expect.objectContaining({
        turnSystemContext: expect.arrayContaining([expect.stringContaining('改道指令')]),
      }),
      {
        workbench: { runtimeInputMode: 'redirect' },
        memberInput: { memberId: first.task.id, memberName: '报告任务', mode: 'redirect' },
      },
    );

    await center.steer('session-a', first.task.id, '再补一句', { origin: 'user', mode: 'supplement', memberName: '报告任务' });
    expect(center.list('session-a').find((task) => task.id === first.task.id)?.userInputCount).toBe(2);
    // 团长 steer_task 不计入用户补话
    await center.steer('session-a', first.task.id, '团长转述');
    expect(center.list('session-a').find((task) => task.id === first.task.id)?.userInputCount).toBe(2);
    center.dispose();
  });
});
