import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionManagerState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageToSession: vi.fn(),
}));

vi.mock('../../../src/main/services', () => ({
  getSessionManager: () => sessionManagerState,
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

describe('MessageProcessor persistence', () => {
  beforeEach(() => {
    delete process.env.CODE_AGENT_CLI_MODE;
    sessionManagerState.addMessage.mockReset();
    sessionManagerState.addMessageToSession.mockReset();
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
  });

  it('persists injected steer messages to the runtime session instead of the global current session', () => {
    const ctx = {
      sessionId: 'runtime-session-1',
      messages: [],
    };
    const processor = new MessageProcessor(ctx as any, {} as any, {} as any, {} as any);

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
    const processor = new MessageProcessor(ctx as any, {} as any, {} as any, {} as any);

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
    const processor = new MessageProcessor(
      ctx as any,
      contextAssembly as any,
      runFinalizer as any,
      toolEngine as any,
    );

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'read_file', arguments: { path: 'a.txt' } }],
      } as any,
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
});
