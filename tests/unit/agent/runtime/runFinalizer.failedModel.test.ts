import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../../../src/shared/contract';

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false, saveTodos: vi.fn(), getTodos: vi.fn(() => []) }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../../src/host/mcp/logCollector.js', () => ({
  logCollector: { agent: vi.fn() },
}));

vi.mock('../../../../src/host/services', () => ({
  getLangfuseService: () => ({ endTrace: vi.fn() }),
  getBudgetService: () => ({ getUsage: vi.fn(() => null) }),
  BudgetAlertLevel: { None: 'none' },
}));

vi.mock('../../../../src/host/lightMemory/sessionMetadata', () => ({ recordSessionEnd: vi.fn() }));
vi.mock('../../../../src/host/lightMemory/recentConversations', () => ({
  appendConversationSummary: vi.fn(),
  isLoopAutomationSummaryText: () => false,
}));
vi.mock('../../../../src/host/lightMemory/conversationJudge', () => ({
  judgeConversation: vi.fn(async () => ({ worth: false, isMeeting: false, title: '', worthKnowledge: [], durableFacts: [], source: 'heuristic' })),
}));
vi.mock('../../../../src/host/lightMemory/durableFactWriter', () => ({ writeDurableFacts: vi.fn() }));
vi.mock('../../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));
vi.mock('../../../../src/host/context/contextHealthService', () => ({
  getContextHealthService: () => ({ getSnapshot: vi.fn(() => null), evaluate: vi.fn() }),
}));
vi.mock('../../../../src/host/session/completionSummaryService', () => ({
  buildCompletionSummaryRecord: vi.fn(() => null),
  persistCompletionSummaryRecord: vi.fn(),
}));
vi.mock('../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime', () => ({
  getConfiguredSurfaceExecutionRuntime: () => null,
}));

import { RunFinalizer } from '../../../../src/host/agent/runtime/runFinalizer';
import { buildGoalContract, GoalModeController } from '../../../../src/host/agent/goalModeController';
import { appendConversationSummary } from '../../../../src/host/lightMemory/recentConversations';
import { judgeConversation } from '../../../../src/host/lightMemory/conversationJudge';
import { HostReasonCode } from '../../../../src/shared/contract';

describe('RunFinalizer 失败事件', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('RUN_FAILED 带上这一轮真正跑的 provider/model', async () => {
    const events: AgentEvent[] = [];
    const finalizer = new RunFinalizer({
      sessionId: 'sess-failed-model',
      onEvent: (event: AgentEvent) => events.push(event),
      modelConfig: { provider: 'custom-100xlabs', model: 'claude-opus-4-8' },
      messages: [],
      maxIterations: 10,
      stats: {
        traceId: 'trace-1',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        queueDiagnostic: vi.fn(),
      },
      control: { isCancelled: false, isInterrupted: false },
      circuitBreaker: { isTripped: () => false, reset: vi.fn() },
      turn: { currentTurnId: null },
    } as never);
    finalizer.setModules(
      { generateId: () => 'msg-1', addAndPersistMessage: vi.fn() } as never,
      { runPostRun: vi.fn() } as never,
    );

    await finalizer.finalizeRun(
      1,
      '你好',
      { endTrace: vi.fn() } as never,
      8,
      { status: 'failed', error: new Error('Cannot connect to API') },
    ).catch(() => { /* 失败分支之后的收尾依赖不在本测试范围 */ });

    const errorEvent = events.find((event) => event.type === 'error');
    // 失败卡上「实际使用」那一栏的唯一真源。host 不带，渲染侧只能拿前端当前选中的
    // 模型顶上，用户刚切过模型时就会指认一个根本没跑过的模型。
    expect(errorEvent?.data).toMatchObject({
      code: 'RUN_FAILED',
      details: { provider: 'custom-100xlabs', model: 'claude-opus-4-8' },
    });
  });

  it('goal runtime failure emits a structured abort and marks the single error presentation', async () => {
    const events: AgentEvent[] = [];
    const goalMode = new GoalModeController(buildGoalContract({
      goal: '完成任务',
      verifyCommand: 'true',
      tokenBudget: 100,
      maxTurns: 5,
    }));
    const finalizer = new RunFinalizer({
      sessionId: 'sess-goal-failed',
      onEvent: (event: AgentEvent) => events.push(event),
      goalMode,
      modelConfig: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      messages: [],
      maxIterations: 5,
      stats: { traceId: 'trace-goal', totalInputTokens: 0, totalOutputTokens: 0, queueDiagnostic: vi.fn() },
      control: { isCancelled: false, isInterrupted: false },
      circuitBreaker: { isTripped: () => false, reset: vi.fn() },
      turn: { currentTurnId: null },
    } as never);
    finalizer.setModules(
      { generateId: () => 'msg-goal', addAndPersistMessage: vi.fn() } as never,
      { runPostRun: vi.fn(), runSessionEndLearning: vi.fn() } as never,
    );

    await finalizer.finalizeRun(
      1,
      '完成任务',
      { endTrace: vi.fn() } as never,
      1,
      { status: 'failed', error: new Error('Too Many Requests') },
    ).catch(() => undefined);

    expect(events.filter((event) => event.type === 'goal_complete')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'aborted',
          reason: expect.objectContaining({
            code: HostReasonCode.GoalAbortRuntimeFailure,
            modelText: '运行失败：Too Many Requests',
          }),
        }),
      }),
    ]);
    expect(events.find((event) => event.type === 'error')?.data).toMatchObject({
      message: 'Too Many Requests',
      goalAbort: true,
    });
  });

  it('an already-aborted goal at the iteration ceiling does not emit a second error', async () => {
    const events: AgentEvent[] = [];
    const goalMode = new GoalModeController(buildGoalContract({
      goal: '完成任务', verifyCommand: 'true', tokenBudget: 100, maxTurns: 5,
    }));
    goalMode.markAborted('达到轮次上限 5，目标未达成');
    const finalizer = new RunFinalizer({
      sessionId: 'sess-goal-limit',
      onEvent: (event: AgentEvent) => events.push(event),
      goalMode,
      modelConfig: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      messages: [],
      maxIterations: 5,
      stats: { traceId: 'trace-limit', totalInputTokens: 0, totalOutputTokens: 0, queueDiagnostic: vi.fn() },
      control: { isCancelled: false, isInterrupted: false },
      circuitBreaker: { isTripped: () => false, reset: vi.fn() },
      turn: { currentTurnId: null },
    } as never);
    finalizer.setModules(
      { generateId: () => 'msg-limit', addAndPersistMessage: vi.fn() } as never,
      { runPostRun: vi.fn(), runSessionEndLearning: vi.fn() } as never,
    );

    await finalizer.finalizeRun(
      5,
      '完成任务',
      { endTrace: vi.fn() } as never,
      1,
      { status: 'aborted' },
    ).catch(() => undefined);

    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('writes the stable session project id into the recent summary', async () => {
    vi.mocked(judgeConversation).mockResolvedValueOnce({
      worth: true,
      isMeeting: false,
      title: 'Project summary',
      worthKnowledge: ['finished project work'],
      durableFacts: [],
      source: 'heuristic',
    });
    const finalizer = new RunFinalizer({
      sessionId: 'sess-project',
      projectId: 'proj_a',
      messages: [{ id: 'user-1', role: 'user', content: 'continue project A', timestamp: 1 }],
    } as never);

    await (finalizer as unknown as { extractAndSaveConversationSummary(): Promise<void> })
      .extractAndSaveConversationSummary();

    expect(appendConversationSummary).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Project summary',
      projectId: 'proj_a',
    }));
  });

  it('does not write persistent role traffic into ordinary recent conversations', async () => {
    const finalizer = new RunFinalizer({
      sessionId: 'sess-role',
      projectId: 'proj_a',
      persistentRoleId: 'researcher',
      messages: [{ id: 'user-1', role: 'user', content: 'role work', timestamp: 1 }],
    } as never);

    await (finalizer as unknown as { extractAndSaveConversationSummary(): Promise<void> })
      .extractAndSaveConversationSummary();

    expect(judgeConversation).not.toHaveBeenCalled();
    expect(appendConversationSummary).not.toHaveBeenCalled();
  });

  it('does not synthesize visible fallback text after terminal wake_noop', async () => {
    const events: AgentEvent[] = [];
    const addAndPersistMessage = vi.fn();
    const finalizer = new RunFinalizer({
      sessionId: 'sess-wake-noop',
      onEvent: (event: AgentEvent) => events.push(event),
      modelConfig: { provider: 'acceptance', model: 'e2e-local-agent-model' },
      messages: [
        { id: 'wake-user', role: 'user', content: '后台任务已完成', timestamp: 1, isMeta: true },
        {
          id: 'wake-assistant',
          role: 'assistant',
          content: '',
          timestamp: 2,
          isMeta: true,
          toolCalls: [{ id: 'wake-noop-call', name: 'wake_noop', arguments: {} }],
        },
        { id: 'wake-tool', role: 'tool', content: '[]', timestamp: 3, isMeta: true },
      ],
      maxIterations: 10,
      stats: {
        traceId: 'trace-wake-noop',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        queueDiagnostic: vi.fn(),
      },
      control: { isCancelled: false, isInterrupted: false },
      circuitBreaker: { isTripped: () => false, reset: vi.fn() },
      turn: { currentTurnId: null },
    } as never);
    finalizer.setModules(
      { generateId: () => 'fallback-message', addAndPersistMessage } as never,
      { runPostRun: vi.fn(), runSessionEndLearning: vi.fn(async () => undefined) } as never,
    );

    await finalizer.finalizeRun(
      1,
      '后台任务已完成',
      { endTrace: vi.fn() } as never,
      8,
      { status: 'completed' },
    ).catch(() => { /* 后续轻记忆依赖不在本断言范围 */ });

    expect(addAndPersistMessage).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'message',
      data: expect.objectContaining({ content: expect.stringContaining('没有生成最终说明') }),
    }));
  });
});
