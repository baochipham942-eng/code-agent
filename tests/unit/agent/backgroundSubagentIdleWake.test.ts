import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleBackgroundSubagentIdleWake } from '../../../src/host/agent/backgroundSubagentIdleWake';
import { getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';
import type { SubagentCompletionRecord } from '../../../src/host/agent/subagentCompletionNotification';

const taskManagerMocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  startTask: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => taskManagerMocks,
}));

function subagentResult(output: string): SubagentResult {
  return { success: true, output } as SubagentResult;
}

/** 往真单例 registry 播种一条已完成的后台任务（生产路径同款：完成记录只能经 drain 消费）。 */
async function seedCompletion(agentId: string, sessionId: string): Promise<void> {
  getBackgroundSubagentRegistry().spawn(async () => subagentResult(`${agentId} done`), {
    agentId,
    sessionId,
    role: 'coder',
    suppressIdleWake: true, // 播种阶段不触发 wake，由测试显式 schedule
  });
  await vi.advanceTimersByTimeAsync(0);
}

function trigger(agentId: string, sessionId: string): SubagentCompletionRecord {
  return {
    agentId,
    sessionId,
    role: 'coder',
    status: 'completed',
    summary: 'done',
    content: 'ignored',
    createdAt: 1,
    dedupeKey: `${sessionId}:${agentId}`,
  } as SubagentCompletionRecord;
}

describe('background subagent idle wake', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    taskManagerMocks.getSessionState.mockReset();
    taskManagerMocks.startTask.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches simultaneous idle completions into one invisible parent turn', async () => {
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockResolvedValue(undefined);

    await seedCompletion('agent-a', 'idle-session');
    await seedCompletion('agent-b', 'idle-session');

    scheduleBackgroundSubagentIdleWake(trigger('agent-a', 'idle-session'));
    scheduleBackgroundSubagentIdleWake(trigger('agent-b', 'idle-session'));
    await vi.advanceTimersByTimeAsync(50);

    expect(taskManagerMocks.startTask).toHaveBeenCalledTimes(1);
    expect(taskManagerMocks.startTask).toHaveBeenCalledWith(
      'idle-session',
      expect.stringContaining('2 background tasks completed'),
      undefined,
      expect.objectContaining({
        mode: 'normal',
        historyVisibility: 'meta',
        maxIterations: 1,
      }),
      expect.objectContaining({
        automation: expect.objectContaining({
          automationType: 'role_wake',
          sourceSessionId: 'idle-session',
        }),
      }),
      expect.stringContaining('background-subagent:idle-session:'),
    );

    // 唤醒即消费：队列里不能再有这个 session 的记录（防止下一个工具结果双投递）
    expect(getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId: 'idle-session' })).toEqual([]);
  });

  it('does not wake running or paused parent sessions, and keeps records for the tool-result path', async () => {
    taskManagerMocks.getSessionState.mockReturnValueOnce({ status: 'running' });
    await seedCompletion('agent-running', 'busy-session');
    scheduleBackgroundSubagentIdleWake(trigger('agent-running', 'busy-session'));
    await vi.advanceTimersByTimeAsync(50);

    taskManagerMocks.getSessionState.mockReturnValueOnce({ status: 'paused' });
    await seedCompletion('agent-paused', 'paused-session');
    scheduleBackgroundSubagentIdleWake(trigger('agent-paused', 'paused-session'));
    await vi.advanceTimersByTimeAsync(50);

    expect(taskManagerMocks.startTask).not.toHaveBeenCalled();

    // 不消费：记录必须留给工具结果提醒路径投递
    const busy = getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId: 'busy-session' });
    expect(busy).toHaveLength(1);
    expect(busy[0]?.agentId).toBe('agent-running');
  });
});
