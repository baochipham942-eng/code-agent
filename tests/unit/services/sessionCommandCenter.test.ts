import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  SESSION_COMMAND_TASK_IDLE_TIMEOUT_MS,
  resolveSessionCommandTaskIdleTimeoutMs,
} from '../../../src/shared/constants/sessionCommandCenter';

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
      persistMemberInput: vi.fn().mockResolvedValue(undefined),
    });
    await center.spawn(input(1, 'report'));
    const queued = await center.spawn({ ...input(2, 'report'), queueWhenFull: true });
    if (queued.outcome !== 'queued') throw new Error(`expected queued, got ${queued.outcome}`);

    await center.steer('session-a', queued.task.id, '顺便把页码加上');
    expect(center.list('session-a').find((task) => task.id === queued.task.id)?.prompt)
      .toContain('补充要求：顺便把页码加上');
    // 排队任务的改道也要落到任务书里，且带改道指令行（否则开工时沿用原思路）
    await center.steer('session-a', queued.task.id, '换成按季度汇总', { origin: 'user', mode: 'redirect', memberName: '任务2', messageId: 'm-9', timestamp: 4200 });
    const prompt = center.list('session-a').find((task) => task.id === queued.task.id)?.prompt ?? '';
    expect(prompt).toContain('改道要求：换成按季度汇总');
    expect(prompt).toContain('改道指令');
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

  // N-SUBAGENT-INPUT：排队任务收到用户补话时，主会话要落一条 isMeta+memberInput 记录（刷新/回放/团长汇总都看得见）；
  // 团长 steer_task 不落（那是模型转述，不是用户说的）
  it('persists a member-input record for a queued task on user-origin steer only', async () => {
    const manager = new FakeTaskManager();
    const persistMemberInput = vi.fn().mockResolvedValue(undefined);
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
      wakeForegroundBrain: vi.fn(),
      persistMemberInput,
    });
    await center.spawn(input(1, 'report'));
    const queued = await center.spawn({ ...input(2, 'report'), queueWhenFull: true });
    if (queued.outcome !== 'queued') throw new Error(`expected queued, got ${queued.outcome}`);

    await center.steer('session-a', queued.task.id, '顺便把页码加上', { origin: 'user', mode: 'supplement', memberName: '任务2', messageId: 'm-7', timestamp: 4100 });
    expect(persistMemberInput).toHaveBeenCalledWith('session-a', expect.objectContaining({
      id: 'm-7', role: 'user', content: '顺便把页码加上', timestamp: 4100, isMeta: true,
      metadata: {
        workbench: { runtimeInputMode: 'supplement' },
        memberInput: { memberId: queued.task.id, memberName: '任务2', mode: 'supplement' },
      },
    }));

    await center.steer('session-a', queued.task.id, '团长转述');
    expect(persistMemberInput).toHaveBeenCalledTimes(1);
    center.dispose();
  });

  // 落库失败不能报成「没送到」：任务书已经改了，用户重发会重复追加。降级为 recorded:false 让回执说「已送到、没记下、别重发」
  it('reports recorded:false instead of throwing when the member-input record fails after the prompt changed', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
      wakeForegroundBrain: vi.fn(),
      persistMemberInput: vi.fn().mockRejectedValue(new Error('db down')),
    });
    await center.spawn(input(1, 'report'));
    const queued = await center.spawn({ ...input(2, 'report'), queueWhenFull: true });
    if (queued.outcome !== 'queued') throw new Error(`expected queued, got ${queued.outcome}`);

    const result = await center.steer('session-a', queued.task.id, '顺便把页码加上', { origin: 'user', mode: 'supplement', memberName: '任务2', messageId: 'm-8' });
    expect(result).toMatchObject({ outcome: 'resolved', recorded: false });
    expect(center.list('session-a').find((task) => task.id === queued.task.id)?.prompt).toContain('补充要求：顺便把页码加上');
    center.dispose();
  });

  // ── N-MEDIA-GEN-MUSIC-FALLBACK-FU1：终局工具失败出路（progress.lastToolFailure）──

  function musicFailureEnd(alternatives?: string): AgentEvent {
    return {
      type: 'tool_call_end',
      data: {
        toolCallId: 'call-music-1',
        success: false,
        error: 'The default MiniMax music service is unavailable (no key)',
        metadata: {
          code: 'MUSIC_SERVICE_UNAVAILABLE',
          ...(alternatives ? { alternatives } : {}),
        },
      },
    } as AgentEvent;
  }

  it('writes progress.lastToolFailure from an allow-listed tool_call_end failure', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
    });
    const spawned = await center.spawn(input(1, 'media'));
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

    manager.emitAgent('session-a', {
      type: 'tool_call_start',
      data: { id: 'call-music-1', name: 'music_generate', arguments: { prompt: '轻快的背景音乐' } },
    } as AgentEvent, spawned.task.id);
    manager.emitAgent('session-a', musicFailureEnd('zhipu:glm-5.3'), spawned.task.id);

    const projected = getBackgroundTaskLedger().listTasks({ sessionId: 'session-a' })
      .find((task) => task.id === spawned.task.id);
    expect(projected?.progress?.lastToolFailure).toEqual({
      tool: 'music_generate',
      code: 'MUSIC_SERVICE_UNAVAILABLE',
      alternatives: 'zhipu:glm-5.3',
      at: expect.any(Number),
    });
    center.dispose();
  });

  it('clears lastToolFailure when the same tool later succeeds, not when another tool does', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
    });
    const spawned = await center.spawn(input(1, 'media'));
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');
    manager.emitAgent('session-a', {
      type: 'tool_call_start',
      data: { id: 'call-music-1', name: 'music_generate', arguments: {} },
    } as AgentEvent, spawned.task.id);
    manager.emitAgent('session-a', musicFailureEnd('zhipu:glm-5.3'), spawned.task.id);

    const projected = () => getBackgroundTaskLedger().listTasks({ sessionId: 'session-a' })
      .find((task) => task.id === spawned.task.id);

    // 别的工具成功不清：出路针对的是失败的那个工具
    manager.emitAgent('session-a', {
      type: 'tool_call_start',
      data: { id: 'call-read-1', name: 'Read', arguments: {} },
    } as AgentEvent, spawned.task.id);
    manager.emitAgent('session-a', {
      type: 'tool_call_end',
      data: { toolCallId: 'call-read-1', success: true, output: 'ok' },
    } as AgentEvent, spawned.task.id);
    expect(projected()?.progress?.lastToolFailure?.code).toBe('MUSIC_SERVICE_UNAVAILABLE');

    // 用户按出路补配后重跑：同名工具成功即清除，提示要消失
    manager.emitAgent('session-a', {
      type: 'tool_call_start',
      data: { id: 'call-music-2', name: 'music_generate', arguments: { model: 'zhipu:glm-5.3' } },
    } as AgentEvent, spawned.task.id);
    manager.emitAgent('session-a', {
      type: 'tool_call_end',
      data: { toolCallId: 'call-music-2', success: true, output: '1/1 saved' },
    } as AgentEvent, spawned.task.id);
    expect(projected()?.progress?.lastToolFailure).toBeUndefined();
    center.dispose();
  });

  it('does not record failures whose code is outside the allow-list', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
    });
    const spawned = await center.spawn(input(1, 'media'));
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

    manager.emitAgent('session-a', {
      type: 'tool_call_start',
      data: { id: 'call-shell-1', name: 'Bash', arguments: {} },
    } as AgentEvent, spawned.task.id);
    manager.emitAgent('session-a', {
      type: 'tool_call_end',
      data: {
        toolCallId: 'call-shell-1',
        success: false,
        error: 'command not found',
        metadata: { code: 'ENV_DEPENDENCY_MISSING' },
      },
    } as AgentEvent, spawned.task.id);

    const projected = getBackgroundTaskLedger().listTasks({ sessionId: 'session-a' })
      .find((task) => task.id === spawned.task.id);
    expect(projected?.progress?.lastToolFailure).toBeUndefined();
    center.dispose();
  });

  it('does not write lastToolFailure after the task already reached a terminal status', async () => {
    const manager = new FakeTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
    });
    const spawned = await center.spawn(input(1, 'media'));
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

    manager.emitTask({ type: 'task_error', sessionId: 'session-a', data: { taskId: spawned.task.id, error: '上游超时' } });
    manager.emitAgent('session-a', musicFailureEnd('zhipu:glm-5.3'), spawned.task.id);

    const projected = getBackgroundTaskLedger().listTasks({ sessionId: 'session-a' })
      .find((task) => task.id === spawned.task.id);
    expect(projected?.status).toBe('failed');
    expect(projected?.progress?.lastToolFailure).toBeUndefined();
    center.dispose();
  });
});

