import { describe, expect, it, vi } from 'vitest';
import type { Message, ToolCall } from '../../../src/shared/contract';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { TurnState } from '../../../src/host/agent/runtime/turnState';

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => ({ addMessageToSession: vi.fn() }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    tool: vi.fn(),
    browser: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';
import { persistCancelledToolCallClosures } from '../../../src/host/agent/runtime/cancelledToolCallClosure';

const CANCELLED_PLACEHOLDER =
  '[no result: this tool call was cancelled before a result was recorded; do not assume it ran or succeeded]';

type StopKind = 'cancelled' | 'interrupted' | 'aborted';

function createHarness(stopKind: StopKind, messages: Message[] = []) {
  const runAbortController = new AbortController();
  const control = ControlState.forTest({
    isCancelled: false,
    isInterrupted: false,
    runAbortController,
  });
  const ctx = {
    artifact: ArtifactState.forTest(),
    sessionId: 'cancel-closure-session',
    messages,
    stats: RunStatsState.forTest({ totalToolCallCount: 0 } as never),
    modelConfig: { provider: 'openai', model: 'test-model', maxTokens: 4096 },
    contextHealth: ContextHealthState.forTest({ currentSystemPromptHash: 'hash-1' } as never),
    control,
    turn: TurnState.forTest({
      effortLevel: 'medium',
      currentTurnId: 'turn-1',
      currentIterationSpanId: 'iteration-1',
      toolsUsedInTurn: [],
    } as never),
    onEvent: vi.fn(),
    telemetryAdapter: { onTurnEnd: vi.fn() },
    nudgeManager: {
      checkProgressState: vi.fn(),
      checkPostForceExecute: vi.fn(),
    },
    turnQualityState: {},
  } as unknown as RuntimeContext;
  const addAndPersistMessage = vi.fn(async (message: Message) => {
    ctx.messages.push(message);
  });
  const contextAssembly = {
    stripInternalFormatMimicry: vi.fn((content: string) => content),
    generateId: vi.fn(() => 'assistant-cancelled-1'),
    addAndPersistMessage,
  } as unknown as ContextAssembly;
  const toolEngine = {
    executeToolsWithHooks: vi.fn(async () => {
      if (stopKind === 'cancelled') control.markCancelled();
      if (stopKind === 'interrupted') control.markInterrupted();
      if (stopKind === 'aborted') control.abortRun();
      return [
        { toolCallId: 'call-1', success: true, output: 'suppressed result one' },
        { toolCallId: 'call-2', success: true, output: 'suppressed result two' },
      ];
    }),
  } as unknown as ToolExecutionEngine;
  const processor = new MessageProcessor(
    ctx,
    contextAssembly,
    {
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
    } as unknown as RunFinalizer,
    toolEngine,
  );
  return { addAndPersistMessage, ctx, processor };
}

const toolCalls: ToolCall[] = [
  { id: 'call-1', name: 'write_file', arguments: { path: 'one.txt' } },
  { id: 'call-2', name: 'bash', arguments: { command: 'work' } },
];

const response: ModelResponse = {
  type: 'tool_use',
  content: '',
  toolCalls,
};

async function runStoppedToolResponse(stopKind: StopKind) {
  const harness = createHarness(stopKind);
  const action = await harness.processor.handleToolResponse(
    response,
    false,
    1,
    { endSpan: vi.fn() },
  );
  return { ...harness, action };
}

function expectCompleteCancelledClosures(messages: Message[]): void {
  const toolMessages = messages.filter((message) => message.role === 'tool');
  expect(toolMessages).toHaveLength(1);
  expect(toolMessages[0].toolResults).toEqual([
    { toolCallId: 'call-1', success: false, error: CANCELLED_PLACEHOLDER, duration: 0 },
    { toolCallId: 'call-2', success: false, error: CANCELLED_PLACEHOLDER, duration: 0 },
  ]);
  expect(toolMessages[0].content).not.toContain('suppressed result');
}

describe('MessageProcessor cancelled tool-call persistence', () => {
  it('persists honest closures for every tool call when cancellation wins the race', async () => {
    const { action, ctx } = await runStoppedToolResponse('cancelled');
    expect(action).toBe('break');
    expectCompleteCancelledClosures(ctx.messages);
  });

  it('persists honest closures for every tool call when interruption wins the race', async () => {
    const { action, ctx } = await runStoppedToolResponse('interrupted');
    expect(action).toBe('break');
    expectCompleteCancelledClosures(ctx.messages);
  });

  it('persists honest closures for every tool call when the run abort signal wins the race', async () => {
    const { action, ctx } = await runStoppedToolResponse('aborted');
    expect(action).toBe('break');
    expectCompleteCancelledClosures(ctx.messages);
  });

  it('does not persist a second closure when the same assistant turn is finalized twice', async () => {
    const { addAndPersistMessage, processor, ctx } = createHarness('cancelled');

    await processor.handleToolResponse(response, false, 1, { endSpan: vi.fn() });
    await processor.handleToolResponse(response, false, 1, { endSpan: vi.fn() });

    const closureWrites = addAndPersistMessage.mock.calls
      .map(([message]) => message as Message)
      .filter((message) => message.role === 'tool');
    expect(closureWrites).toHaveLength(1);
    expectCompleteCancelledClosures(ctx.messages);
  });

  it.each([
    ['normal completion', { toolCallId: 'call-1', success: true, output: 'completed' }],
    ['manual rejection', { toolCallId: 'call-1', success: false, error: 'Permission denied by user' }],
    ['approval timeout', {
      toolCallId: 'call-1',
      success: false,
      error: 'Write 被自动拒绝：审批请求已发出但超时无人应答。出路：请用户在收件箱/会话卡上处理后重试。',
    }],
  ])('leaves the persisted %s tool-result shape unchanged', async (_label, toolResult) => {
    const assistantMessage: Message = {
      id: 'assistant-existing-result',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [toolCalls[0]],
    };
    const toolMessage: Message = {
      id: 'tool-existing-result',
      role: 'tool',
      content: JSON.stringify([toolResult]),
      timestamp: 2,
      toolResults: [toolResult],
    };
    const messages = [assistantMessage, toolMessage];
    const before = JSON.stringify(messages);
    const persistMessage = vi.fn();

    await persistCancelledToolCallClosures({
      messages,
      assistantMessage,
      toolCalls: [toolCalls[0]],
      persistMessage,
    });

    expect(persistMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).toBe(before);
  });
});
