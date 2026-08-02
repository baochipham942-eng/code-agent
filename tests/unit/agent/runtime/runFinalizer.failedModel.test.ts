import { describe, expect, it, vi } from 'vitest';

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

describe('RunFinalizer 失败事件', () => {
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
});
