import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentEvent, Message } from '../../../../src/shared/contract';
import type { TraceTurn } from '../../../../src/shared/contract/trace';
import { buildTurnFileChanges } from '../../../../src/renderer/utils/turnDiffSummary';

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

describe('RunFinalizer turn_diff aggregation', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('turns a 200-line disk write into the authoritative fold count', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'run-finalizer-turn-diff-'));
    tempDirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const repoRoot = await realpath(repo);
    const outputPath = join(repoRoot, 'generated.txt');
    const content = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n');
    await writeFile(outputPath, content, 'utf8');

    const events: AgentEvent[] = [];
    const persistedMessages: Message[] = [];
    const assistantMessage = {
      id: 'assistant-turn-1',
      role: 'assistant' as const,
      content: '完成',
      timestamp: 2,
    };
    const finalizer = new RunFinalizer({
      sessionId: 'session-turn-diff',
      workingDirectory: repoRoot,
      onEvent: (event: AgentEvent) => events.push(event),
      persistMessage: vi.fn(async (message: Message) => { persistedMessages.push(message); }),
      modelConfig: { provider: 'test', model: 'test-model' },
      messages: [
        { id: 'user-1', role: 'user', content: '写 200 行', timestamp: 1 },
        assistantMessage,
      ],
      maxIterations: 10,
      stats: {
        traceId: 'trace-turn-diff',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        queueDiagnostic: vi.fn(),
      },
      control: { isCancelled: false, isInterrupted: false },
      circuitBreaker: { isTripped: () => false, reset: vi.fn() },
      nudgeManager: { getModifiedFiles: () => new Set([outputPath]) },
      turn: { currentTurnId: 'assistant-turn-1' },
    } as never);
    finalizer.setModules(
      { generateId: () => 'fallback', addAndPersistMessage: vi.fn() } as never,
      { runSessionEndLearning: vi.fn(async () => undefined) } as never,
    );

    await finalizer.finalizeRun(
      1,
      '写 200 行',
      { endTrace: vi.fn(), flush: vi.fn(async () => undefined) } as never,
      8,
      { status: 'failed', error: new Error('test terminal') },
    );

    const turnDiffEvent = events.find((event) => event.type === 'turn_diff');
    const turn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'completed',
      startTime: 1,
      endTime: 3,
      turnDiff: turnDiffEvent?.type === 'turn_diff' ? turnDiffEvent.data : undefined,
      nodes: [{
        id: 'tool-write',
        type: 'tool_call',
        content: '',
        timestamp: 2,
        toolCall: {
          id: 'tool-write',
          name: 'Write',
          args: { file_path: outputPath, content: 'line 1...[truncated]...line 200' },
          success: true,
        },
      }],
    };

    expect(buildTurnFileChanges(turn)[0].added).toBe(200);
    expect(turnDiffEvent).toMatchObject({
      type: 'turn_diff',
      data: { turnId: 'assistant-turn-1', files: [{ filePath: outputPath, added: 200 }] },
    });
    expect(persistedMessages.at(-1)?.metadata?.turnDiff).toEqual(
      turnDiffEvent?.type === 'turn_diff' ? turnDiffEvent.data : undefined,
    );
  });
});
