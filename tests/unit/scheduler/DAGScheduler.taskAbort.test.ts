// ============================================================================
// N-DAGSCHED-TIMEOUT-ABORT：任务超时必须把 abort 真的送进内层子代理
// ============================================================================
// withTimeout 只是赛跑：超时分支只 dag.failTask 记账，内层 subagentExecutor 收不到
// 任何信号，活过 failTask 继续当幽灵烧预算。接线后任务级信号 =
// AbortSignal.any([run 级 abortSignal, 任务级超时控制器])，断言落在「executor 收到
// 的 signal 被 abort」这个不变量上——不是 failTask 被调用（那个摘掉接线也照样成立，
// 参见证据档反向变异段）。
// ============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'events';
import { DAGScheduler } from '../../../src/host/scheduler/DAGScheduler';
import { TaskDAG } from '../../../src/host/scheduler/TaskDAG';
import type { SubagentExecutionRequest } from '../../../src/host/agent/subagentExecutorTypes';
import { beginHumanWait, endHumanWait, isHumanWaitActive } from '../../../src/host/services/infra/timeoutController';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => loggerMock,
}));

describe('DAGScheduler agent 任务超时 abort 接线', () => {
  afterEach(() => {
    while (isHumanWaitActive()) endHumanWait();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const runContext = () => {
    const runAbort = new AbortController();
    const executionContext = {
      sessionId: 'session-task-abort',
      cwd: process.cwd(),
      modelConfig: { provider: 'mock', model: 'mock-model' },
      resolver: { getDefinition: vi.fn() },
      permission: { request: vi.fn(async () => true) },
      events: { emit: vi.fn() },
      abortSignal: runAbort.signal,
      currentToolCallId: 'call-1',
    };
    return { runAbort, executionContext };
  };

  /** executor 收到请求后挂住，直到 request.context.abortSignal 被 abort 才 resolve */
  const hangingExecutor = () =>
    vi.fn(
      (request: SubagentExecutionRequest) =>
        new Promise<{ success: boolean; output: string; toolsUsed: string[]; iterations: number }>(
          (resolve) => {
            const signal = request.context.abortSignal;
            if (signal.aborted) {
              resolve({ success: true, output: 'already aborted', toolsUsed: [], iterations: 0 });
              return;
            }
            signal.addEventListener(
              'abort',
              () => resolve({ success: true, output: 'aborted', toolsUsed: [], iterations: 0 }),
              { once: true },
            );
          },
        ),
    );

  const setupScheduler = (
    execute: ReturnType<typeof hangingExecutor>,
    timeout: number,
  ) => {
    const scheduler = new DAGScheduler({
      maxParallelism: 1,
      scheduleInterval: 1,
      defaultTimeout: 5000,
    });
    scheduler.setSubagentExecutor({ execute });
    scheduler.setAgentResolver({
      resolve: () => ({ systemPrompt: 'sp', tools: ['Read'], maxIterations: 3 }),
    });
    const dag = new TaskDAG('dag-task-abort', 'Task Abort DAG');
    dag.addAgentTask('agent-hang', { role: 'coder', prompt: 'hang until aborted' }, { timeout });
    return { scheduler, dag };
  };

  it('① 任务超时 ⇒ executor 收到的任务级 signal aborted=true、reason=timeout，任务 failed', async () => {
    const execute = hangingExecutor();
    const { scheduler, dag } = setupScheduler(execute, 50);
    const { executionContext } = runContext();

    const result = await scheduler.execute(dag, { executionContext: executionContext as never });

    const signal = execute.mock.calls[0][0].context.abortSignal;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('timeout');
    expect(dag.getTask('agent-hang')?.status).toBe('failed');
    expect(result.failedTasks).toBe(1);
    expect(result.errors[0]?.error).toContain('timeout');
  });

  it('② 正常完成 ⇒ signal 未 aborted，无残留 listener/timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const execute = vi.fn(async (_request: SubagentExecutionRequest) => ({
      success: true,
      output: 'agent output',
      toolsUsed: ['Read'],
      iterations: 1,
    }));
    const { scheduler, dag } = setupScheduler(execute, 1000);
    const { runAbort, executionContext } = runContext();
    const listenersBefore = getEventListeners(runAbort.signal, 'abort').length;

    const result = await scheduler.execute(dag, { executionContext: executionContext as never });

    const signal = execute.mock.calls[0][0].context.abortSignal;
    expect(signal.aborted).toBe(false);
    expect(getEventListeners(runAbort.signal, 'abort').length).toBe(listenersBefore);
    expect(vi.getTimerCount()).toBe(0);
    expect(result.success).toBe(true);
  });

  it('③ run 级信号中途 abort ⇒ 任务信号同步 abort 且 reason 透传', async () => {
    const execute = hangingExecutor();
    const { scheduler, dag } = setupScheduler(execute, 5000);
    const { runAbort, executionContext } = runContext();

    const resultPromise = scheduler.execute(dag, { executionContext: executionContext as never });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    runAbort.abort('user-cancel');
    await resultPromise;

    const signal = execute.mock.calls[0][0].context.abortSignal;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('user-cancel');
  });

  it('④ 任务级 abort 抛错只 warn，超时判定不变', async () => {
    const execute = hangingExecutor();
    const { scheduler, dag } = setupScheduler(execute, 50);
    const { executionContext } = runContext();

    const abortSpy = vi.spyOn(AbortController.prototype, 'abort').mockImplementationOnce(() => {
      throw new Error('abort boom');
    });

    const result = await scheduler.execute(dag, { executionContext: executionContext as never });

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(dag.getTask('agent-hang')?.status).toBe('failed');
    expect(dag.getTask('agent-hang')?.failure?.message).toContain('timeout');
    expect(result.errors[0]?.error).toContain('timeout');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('agent-hang'),
      expect.objectContaining({ error: 'abort boom' }),
    );
  });

  it('⑤ 人等待超过任务超时阈值后再结束，任务不因超时被杀', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const execute = hangingExecutor();
    const { scheduler, dag } = setupScheduler(execute, 50);
    const { executionContext } = runContext();

    beginHumanWait();
    const resultPromise = scheduler.execute(dag, { executionContext: executionContext as never });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(200);
    expect(execute.mock.calls[0][0].context.abortSignal.aborted).toBe(false);
    endHumanWait();
    await vi.advanceTimersByTimeAsync(50);
    await resultPromise;

    const signal = execute.mock.calls[0][0].context.abortSignal;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('timeout');
    expect(dag.getTask('agent-hang')?.status).toBe('failed');
  });
});
