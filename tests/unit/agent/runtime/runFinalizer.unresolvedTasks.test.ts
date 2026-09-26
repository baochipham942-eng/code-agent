import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message } from '../../../../src/shared/contract';

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/host/mcp/logCollector.js', () => ({
  logCollector: { agent: vi.fn() },
}));
vi.mock('../../../../src/host/services', () => ({
  getLangfuseService: vi.fn(),
  getBudgetService: vi.fn(),
  BudgetAlertLevel: { None: 'none' },
}));
vi.mock('../../../../src/host/lightMemory/sessionMetadata', () => ({
  recordSessionEnd: vi.fn(async () => undefined),
}));
vi.mock('../../../../src/host/lightMemory/recentConversations', () => ({
  appendConversationSummary: vi.fn(),
  isLoopAutomationSummaryText: () => false,
}));
vi.mock('../../../../src/host/lightMemory/conversationJudge', () => ({
  judgeConversation: vi.fn(async () => ({
    worth: false,
    isMeeting: false,
    title: '',
    worthKnowledge: [],
    durableFacts: [],
    source: 'heuristic',
  })),
}));
vi.mock('../../../../src/host/lightMemory/durableFactWriter', () => ({ writeDurableFacts: vi.fn() }));
vi.mock('../../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));
vi.mock('../../../../src/host/session/completionSummaryService', () => ({
  buildCompletionSummaryRecord: vi.fn(async () => ({ id: 'summary-1', status: 'completed' })),
  persistCompletionSummaryRecord: vi.fn(),
}));
vi.mock('../../../../src/host/agent/runtime/turnOutcomeStamp', () => ({
  recordTurnOutcomeStamp: vi.fn(),
}));
vi.mock('../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime', () => ({
  getConfiguredSurfaceExecutionRuntime: () => null,
}));
vi.mock('../../../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => [{
    id: '1',
    subject: '选择酒店方案',
    status: 'needs_decision',
    blockedReason: '在两家酒店间选',
  }],
}));
vi.mock('../../../../src/host/mcp/cuaSessionLock', () => ({ releaseCuaLock: vi.fn() }));
vi.mock('../../../../src/host/mcp/cuaTrajectoryBudget', () => ({ resetCuaBudget: vi.fn() }));

import { RunFinalizer } from '../../../../src/host/agent/runtime/runFinalizer';

describe('RunFinalizer unresolved task list', () => {
  it('writes the wait list into the terminal system message', async () => {
    const persisted: Message[] = [];
    const finalizer = new RunFinalizer({
      sessionId: 'session-unresolved',
      workingDirectory: '/tmp',
      onEvent: (_event: AgentEvent) => undefined,
      persistMessage: vi.fn(),
      modelConfig: { provider: 'test', model: 'test-model' },
      messages: [
        { id: 'user-1', role: 'user', content: '帮我订酒店', timestamp: 1 },
        { id: 'assistant-1', role: 'assistant', content: '选哪家？', timestamp: 2 },
      ],
      maxIterations: 10,
      stats: {
        traceId: 'trace-unresolved',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        queueDiagnostic: vi.fn(),
      },
      control: { isCancelled: false, isInterrupted: false },
      circuitBreaker: { isTripped: () => false, reset: vi.fn() },
      nudgeManager: { getModifiedFiles: () => new Set() },
      turn: { currentTurnId: 'assistant-1' },
    } as never);
    finalizer.setModules(
      {
        generateId: () => 'sys-unresolved',
        addAndPersistMessage: vi.fn(async (message: Message) => { persisted.push(message); }),
      } as never,
      { runSessionEndLearning: vi.fn(async () => undefined) } as never,
    );

    await finalizer.finalizeRun(
      1,
      '帮我订酒店',
      { endTrace: vi.fn(), flush: vi.fn(async () => undefined) } as never,
      1,
      { status: 'completed' },
    );

    const notice = persisted.find((message) => message.role === 'system' && message.content.includes('显式任务未完成'));
    expect(notice?.content).toContain('选择酒店方案');
    expect(notice?.content).toContain('等你拍板');
  });
});
