import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../../../src/main/agent/loopTypes';
import type { RuntimeContext } from '../../../src/main/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/main/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/main/agent/runtime/runFinalizer';
import type { ToolExecutionEngine } from '../../../src/main/agent/runtime/toolExecutionEngine';

const sessionManagerState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageToSession: vi.fn(),
}));

const gameValidatorState = vi.hoisted(() => ({
  validateGameArtifact: vi.fn(),
}));

vi.mock('../../../src/main/services', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/main/agent/runtime/gameArtifactValidator', () => ({
  validateGameArtifact: gameValidatorState.validateGameArtifact,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
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

vi.mock('../../../src/main/mcp/logCollector.js', () => ({
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

import { MessageProcessor } from '../../../src/main/agent/runtime/messageProcessor';

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

  it('does not persist tool results when the run is cancelled after execution returns', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      totalToolCallCount: 0,
      modelConfig: { maxTokens: 4096 },
      effortLevel: 'medium',
      currentTurnId: 'turn-1',
      currentIterationSpanId: 'iteration-1',
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      toolsUsedInTurn: [],
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
      effortLevel: 'medium',
      _researchModeActive: false,
      _consecutiveTruncations: 0,
      MAX_CONSECUTIVE_TRUNCATIONS: 3,
      hookManager: undefined,
      planningService: undefined,
      toolsUsedInTurn: [],
      isSimpleTaskMode: false,
      nudgeManager: {
        runNudgeChecks: vi.fn(),
        runOutputValidation: vi.fn(),
      },
      antiScrapingHitsInRun: 0,
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

  it('boosts truncated tool calls to the provider output limit', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      effortLevel: 'medium',
      currentTurnId: 'turn-1',
      currentIterationSpanId: 'iteration-1',
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      needsReinference: false,
      recentToolFingerprints: [],
      stagnationWarningEmitted: false,
      antiScrapingHitsInRun: 0,
      toolsUsedInTurn: [],
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        blockedToolCount: 0,
        targetReadCount: 1,
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
      effortLevel: 'medium',
      currentTurnId: 'turn-1',
      currentIterationSpanId: 'iteration-1',
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: 'artifact repair target already passes validation after blocked Read read',
      forceFinalResponsePrompt: '<force-final-response>done</force-final-response>',
      needsReinference: false,
      recentToolFingerprints: [],
      stagnationWarningEmitted: false,
      antiScrapingHitsInRun: 0,
      toolsUsedInTurn: [],
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
      effortLevel: 'medium',
      currentTurnId: 'turn-1',
      currentIterationSpanId: 'iteration-1',
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      needsReinference: false,
      recentToolFingerprints: [],
      stagnationWarningEmitted: false,
      antiScrapingHitsInRun: 0,
      toolsUsedInTurn: [],
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'playability_repair',
        blockedToolCount: 0,
        targetReadCount: 1,
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

  it('drops tool calls that are outside the currently visible tool schema and reinfers', async () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
      isCancelled: false,
      isInterrupted: false,
      runAbortController: { signal: { aborted: false } },
      totalToolCallCount: 0,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', maxTokens: 16384 },
      effortLevel: 'medium',
      currentTurnId: 'turn-1',
      currentIterationSpanId: 'iteration-1',
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      needsReinference: false,
      recentToolFingerprints: [],
      stagnationWarningEmitted: false,
      antiScrapingHitsInRun: 0,
      toolsUsedInTurn: [],
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        blockedToolCount: 0,
        targetReadCount: 1,
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
    expect(ctx.artifactRepairGuard.blockedToolCount).toBe(1);
    expect(ctx.artifactRepairGuard.lastBlockedTool).toBe('Read');
    expect(ctx.artifactRepairGuard.noOpPatchCount).toBeUndefined();
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
            blockedToolCount: 1,
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
      effortLevel: 'medium',
      currentTurnId: 'turn-1',
      currentIterationSpanId: 'iteration-1',
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      needsReinference: false,
      recentToolFingerprints: [],
      stagnationWarningEmitted: false,
      antiScrapingHitsInRun: 0,
      toolsUsedInTurn: [],
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        blockedToolCount: 2,
        targetReadCount: 1,
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
    expect(gameValidatorState.validateGameArtifact).toHaveBeenCalledWith('/tmp/game.html', {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 7000,
      runBrowserVisualSmoke: true,
      browserVisualSmokeTimeoutMs: 10000,
    });
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
      effortLevel: 'medium',
      currentTurnId: 'turn-1',
      currentIterationSpanId: 'iteration-1',
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      needsReinference: false,
      recentToolFingerprints: [],
      stagnationWarningEmitted: false,
      antiScrapingHitsInRun: 0,
      toolsUsedInTurn: [],
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        blockedToolCount: 2,
        targetReadCount: 1,
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
      effortLevel: 'medium',
      currentTurnId: 'turn-1',
      currentIterationSpanId: 'iteration-1',
      currentSystemPromptHash: 'hash-1',
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      needsReinference: false,
      recentToolFingerprints: [],
      stagnationWarningEmitted: false,
      antiScrapingHitsInRun: 0,
      toolsUsedInTurn: [],
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        blockedToolCount: 1,
        targetReadCount: 1,
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

    expect(action).toBe('continue');
    expect(ctx.artifactRepairGuard.blockedToolCount).toBe(2);
    expect(ctx.artifactRepairGuard.noOpPatchCount).toBe(1);
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
            blockedToolCount: 2,
            noOpPatchCount: 1,
          }),
        },
      }],
    });
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
  });
});
