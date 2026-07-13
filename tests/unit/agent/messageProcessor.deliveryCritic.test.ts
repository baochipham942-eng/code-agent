// ============================================================================
// MessageProcessor Delivery Critic Tests — GAP-013: 交付前 critic 集成
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';

const sessionManagerState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageToSession: vi.fn(),
}));

const criticState = vi.hoisted(() => ({
  runDeliveryCritic: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/host/agent/deliveryCritic', () => ({
  runDeliveryCritic: criticState.runDeliveryCritic,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    tool: vi.fn(),
    browser: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';

function createProcessor(
  ctx: Partial<RuntimeContext>,
  contextAssembly: Partial<ContextAssembly> = {},
  runFinalizer: Partial<RunFinalizer> = {},
  toolEngine: Partial<ToolExecutionEngine> = {},
): MessageProcessor {
  return new MessageProcessor(
    ctx as RuntimeContext,
    contextAssembly as ContextAssembly,
    runFinalizer as RunFinalizer,
    toolEngine as ToolExecutionEngine,
  );
}

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'runtime-session-1',
    workingDirectory: '/tmp/project',
    messages: [{ id: 'user-1', role: 'user', content: '帮我重构这个模块', timestamp: Date.now() }],
    isCancelled: false,
    modelConfig: { provider: 'zhipu', model: 'glm-5', maxTokens: 16384 },
    effortLevel: 'medium',
    currentTurnId: 'turn-1',
    currentIterationSpanId: 'iteration-1',
    currentSystemPromptHash: 'hash-1',
    _researchModeActive: false,
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    hookManager: undefined,
    planningService: undefined,
    runAbortController: { signal: { aborted: false } },
    toolsUsedInTurn: [],
    isSimpleTaskMode: false,
    forceFinalResponseReason: undefined,
    forceFinalResponsePrompt: undefined,
    totalToolCallCount: 5,
    enableDeliveryCritic: true,
    nudgeManager: {
      runNudgeChecks: vi.fn(() => false),
      runOutputValidation: vi.fn(() => false),
      getModifiedFiles: vi.fn(
        () => new Set(['/tmp/project/a.ts', '/tmp/project/b.ts', '/tmp/project/c.ts']),
      ),
      getVerificationOutcome: vi.fn(() => 'none'),
    },
    onEvent: vi.fn(),
    telemetryAdapter: { onTurnEnd: vi.fn() },
    ...overrides,
  };
}

function buildContextAssembly(ctx: { messages: unknown[] }) {
  return {
    stripInternalFormatMimicry: vi.fn((content: string) => content),
    generateId: vi.fn().mockReturnValue('assistant-message-1'),
    addAndPersistMessage: vi.fn(async (message: unknown) => {
      ctx.messages.push(message);
    }),
    injectSystemMessage: vi.fn(),
    updateContextHealth: vi.fn(),
  };
}

function buildRunFinalizer() {
  return {
    emitTaskProgress: vi.fn(),
    emitTaskComplete: vi.fn(),
    tryParseTodosFromResponse: vi.fn(),
  };
}

const completeTextResponse = {
  type: 'text' as const,
  content: '重构完成，所有模块已更新。',
  finishReason: 'stop' as const,
  usage: { inputTokens: 1000, outputTokens: 100 },
};

describe('MessageProcessor delivery critic (GAP-013)', () => {
  beforeEach(() => {
    sessionManagerState.addMessage.mockReset();
    sessionManagerState.addMessageToSession.mockReset();
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
    criticState.runDeliveryCritic.mockReset();
  });

  it('blocks delivery and injects critique when critic finds critical issues', async () => {
    criticState.runDeliveryCritic.mockResolvedValue({
      pass: false,
      parsed: true,
      reason: 'a.ts 第 10 行有空指针风险\nVERDICT: FAIL',
    });
    const ctx = buildCtx();
    const contextAssembly = buildContextAssembly(ctx);
    const processor = createProcessor(ctx, contextAssembly, buildRunFinalizer());

    const action = await processor.handleTextResponse(
      completeTextResponse,
      false,
      3,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    expect(processor.guardStateForTest.deliveryCriticBlockCount).toBe(1);
    expect(criticState.runDeliveryCritic).toHaveBeenCalledWith(
      expect.arrayContaining(['/tmp/project/a.ts', '/tmp/project/b.ts', '/tmp/project/c.ts']),
      '帮我重构这个模块',
      expect.objectContaining({
        workingDirectory: '/tmp/project',
        sessionId: 'runtime-session-1',
      }),
      'none',
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<delivery-critic>'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('空指针'),
    );
  });

  it('proceeds with delivery when critic passes', async () => {
    criticState.runDeliveryCritic.mockResolvedValue({
      pass: true,
      parsed: true,
      reason: '无 Critical 问题\nVERDICT: PASS',
    });
    const ctx = buildCtx();
    const contextAssembly = buildContextAssembly(ctx);
    const runFinalizer = buildRunFinalizer();
    const processor = createProcessor(ctx, contextAssembly, runFinalizer);

    const action = await processor.handleTextResponse(
      completeTextResponse,
      false,
      3,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(criticState.runDeliveryCritic).toHaveBeenCalled();
    expect(processor.guardStateForTest.deliveryCriticBlockCount).toBe(0); // 通过不增计数
    expect(runFinalizer.emitTaskComplete).toHaveBeenCalled();
  });

  it('stops running critic after MAX_BLOCKS blocks (bounded retry, anti-loop)', async () => {
    criticState.runDeliveryCritic.mockResolvedValue({
      pass: false,
      parsed: true,
      reason: 'VERDICT: FAIL',
    });
    const ctx = buildCtx();
    const contextAssembly = buildContextAssembly(ctx);
    const runFinalizer = buildRunFinalizer();
    const processor = createProcessor(ctx, contextAssembly, runFinalizer);
    processor.guardStateForTest.deliveryCriticBlockCount = 3;

    const action = await processor.handleTextResponse(
      completeTextResponse,
      false,
      4,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(criticState.runDeliveryCritic).not.toHaveBeenCalled();
  });

  it('skips critic when modified files below threshold', async () => {
    const ctx = buildCtx({
      nudgeManager: {
        runNudgeChecks: vi.fn(() => false),
        runOutputValidation: vi.fn(() => false),
        getModifiedFiles: vi.fn(() => new Set(['/tmp/project/a.ts'])),
      },
    });
    const contextAssembly = buildContextAssembly(ctx);
    const processor = createProcessor(ctx, contextAssembly, buildRunFinalizer());

    const action = await processor.handleTextResponse(
      completeTextResponse,
      false,
      3,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(criticState.runDeliveryCritic).not.toHaveBeenCalled();
    expect(processor.guardStateForTest.deliveryCriticBlockCount).toBe(0);
  });

  it('skips critic when disabled', async () => {
    const ctx = buildCtx({ enableDeliveryCritic: false });
    const contextAssembly = buildContextAssembly(ctx);
    const processor = createProcessor(ctx, contextAssembly, buildRunFinalizer());

    const action = await processor.handleTextResponse(
      completeTextResponse,
      false,
      3,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(criticState.runDeliveryCritic).not.toHaveBeenCalled();
  });

  it('proceeds with delivery when critic throws (does not break the run)', async () => {
    criticState.runDeliveryCritic.mockRejectedValue(new Error('subagent crashed'));
    const ctx = buildCtx();
    const contextAssembly = buildContextAssembly(ctx);
    const runFinalizer = buildRunFinalizer();
    const processor = createProcessor(ctx, contextAssembly, runFinalizer);

    const action = await processor.handleTextResponse(
      completeTextResponse,
      false,
      3,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(runFinalizer.emitTaskComplete).toHaveBeenCalled();
  });
});
