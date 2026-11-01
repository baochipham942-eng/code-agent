// ============================================================================
// 「到这次做完为止」run 档随 run 结束失效（N-PERM-GRANT-TIERS 验收 ②的 run 终点钉子）
// ============================================================================
// finalizeRun 是唯一的 run 结束清除点：run 里铸的工具授权 run 档在 finalizeRun 之后
// 必须不再命中（下一次同类操作恢复询问）。反向变异：把 runFinalizer 里的
// clearToolRunGrants 注掉，本用例必红。
// ============================================================================

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
  buildCompletionSummaryRecord: vi.fn(async () => ({ id: 'summary-1', status: 'failed' })),
  persistCompletionSummaryRecord: vi.fn(),
}));
vi.mock('../../../../src/host/agent/runtime/turnOutcomeStamp', () => ({
  recordTurnOutcomeStamp: vi.fn(),
}));
vi.mock('../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime', () => ({
  getConfiguredSurfaceExecutionRuntime: () => null,
}));
vi.mock('../../../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => [],
}));
vi.mock('../../../../src/host/mcp/cuaSessionLock', () => ({ releaseCuaLock: vi.fn() }));
vi.mock('../../../../src/host/mcp/cuaTrajectoryBudget', () => ({ resetCuaBudget: vi.fn() }));

import { RunFinalizer } from '../../../../src/host/agent/runtime/runFinalizer';
import {
  bindToolGrantDatabase,
  matchToolGrant,
  mintToolRunGrant,
} from '../../../../src/host/permissions/toolGrantStore';

describe('RunFinalizer 清 run 档工具授权（N-PERM-GRANT-TIERS）', () => {
  it('finalizeRun 后该会话的 run 档不再命中，其他会话不受影响', async () => {
    bindToolGrantDatabase(null, true);
    mintToolRunGrant('session-run-end', 'Write', null, 1);
    mintToolRunGrant('session-other', 'Write', null, 1);
    expect(matchToolGrant('session-run-end', 'Write', null, 2)).toBe('run');

    const events: AgentEvent[] = [];
    const finalizer = new RunFinalizer({
      sessionId: 'session-run-end',
      workingDirectory: process.cwd(),
      onEvent: (event: AgentEvent) => events.push(event),
      persistMessage: vi.fn(async () => undefined),
      modelConfig: { provider: 'test', model: 'test-model' },
      messages: [
        { id: 'user-1', role: 'user', content: '干活', timestamp: 1 } as Message,
        { id: 'assistant-1', role: 'assistant', content: '完成', timestamp: 2 } as Message,
      ],
      maxIterations: 10,
      stats: {
        traceId: 'trace-run-end',
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
      { generateId: () => 'fallback', addAndPersistMessage: vi.fn() } as never,
      { runSessionEndLearning: vi.fn(async () => undefined) } as never,
    );

    await finalizer.finalizeRun(
      1,
      '干活',
      { endTrace: vi.fn(), flush: vi.fn(async () => undefined) } as never,
      8,
      { status: 'failed', error: new Error('test terminal') },
    );

    expect(matchToolGrant('session-run-end', 'Write', null, 3)).toBe(null);
    expect(matchToolGrant('session-other', 'Write', null, 3)).toBe('run');
  });
});