const IDLE_TIMEOUT_ENV = 'CODE_AGENT_SESSION_TASK_IDLE_TIMEOUT_MS';

describe('SessionCommandCenter idle expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    delete process.env[IDLE_TIMEOUT_ENV];
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env[IDLE_TIMEOUT_ENV];
  });

  it('does not expire a task that keeps emitting events past the idle window', async () => {
    const manager = new FakeTaskManager();
    const wakeForegroundBrain = vi.fn().mockResolvedValue(undefined);
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn().mockResolvedValue(undefined),
      wakeForegroundBrain,
      slotLedgerOptions: { slotTimeoutMs: 30_000, cleanupIntervalMs: 1_000 },
      slotRecoveryLocale: 'en',
    });
    const spawned = await center.spawn(input(1, 'report'));
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

    await vi.advanceTimersByTimeAsync(20_000);
    manager.emitAgent('session-a', {
      type: 'message',
      data: { id: 'msg-1', role: 'assistant', content: 'still working', timestamp: Date.now() },
    }, spawned.task.id);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(center.list('session-a')[0]?.status).toBe('running');
    expect(manager.cancelBackgroundTask).not.toHaveBeenCalled();
    expect(wakeForegroundBrain).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(center.list('session-a')[0]).toMatchObject({
      status: 'failed',
      detail: 'Background task failed: the command stopped responding for 30 seconds',
    });
    center.dispose();
  });

  it('does not expire a task with a pending approval', async () => {
    const manager = new FakeTaskManager();
    const wakeForegroundBrain = vi.fn().mockResolvedValue(undefined);
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn().mockResolvedValue(undefined),
      wakeForegroundBrain,
      slotLedgerOptions: { slotTimeoutMs: 5_000, cleanupIntervalMs: 1_000 },
      slotRecoveryLocale: 'en',
    });
    const spawned = await center.spawn(input(1, 'report'));
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

    manager.emitAgent('session-a', {
      type: 'permission_request',
      data: {
        id: 'perm-1',
        type: 'command',
        tool: 'Bash',
        details: { command: 'sleep 900' },
        timestamp: Date.now(),
      },
    }, spawned.task.id);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(center.list('session-a')[0]?.status).toBe('running');
    expect(manager.cancelBackgroundTask).not.toHaveBeenCalled();
    expect(wakeForegroundBrain).not.toHaveBeenCalled();

    manager.emitAgent('session-a', {
      type: 'permission_request',
      data: {
        id: 'perm-1',
        type: 'command',
        tool: 'Bash',
        details: { command: 'sleep 900' },
        timestamp: Date.now(),
        resolved: true,
        decision: 'once',
      },
    }, spawned.task.id);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(center.list('session-a')[0]?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(center.list('session-a')[0]?.status).toBe('failed');
    expect(manager.cancelBackgroundTask).toHaveBeenCalledTimes(1);
    center.dispose();
  });

  it('uses the 30 minute idle default unless the env or injected ledger options override it', async () => {
    expect(SESSION_COMMAND_TASK_IDLE_TIMEOUT_MS).toBe(30 * 60 * 1_000);
    expect(resolveSessionCommandTaskIdleTimeoutMs({})).toBe(SESSION_COMMAND_TASK_IDLE_TIMEOUT_MS);
    expect(resolveSessionCommandTaskIdleTimeoutMs({ [IDLE_TIMEOUT_ENV]: '120000' })).toBe(120_000);
    expect(resolveSessionCommandTaskIdleTimeoutMs({ [IDLE_TIMEOUT_ENV]: 'nope' })).toBe(SESSION_COMMAND_TASK_IDLE_TIMEOUT_MS);

    process.env[IDLE_TIMEOUT_ENV] = '20000';
    const envManager = new FakeTaskManager();
    const envCenter = new SessionCommandCenter(envManager as unknown as TaskManager, {
      projectTerminalResult: vi.fn().mockResolvedValue(undefined),
      wakeForegroundBrain: vi.fn().mockResolvedValue(undefined),
      slotLedgerOptions: { cleanupIntervalMs: 1_000 },
      slotRecoveryLocale: 'en',
    });
    const envSpawned = await envCenter.spawn(input(1, 'report'));
    if (envSpawned.outcome === 'requires_choice') throw new Error('unexpected admission result');
    await vi.advanceTimersByTimeAsync(19_000);
    expect(envCenter.list('session-a')[0]?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(envCenter.list('session-a')[0]?.status).toBe('failed');
    envCenter.dispose();

    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    process.env[IDLE_TIMEOUT_ENV] = '20000';
    const injected = new FakeTaskManager();
    const injectedCenter = new SessionCommandCenter(injected as unknown as TaskManager, {
      projectTerminalResult: vi.fn().mockResolvedValue(undefined),
      wakeForegroundBrain: vi.fn().mockResolvedValue(undefined),
      slotLedgerOptions: { slotTimeoutMs: 5_000, cleanupIntervalMs: 1_000 },
      slotRecoveryLocale: 'en',
    });
    const injectedSpawned = await injectedCenter.spawn(input(2, 'research'));
    if (injectedSpawned.outcome === 'requires_choice') throw new Error('unexpected admission result');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(injectedCenter.list('session-a')[0]?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(injectedCenter.list('session-a')[0]?.status).toBe('failed');
    injectedCenter.dispose();
  });
});
