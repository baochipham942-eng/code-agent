import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';

const sessionManagerState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageToSession: vi.fn(),
}));

const gameValidatorState = vi.hoisted(() => ({
  validateGameArtifact: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/host/agent/runtime/gameArtifactValidator', () => ({
  validateGameArtifact: gameValidatorState.validateGameArtifact,
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

vi.mock('../../../src/shared/utils/id', () => ({
  generateMessageId: () => 'steer-message-1',
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
import { TurnState } from '../../../src/host/agent/runtime/turnState';

function createProcessor(
  ctx: Partial<RuntimeContext>,
  contextAssembly: Partial<ContextAssembly> = {},
  runFinalizer: Partial<RunFinalizer> = {},
  toolEngine: Partial<ToolExecutionEngine> = {},
): MessageProcessor {
  // 就地补默认域状态，保留调用方 ctx 引用身份（测试会直接断言原对象字段）
  if (!ctx.turnQualityState) {
    ctx.turnQualityState = {};
  }
  return new MessageProcessor(
    ctx as RuntimeContext,
    contextAssembly as ContextAssembly,
    runFinalizer as RunFinalizer,
    toolEngine as ToolExecutionEngine,
  );
}

describe('MessageProcessor persistence', () => {
  beforeEach(() => {
    delete process.env.CODE_AGENT_CLI_MODE;
    sessionManagerState.addMessage.mockReset();
    sessionManagerState.addMessageToSession.mockReset();
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
    gameValidatorState.validateGameArtifact.mockReset();
    gameValidatorState.validateGameArtifact.mockResolvedValue({
      shouldValidate: true,
      passed: false,
      failures: ['still failing'],
      checks: [],
      artifactPath: '/tmp/game.html',
    });
  });

  it('persists injected steer messages to the runtime session instead of the global current session', () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
    };
    const processor = createProcessor(ctx);

    processor.injectSteerMessage('continue with care');

    expect(ctx.messages).toEqual([{
      id: 'steer-message-1',
      role: 'user',
      content: 'continue with care',
      timestamp: expect.any(Number),
    }]);
    expect(sessionManagerState.addMessageToSession).toHaveBeenCalledWith('runtime-session-1', ctx.messages[0]);
    expect(sessionManagerState.addMessage).not.toHaveBeenCalled();
  });

  it('reuses the renderer optimistic message id when provided', () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
    };
    const processor = createProcessor(ctx);

    processor.injectSteerMessage('continue with care', 'client-message-1');

    expect(ctx.messages).toEqual([{
      id: 'client-message-1',
      role: 'user',
      content: 'continue with care',
      timestamp: expect.any(Number),
    }]);
    expect(sessionManagerState.addMessageToSession).toHaveBeenCalledWith('runtime-session-1', ctx.messages[0]);
  });

  it('marks denied-tool stop messages as meta when the run history is hidden', async () => {
    const persistedMessages: unknown[] = [];
    const ctx = {
      deniedToolNames: ['AskUserQuestion'],
      maxToolCallRetries: 0,
      historyVisibility: 'meta',
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1' } as never),
      currentSystemPromptHash: 'hash-1',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 4096 },
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
    };
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      generateId: vi.fn(() => 'assistant-denied-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        persistedMessages.push(message);
      }),
    };
    const processor = createProcessor(ctx, contextAssembly);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'AskUserQuestion', arguments: { question: 'continue?' } }],
      } as ModelResponse,
      false,
      1,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(persistedMessages[0]).toMatchObject({
      id: 'assistant-denied-1',
      role: 'assistant',
      isMeta: true,
    });
    expect(ctx.onEvent).toHaveBeenCalledWith({
      type: 'message',
      data: expect.objectContaining({
        id: 'assistant-denied-1',
        isMeta: true,
      }),
    });
  });

  it('does not persist tool results when the run is cancelled after execution returns', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      totalToolCallCount: 0,
      modelConfig: { maxTokens: 4096 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      nudgeManager: {
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn()
        .mockReturnValueOnce('assistant-message-1')
        .mockReturnValueOnce('tool-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => {
        ctx.isCancelled = true;
        return [{ toolCallId: 'tool-1', success: true, output: 'late result' }];
      }),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'read_file', arguments: { path: 'a.txt' } }],
      } as ModelResponse,
      false,
      1,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(contextAssembly.addAndPersistMessage).toHaveBeenCalledTimes(1);
    expect(ctx.messages).toEqual([
      expect.objectContaining({ id: 'assistant-message-1', role: 'assistant' }),
    ]);
    expect(runFinalizer.tryParseTodosFromResponse).not.toHaveBeenCalled();
    expect(runFinalizer.autoAdvanceTodos).not.toHaveBeenCalled();
    expect(ctx.telemetryAdapter.onTurnEnd).not.toHaveBeenCalled();
    expect(ctx.onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_end' }));
  });

  it('persists truncated text before asking the next iteration to continue', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      modelConfig: { model: 'mimo-v2.5-pro', maxTokens: 4096 },
      MAX_CONSECUTIVE_TRUNCATIONS: 3,
      hookManager: undefined,
      planningService: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', researchModeActive: false, toolsUsedInTurn: [], isSimpleTaskMode: false } as never),
      nudgeManager: {
        runNudgeChecks: vi.fn(),
        runOutputValidation: vi.fn(),
      },
      onEvent: vi.fn(),
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn().mockReturnValue('assistant-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      injectSystemMessage: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer);

    const action = await processor.handleTextResponse(
      {
        type: 'text',
        content: '```ts\nexport const longFile = [\n  "part one",',
        truncated: true,
        finishReason: 'length',
        usage: { inputTokens: 1000, outputTokens: 4096 },
      },
      false,
      1,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    expect(contextAssembly.addAndPersistMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'assistant-message-1',
        role: 'assistant',
        content: expect.stringContaining('part one'),
      }),
    );
    expect(ctx.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('part one') }),
    ]);
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('Continue from exactly where your previous response stopped'),
    );
    expect(ctx.modelConfig.maxTokens).toBeGreaterThan(4096);
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        data: expect.objectContaining({ id: 'assistant-message-1' }),
      }),
    );
  });

  it('continues when a provider reports stop on an obviously unfinished sentence', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      modelConfig: { model: 'mimo-v2.5-pro', maxTokens: 4096 },
      MAX_CONSECUTIVE_TRUNCATIONS: 3,
      hookManager: undefined,
      planningService: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', researchModeActive: false, toolsUsedInTurn: [], isSimpleTaskMode: false } as never),
      nudgeManager: {
        runNudgeChecks: vi.fn(),
        runOutputValidation: vi.fn(),
      },
      onEvent: vi.fn(),
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn().mockReturnValue('assistant-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      injectSystemMessage: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer);

    const action = await processor.handleTextResponse(
      {
        type: 'text',
        content: '三个版本硬件完全一样，差别在这些地方：\n\nGoogle Assistant\n国行版把这',
        truncated: false,
        finishReason: 'stop',
        usage: { inputTokens: 1000, outputTokens: 128 },
      },
      false,
      1,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    expect(contextAssembly.addAndPersistMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('国行版把这'),
      }),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('Continue from exactly where your previous response stopped'),
    );
    expect(ctx.modelConfig.maxTokens).toBe(4096);
    expect(runFinalizer.emitTaskProgress).toHaveBeenCalledWith(
      'generating',
      '回复疑似未完，继续生成剩余内容...',
    );
  });

  it('boosts truncated tool calls to the provider output limit', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', needsReinference: false, toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        patched: false,
      },
      nudgeManager: {
        getModifiedFiles: vi.fn(() => new Set()),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn()
        .mockReturnValueOnce('assistant-message-1')
        .mockReturnValueOnce('tool-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => [
        { toolCallId: 'tool-1', success: true, output: 'ok' },
      ]),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: '',
        truncated: true,
        toolCalls: [{ id: 'tool-1', name: 'write_file', arguments: { path: '/tmp/a.html' } }],
      } as ModelResponse,
      false,
      1,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    expect(ctx.modelConfig.maxTokens).toBe(131072);
    expect(toolEngine.executeToolsWithHooks).toHaveBeenCalledTimes(1);
  });

  it('persists a final assistant message and stops when artifact repair is already validated', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: 'artifact repair target already passes validation after blocked Read read',
      forceFinalResponsePrompt: '<force-final-response>done</force-final-response>',
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', needsReinference: false, toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      nudgeManager: {
        getModifiedFiles: vi.fn(() => new Set()),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn()
        .mockReturnValueOnce('assistant-message-1')
        .mockReturnValueOnce('tool-message-1')
        .mockReturnValueOnce('final-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => [
        { toolCallId: 'tool-1', success: true, output: 'ok' },
      ]),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'Read', arguments: { file_path: '/tmp/game.html' } }],
      } as ModelResponse,
      false,
      1,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(ctx.forceFinalResponseReason).toBeUndefined();
    expect(ctx.forceFinalResponsePrompt).toBeUndefined();
    expect(contextAssembly.addAndPersistMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'final-message-1',
        role: 'assistant',
        content: '目标产物已通过交互验收，修复流程已结束。',
      }),
    );
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        data: expect.objectContaining({ id: 'final-message-1' }),
      }),
    );
    expect(ctx.telemetryAdapter.onTurnEnd).toHaveBeenCalledTimes(1);
    expect(contextAssembly.flushHookMessageBuffer).toHaveBeenCalledTimes(1);
  });

  it('defers read-loop hard limit final content to a no-tool inference pass', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', needsReinference: false, toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      nudgeManager: {
        getModifiedFiles: vi.fn(() => new Set()),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn()
        .mockReturnValueOnce('assistant-message-1')
        .mockReturnValueOnce('tool-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => {
        ctx.forceFinalResponseReason = '连续只读操作达到硬阈值，最后一次工具为 Read';
        ctx.forceFinalResponsePrompt = [
          '<force-final-response reason="read-loop-hard-limit">',
          'Produce the final answer now.',
          '</force-final-response>',
        ].join('\n');
        return [{
          toolCallId: 'tool-1',
          success: false,
          error: 'read loop hard limit',
          duration: 1,
        }];
      }),
    };
    const endSpan = vi.fn();
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'Read', arguments: { file_path: '/tmp/evidence.txt' } }],
      } as ModelResponse,
      false,
      1,
      { endSpan },
    );

    expect(action).toBe('continue');
    expect(ctx.forceFinalResponseReason).toBe('连续只读操作达到硬阈值，最后一次工具为 Read');
    expect(ctx.forceFinalResponsePrompt).toContain('reason="read-loop-hard-limit"');
    expect(contextAssembly.addAndPersistMessage).toHaveBeenCalledTimes(2);
    expect(ctx.messages).toEqual([
      expect.objectContaining({
        id: 'assistant-message-1',
        role: 'assistant',
      }),
      expect.objectContaining({
        id: 'tool-message-1',
        role: 'tool',
      }),
    ]);
    expect(ctx.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: '任务已结束，已停止继续调用工具。执行记录和产物已保留。',
        }),
      ]),
    );
    expect(endSpan).toHaveBeenCalledWith(
      'iteration-1',
      expect.objectContaining({ forcedFinalResponseDeferred: true }),
    );
    expect(ctx.telemetryAdapter.onTurnEnd).toHaveBeenCalledWith('turn-1', '', undefined, 'hash-1');
    expect(ctx.onEvent).toHaveBeenCalledWith({
      type: 'turn_end',
      data: { turnId: 'turn-1' },
    });
  });

  it('persists the deferred read-loop final text and clears force-final state without another nudge', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [{ id: 'user-1', role: 'user', content: '分析一下 Alma 的流式输出', timestamp: Date.now() }],
      isCancelled: false,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      MAX_CONSECUTIVE_TRUNCATIONS: 3,
      hookManager: undefined,
      planningService: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', researchModeActive: false, toolsUsedInTurn: ['Glob', 'Bash', 'Bash'], isSimpleTaskMode: false } as never),
      forceFinalResponseReason: '连续只读操作达到硬阈值，最后一次工具为 Bash',
      forceFinalResponsePrompt: '<force-final-response reason="read-loop-hard-limit">Produce final answer.</force-final-response>',
      totalToolCallCount: 3,
      nudgeManager: {
        runNudgeChecks: vi.fn(() => true),
        runOutputValidation: vi.fn(() => true),
        getModifiedFiles: vi.fn(() => new Set()),
      },
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn().mockReturnValue('final-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      injectSystemMessage: vi.fn(),
      updateContextHealth: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      emitTaskComplete: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
    };
    const endSpan = vi.fn();
    const processor = createProcessor(ctx, contextAssembly, runFinalizer);

    const action = await processor.handleTextResponse(
      {
        type: 'text',
        content: '基于已有证据，Alma 的主进程入口包含 SSE/ReadableStream 相关实现。',
        finishReason: 'stop',
      } as ModelResponse,
      false,
      2,
      true,
      { endSpan },
    );

    expect(action).toBe('break');
    expect(ctx.nudgeManager.runNudgeChecks).not.toHaveBeenCalled();
    expect(ctx.nudgeManager.runOutputValidation).not.toHaveBeenCalled();
    expect(ctx.forceFinalResponseReason).toBeUndefined();
    expect(ctx.forceFinalResponsePrompt).toBeUndefined();
    expect(contextAssembly.addAndPersistMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'final-message-1',
        role: 'assistant',
        content: expect.stringContaining('ReadableStream'),
      }),
    );
    expect(endSpan).toHaveBeenCalledWith('iteration-1', { type: 'text_response' });
    expect(ctx.telemetryAdapter.onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('persists artifact repair target reads as an immediate anchored preview', async () => {
    const largeHtml = [
      '<!doctype html>',
      '<html>',
      '<body>',
      '<script>',
      `const filler = '${'x'.repeat(18000)}';`,
      'window.__GAME_META__ = {',
      "  progressPlan: [{ input: ['ArrowRight'], metric: 'score', expect: 'increase' }],",
      '};',
      'window.__GAME_TEST__ = {',
      '  start() { return true; },',
      '  reset() { return true; },',
      '  snapshot() { return { score: 0 }; },',
      '  step(input, frames) { return this.snapshot(); },',
      '  runSmokeTest() { return { passed: false, failures: ["score"], coverage: {} }; },',
      '};',
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', needsReinference: false, toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'playability_repair',
        patched: false,
      },
      nudgeManager: {
        getModifiedFiles: vi.fn(() => new Set()),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn()
        .mockReturnValueOnce('assistant-message-1')
        .mockReturnValueOnce('tool-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      formatArtifactRepairToolResultContent: vi.fn((_result, originalContent: string) => [
        '<artifact-repair-file-read>',
        'Target file already read: /tmp/game.html',
        'History preview compressed for repair mode.',
        originalContent.slice(0, 300),
        'Critical repair sections are preserved below. Do not re-read the target file in this repair pass; write the patch now.',
        '</artifact-repair-file-read>',
      ].join('\n')),
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => [
        {
          toolCallId: 'tool-1',
          success: true,
          output: largeHtml,
          metadata: {
            preserveObservation: true,
            evidenceKind: 'file_read',
            filePath: '/tmp/game.html',
          },
        },
      ]),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'Read', arguments: { file_path: '/tmp/game.html' } }],
      } as ModelResponse,
      false,
      1,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    const toolMessage = ctx.messages.find((message: any) => message.role === 'tool') as any;
    expect(contextAssembly.formatArtifactRepairToolResultContent).toHaveBeenCalledTimes(1);
    expect(toolMessage.content).toContain('<artifact-repair-file-read>');
    expect(toolMessage.toolResults[0].metadata.artifactRepairPreview).toBe(true);
    expect(toolMessage.toolResults[0].output).not.toContain('x'.repeat(4000));
  });

  it('does not compress preserved Computer read observations before the next model turn', async () => {
    const largeObservation = [
      'Found 2 background CGEvent window candidates for targetApp=TencentMeeting.',
      'Target matches: 2 for targetApp=TencentMeeting -> 腾讯会议/com.tencent.meeting "Standup" pid=202 windowId=21; 腾讯会议/com.tencent.meeting "Share" pid=202 windowId=22',
      'Recommended window: 腾讯会议/com.tencent.meeting "Standup" · pid=202 · windowId=21',
      'Visible apps: WeChat/com.tencent.xin x2; 腾讯会议/com.tencent.meeting x2',
      'Window candidates:',
      '腾讯会议 "Standup" · bundleId=com.tencent.meeting · pid=202 · windowId=21',
      '腾讯会议 "Share" · bundleId=com.tencent.meeting · pid=202 · windowId=22',
      'filler '.repeat(2000),
    ].join('\n');
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      nudgeManager: {
        getModifiedFiles: vi.fn(() => new Set()),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn()
        .mockReturnValueOnce('assistant-message-1')
        .mockReturnValueOnce('tool-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => [
        {
          toolCallId: 'tool-1',
          success: true,
          output: largeObservation,
          metadata: {
            preserveObservation: true,
            observationKind: 'computer_surface_read',
            targetApp: 'TencentMeeting',
          },
        },
      ]),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'computer_use', arguments: { action: 'get_windows', targetApp: 'TencentMeeting' } }],
      } as ModelResponse,
      false,
      1,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    const toolMessage = ctx.messages.find((message: any) => message.role === 'tool') as any;
    expect(toolMessage.toolResults[0].output).toBe(largeObservation);
    expect(toolMessage.toolResults[0].metadata.preserveObservation).toBe(true);
  });

  it('persists fresh tool observations verbatim — no eager compression before the model sees them', async () => {
    // 复现 image_analyze 场景：~2000 token 中文分析结果，无 preserveObservation。
    // 此前落库即被 compressToolResult(300→200) 砍成带 "[N lines truncated]" 的存根，
    // 模型看不到完整结果 → 重复调用 + 自述"被截断"。大结果统一交 L1(2000+落盘) 处理。
    const largeAnalysis = [
      '📷 图片分析结果',
      '文件: screenshot.png',
      '耗时: 19.2s',
      '',
      ...Array.from({ length: 60 }, (_, i) => `第${i + 1}行：屏幕上可以看到一个深色主题的代码编辑器窗口，顶部有标签栏与菜单。`),
    ].join('\n');
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      nudgeManager: {
        getModifiedFiles: vi.fn(() => new Set()),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn()
        .mockReturnValueOnce('assistant-message-1')
        .mockReturnValueOnce('tool-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => [
        {
          toolCallId: 'tool-1',
          success: true,
          output: largeAnalysis,
          metadata: { imagePath: '/tmp/screenshot.png', contentLength: largeAnalysis.length },
        },
      ]),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'image_analyze', arguments: { path: '/tmp/screenshot.png' } }],
      } as ModelResponse,
      false,
      1,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    const toolMessage = ctx.messages.find((message: any) => message.role === 'tool') as any;
    expect(toolMessage.toolResults[0].output).toBe(largeAnalysis);
    expect(toolMessage.toolResults[0].output).not.toContain('truncated');
  });

  it('drops tool calls that are outside the currently visible tool schema and reinfers', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', needsReinference: false, toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        patched: false,
      },
      nudgeManager: {
        getModifiedFiles: vi.fn(() => new Set()),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn()
        .mockReturnValueOnce('assistant-message-1')
        .mockReturnValueOnce('tool-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => [
        { toolCallId: 'tool-1', success: true, output: 'ok' },
      ]),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: 'let me inspect the validator',
        toolCalls: [{ id: 'tool-1', name: 'Read', arguments: { file_path: '/tmp/validator.ts' } }],
        runtimeDiagnostics: {
          visibleToolNames: ['Edit', 'Write', 'Append'],
        },
      } as ModelResponse,
      false,
      1,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<tool-admission-repair>'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-repair-admission-blocked>'),
    );
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenCalledWith(
      expect.stringContaining('Your previous tool call requested unavailable tools: Read.'),
    );
    expect(ctx.artifactRepairGuard.repairTurnsWithoutProgress).toBe(1);
    expect(ctx.artifactRepairGuard.lastBlockedTool).toBe('Read');
    expect(contextAssembly.addAndPersistMessage).toHaveBeenCalledTimes(2);
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'tool-1', name: 'Read' }],
    });
    expect(ctx.messages[1]).toMatchObject({
      role: 'tool',
      toolResults: [{
        toolCallId: 'tool-1',
        success: false,
        metadata: {
          artifactRepairGuard: expect.objectContaining({
            blocked: true,
            unavailableTool: true,
            targetFile: '/tmp/game.html',
            repairTurnsWithoutProgress: 1,
          }),
        },
      }],
    });
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_call_end',
        data: expect.objectContaining({
          toolCallId: 'tool-1',
          success: false,
        }),
      }),
    );
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
  });

  it('clears completed artifact repair before blocking unavailable tools', async () => {
    gameValidatorState.validateGameArtifact.mockResolvedValue({
      shouldValidate: true,
      passed: true,
      failures: [],
      checks: ['runtime smoke passed', 'browser visual smoke passed'],
      artifactPath: '/tmp/game.html',
    });

    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', needsReinference: false, toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        patched: false,
      },
      nudgeManager: {
        getModifiedFiles: vi.fn(() => new Set()),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn(),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => [
        { toolCallId: 'tool-1', success: true, output: 'ok' },
      ]),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: 'verify it now',
        toolCalls: [{ id: 'tool-1', name: 'Bash', arguments: { command: 'node validate.js' } }],
        runtimeDiagnostics: {
          visibleToolNames: ['Edit', 'Write', 'Append'],
        },
      } as ModelResponse,
      false,
      2,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    // admission 复验与 lifecycle 同口径：无 goalMode 走 light + 可玩性冒烟
    expect(gameValidatorState.validateGameArtifact).toHaveBeenCalledWith('/tmp/game.html', expect.objectContaining({
      contractLevel: 'light',
      runRuntimeSmoke: false,
      requireRuntimeSmoke: false,
      runBrowserVisualSmoke: false,
      requireBrowserVisualSmoke: false,
      allowBrowserVisualComputerFallback: false,
      runLightPlayabilitySmoke: true,
    }));
    expect(ctx.artifactRepairGuard).toBeUndefined();
    expect(ctx.forceFinalResponseReason).toBeUndefined();
    expect(ctx.forceFinalResponsePrompt).toBeUndefined();
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('artifact repair guard revalidated the target before accepting another repair-mode tool call.'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('The repair guard has been cleared. Retry the user requested action with the full tool set if needed.'),
    );
    expect(contextAssembly.addAndPersistMessage).not.toHaveBeenCalled();
    expect(ctx.messages).toHaveLength(0);
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
  });

  it('clears completed artifact repair before executing a visible mutation tool', async () => {
    gameValidatorState.validateGameArtifact.mockResolvedValue({
      shouldValidate: true,
      passed: true,
      failures: [],
      checks: ['runtime smoke passed'],
      artifactPath: '/tmp/game.html',
    });

    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', needsReinference: false, toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        patched: false,
      },
      nudgeManager: {
        getModifiedFiles: vi.fn(() => new Set()),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn(),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => [
        { toolCallId: 'tool-1', success: true, output: 'changed' },
      ]),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: '目标产物已通过交互验收，修复流程已结束。',
        toolCalls: [{ id: 'tool-1', name: 'Edit', arguments: { file_path: '/tmp/game.html' } }],
        runtimeDiagnostics: {
          visibleToolNames: ['Edit', 'Write', 'Append'],
        },
      } as ModelResponse,
      false,
      2,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    expect(ctx.artifactRepairGuard).toBeUndefined();
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('requested tools: Edit'),
    );
    expect(contextAssembly.addAndPersistMessage).not.toHaveBeenCalled();
    expect(ctx.messages).toHaveLength(0);
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
  });

  it('forces the artifact repair attempt to stop after repeated unavailable tool requests', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', needsReinference: false, toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        repairTurnsWithoutProgress: 1,
        patched: false,
      },
      nudgeManager: {
        getModifiedFiles: vi.fn(() => new Set()),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn()
        .mockReturnValueOnce('assistant-message-1')
        .mockReturnValueOnce('tool-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => [
        { toolCallId: 'tool-1', success: true, output: 'ok' },
      ]),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: 'retry read again',
        toolCalls: [{ id: 'tool-1', name: 'Read', arguments: { file_path: '/tmp/game.html', offset: 900, limit: 120 } }],
        runtimeDiagnostics: {
          visibleToolNames: ['Edit', 'Write', 'Append'],
        },
      } as ModelResponse,
      false,
      2,
      { endSpan: vi.fn() },
    );

    // Route A: an unavailable-tool turn bumps repairTurnsWithoutProgress, but the
    // hard stop only fires once it reaches ARTIFACT_REPAIR_MAX_ATTEMPTS (4).
    expect(action).toBe('continue');
    expect(ctx.artifactRepairGuard.repairTurnsWithoutProgress).toBe(2);
    expect(ctx.forceFinalResponseReason).toBeUndefined();
    expect(ctx.forceFinalResponsePrompt).toBeUndefined();
    expect(contextAssembly.addAndPersistMessage).toHaveBeenCalledTimes(2);
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[1]).toMatchObject({
      role: 'tool',
      toolResults: [{
        toolCallId: 'tool-1',
        success: false,
        metadata: {
          artifactRepairGuard: expect.objectContaining({
            blocked: true,
            unavailableTool: true,
            targetFile: '/tmp/game.html',
            repairTurnsWithoutProgress: 2,
          }),
        },
      }],
    });
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
  });

  it('force-stops the artifact repair attempt once the no-progress counter hits the limit', async () => {
    const ctx = {
      sessionId: 'runtime-session-stop',
      messages: [] as never[],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined as string | undefined,
      forceFinalResponsePrompt: undefined as string | undefined,
      turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', needsReinference: false, toolsUsedInTurn: [] } as never),
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        repairTurnsWithoutProgress: 3,
        patched: false,
      },
      nudgeManager: {
        getModifiedFiles: vi.fn(() => new Set()),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      },
    };
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn()
        .mockReturnValueOnce('assistant-message-1')
        .mockReturnValueOnce('tool-message-1')
        .mockReturnValueOnce('final-message-1'),
      addAndPersistMessage: vi.fn(async (message) => {
        ctx.messages.push(message as never);
      }),
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async () => []),
    };
    const processor = createProcessor(ctx, contextAssembly, runFinalizer, toolEngine);

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: 'read the validator again',
        toolCalls: [{ id: 'tool-1', name: 'Read', arguments: { file_path: '/tmp/validator.ts' } }],
        runtimeDiagnostics: {
          visibleToolNames: ['Edit', 'Write', 'Append'],
        },
      } as ModelResponse,
      false,
      4,
      { endSpan: vi.fn() },
    );

    // repairTurnsWithoutProgress 3 -> 4 reaches ARTIFACT_REPAIR_MAX_ATTEMPTS, so the
    // turn is force-stopped instead of re-inferred.
    expect(action).toBe('break');
    expect(ctx.artifactRepairGuard.repairTurnsWithoutProgress).toBe(4);
    expect(ctx.forceFinalResponseReason).toBeUndefined();
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ code: 'artifact_repair_admission_stop' }),
      }),
    );
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
  });
});
