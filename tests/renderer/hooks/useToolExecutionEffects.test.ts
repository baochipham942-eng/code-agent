import { describe, expect, it } from 'vitest';
import type {
  AgentPointerEvent,
  Message,
  ToolCall,
  ToolProgressData,
  ToolTimeoutData,
} from '../../../src/shared/contract';
import type { CapabilityGapNotice } from '../../../src/renderer/stores/capabilityGapStore';
import {
  applyToolExecutionEvent,
  type ToolExecutionEventDeps,
} from '../../../src/renderer/hooks/agent/effects/useToolExecutionEffects';

type QueuedUpdate = Parameters<ToolExecutionEventDeps['queueUpdate']>[0];

interface ToolExecutionState {
  activeToolProgress: ToolProgressData | null;
  bridgeToolCalls: unknown[];
  capabilityGapNotices: Record<string, CapabilityGapNotice>;
  clearAgentPointersCount: number;
  currentSessionId: string | null;
  currentTurnMessageId: string | null;
  debugMessages: string[];
  lastEventAt: number;
  messages: Message[];
  pointerEvents: AgentPointerEvent[];
  queuedUpdates: QueuedUpdate[];
  toolTimeoutWarning: ToolTimeoutData | null;
  warnings: string[];
}

function assistantMessage(
  id: string,
  toolCalls?: ToolCall[],
): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 100,
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

function pointerEvent(id: string): AgentPointerEvent {
  return {
    id,
    surface: 'browser',
    tone: 'browser',
    phase: 'click',
    coordSpace: 'browserViewport',
    point: { x: 25, y: 40, unit: 'px' },
  };
}

function createHarness(overrides: Partial<ToolExecutionState> = {}) {
  const state: ToolExecutionState = {
    activeToolProgress: null,
    bridgeToolCalls: [],
    capabilityGapNotices: {},
    clearAgentPointersCount: 0,
    currentSessionId: 'session-current',
    currentTurnMessageId: 'turn-current',
    debugMessages: [],
    lastEventAt: 0,
    messages: [],
    pointerEvents: [],
    queuedUpdates: [],
    toolTimeoutWarning: null,
    warnings: [],
    ...overrides,
  };

  const deps: ToolExecutionEventDeps = {
    clearAgentPointers: () => {
      state.clearAgentPointersCount += 1;
      state.pointerEvents = [];
    },
    debug: (message) => {
      state.debugMessages.push(message);
    },
    dispatchBridgeToolCall: (data) => {
      state.bridgeToolCalls.push(data);
    },
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentTurnMessageId: () => state.currentTurnMessageId,
    getMessages: () => state.messages,
    isDev: true,
    now: () => 500,
    queueUpdate: (update) => {
      state.queuedUpdates.push(update);
    },
    recordAgentPointer: (event) => {
      state.pointerEvents.push(event);
    },
    setActiveToolProgress: (next) => {
      state.activeToolProgress = typeof next === 'function'
        ? next(state.activeToolProgress)
        : next;
    },
    setCapabilityGapNotice: (sessionId, notice) => {
      state.capabilityGapNotices[sessionId] = notice;
    },
    setLastEventAt: (timestamp) => {
      state.lastEventAt = timestamp;
    },
    setToolTimeoutWarning: (next) => {
      state.toolTimeoutWarning = typeof next === 'function'
        ? next(state.toolTimeoutWarning)
        : next;
    },
    updateMessage: (messageId, updates) => {
      state.messages = state.messages.map((message) =>
        message.id === messageId ? { ...message, ...updates } : message
      );
    },
    warn: (message) => {
      state.warnings.push(message);
    },
  };

  return { deps, state };
}

describe('applyToolExecutionEvent', () => {
  it('adds streamed tool calls to the turn and queues their argument deltas', () => {
    const existingCall: ToolCall = {
      id: 'existing-tool',
      name: 'Read',
      arguments: { file_path: 'README.md' },
    };
    const { deps, state } = createHarness({
      messages: [assistantMessage('turn-current', [existingCall])],
    });

    applyToolExecutionEvent(
      {
        type: 'stream_tool_call_start',
        data: { index: 1, name: 'browser_action', turnId: 'turn-current' },
        sessionId: 'session-current',
      },
      deps,
    );
    applyToolExecutionEvent(
      {
        type: 'stream_tool_call_delta',
        data: {
          index: 1,
          name: 'browser_action',
          argumentsDelta: '{"action":"click"}',
          turnId: 'turn-current',
        },
        sessionId: 'session-current',
      },
      deps,
    );

    expect(state.messages[0].toolCalls).toEqual([
      existingCall,
      {
        id: 'pending_1',
        name: 'browser_action',
        arguments: {},
        _streaming: true,
        _argumentsRaw: '',
      },
    ]);
    expect(state.queuedUpdates).toEqual([
      {
        type: 'tool_call_delta',
        messageId: 'turn-current',
        index: 1,
        name: 'browser_action',
        argumentsDelta: '{"action":"click"}',
      },
    ]);
    expect(state.lastEventAt).toBe(500);
    expect(state.debugMessages).toEqual([
      'Received event',
      'stream_tool_call_start',
    ]);
  });

  it('reconciles tool_call_start by index while preserving streamed arguments', () => {
    const firstCall: ToolCall = {
      id: 'pending_0',
      name: 'Read',
      arguments: {},
      _streaming: true,
    };
    const streamedCall: ToolCall = {
      id: 'pending_1',
      name: 'browser_action',
      arguments: { action: 'click', selector: '#saved-from-stream' },
      _streaming: true,
    };
    const { deps, state } = createHarness({
      messages: [assistantMessage('turn-current', [firstCall, streamedCall])],
    });

    applyToolExecutionEvent(
      {
        type: 'tool_call_start',
        data: {
          id: 'tool-real',
          name: 'browser_action',
          arguments: { action: 'click', selector: '#from-start' },
          _index: 1,
          turnId: 'turn-current',
        },
        sessionId: 'session-current',
      },
      deps,
    );

    expect(state.messages[0].toolCalls).toEqual([
      firstCall,
      {
        ...streamedCall,
        id: 'tool-real',
        arguments: { action: 'click', selector: '#saved-from-stream' },
        _streaming: false,
      },
    ]);
    expect(state.pointerEvents).toHaveLength(1);
    expect(state.pointerEvents[0]).toMatchObject({
      id: 'agent-pointer-tool-real',
      surface: 'browser',
      phase: 'click',
    });
  });

  it('falls back to the first same-name streaming call or appends a first concrete call', () => {
    const fallbackHarness = createHarness({
      messages: [
        assistantMessage('turn-current', [
          {
            id: 'pending-browser',
            name: 'browser_action',
            arguments: { action: 'click' },
            _streaming: true,
          },
        ]),
      ],
    });

    applyToolExecutionEvent(
      {
        type: 'tool_call_start',
        data: {
          id: 'fallback-real',
          name: 'browser_action',
          arguments: { action: 'click' },
          turnId: 'turn-current',
        },
        sessionId: 'session-current',
      },
      fallbackHarness.deps,
    );

    expect(fallbackHarness.state.messages[0].toolCalls).toEqual([
      {
        id: 'fallback-real',
        name: 'browser_action',
        arguments: { action: 'click' },
        _streaming: false,
      },
    ]);

    const firstCallHarness = createHarness({
      messages: [assistantMessage('turn-current')],
    });
    applyToolExecutionEvent(
      {
        type: 'tool_call_start',
        data: {
          id: 'first-real',
          name: 'Read',
          arguments: { file_path: 'one.txt' },
          turnId: 'turn-current',
        },
        sessionId: 'session-current',
      },
      firstCallHarness.deps,
    );

    expect(firstCallHarness.state.messages[0].toolCalls).toEqual([
      {
        id: 'first-real',
        name: 'Read',
        arguments: { file_path: 'one.txt' },
        turnId: 'turn-current',
      },
    ]);
  });

  it('attaches a matched result, emits its capability gap and pointer, and clears matching status', () => {
    const runtimePointer = pointerEvent('pointer-from-result');
    const runningProgress: ToolProgressData = {
      toolCallId: 'recommend-1',
      toolName: 'recommend_capability',
      elapsedMs: 120,
    };
    const timeout: ToolTimeoutData = {
      toolCallId: 'recommend-1',
      toolName: 'recommend_capability',
      elapsedMs: 120,
      threshold: 100,
    };
    const { deps, state } = createHarness({
      activeToolProgress: runningProgress,
      messages: [
        assistantMessage('turn-other', [{
          id: 'other-tool',
          name: 'Read',
          arguments: {},
        }]),
        assistantMessage('turn-current', [{
          id: 'recommend-1',
          name: 'recommend_capability',
          arguments: { requiredCapability: 'browser-automation' },
        }]),
      ],
      toolTimeoutWarning: timeout,
    });
    const result = {
      toolCallId: 'recommend-1',
      success: true,
      duration: 45,
      metadata: {
        requiredCapability: 'browser-automation',
        gaps: [{
          type: 'plugin' as const,
          missing: 'browser-automation',
          candidates: [],
        }],
        agentPointerEvent: runtimePointer,
      },
    };

    applyToolExecutionEvent(
      { type: 'tool_call_end', data: result, sessionId: 'session-current' },
      deps,
    );

    expect(state.messages[0].toolCalls?.[0].result).toBeUndefined();
    expect(state.messages[1].toolCalls?.[0].result).toEqual(result);
    expect(state.capabilityGapNotices).toEqual({
      'session-current': {
        requiredCapability: 'browser-automation',
        gaps: [{
          type: 'plugin',
          missing: 'browser-automation',
          candidates: [],
        }],
        toolCallId: 'recommend-1',
      },
    });
    expect(state.pointerEvents).toEqual([runtimePointer]);
    expect(state.activeToolProgress).toBeNull();
    expect(state.toolTimeoutWarning).toBeNull();
    expect(state.warnings).toEqual([]);
  });

  it('records a metadata pointer and development warning for an unmatched result', () => {
    const runtimePointer = pointerEvent('unmatched-pointer');
    const unrelatedProgress: ToolProgressData = {
      toolCallId: 'still-running',
      toolName: 'Bash',
      elapsedMs: 100,
    };
    const unrelatedTimeout: ToolTimeoutData = {
      toolCallId: 'still-running',
      toolName: 'Bash',
      elapsedMs: 100,
      threshold: 80,
    };
    const { deps, state } = createHarness({
      activeToolProgress: unrelatedProgress,
      messages: [assistantMessage('turn-current', [])],
      toolTimeoutWarning: unrelatedTimeout,
    });

    applyToolExecutionEvent(
      {
        type: 'tool_call_end',
        data: {
          toolCallId: 'missing-tool',
          success: false,
          metadata: { agentPointerEvent: runtimePointer },
        },
        sessionId: 'session-current',
      },
      deps,
    );

    expect(state.messages[0].toolCalls).toEqual([]);
    expect(state.pointerEvents).toEqual([runtimePointer]);
    expect(state.activeToolProgress).toEqual(unrelatedProgress);
    expect(state.toolTimeoutWarning).toEqual(unrelatedTimeout);
    expect(state.warnings).toEqual(['No matching toolCall found']);
    expect(state.debugMessages).toContain('Available toolCalls');
  });

  it('applies progress, live output, timeout, and local bridge events for the current session', () => {
    const { deps, state } = createHarness({
      messages: [
        assistantMessage('turn-current', [{
          id: 'bash-1',
          name: 'Bash',
          arguments: { command: 'npm test' },
          liveOutput: { stdout: 'first\n' },
        }]),
      ],
    });
    const progress: ToolProgressData = {
      toolCallId: 'bash-1',
      toolName: 'Bash',
      elapsedMs: 50,
      detail: 'running',
    };
    const timeout: ToolTimeoutData = {
      toolCallId: 'bash-1',
      toolName: 'Bash',
      elapsedMs: 100,
      threshold: 90,
    };
    const localCall = {
      toolCallId: 'local-1',
      tool: 'file_write',
      params: { path: 'output.txt' },
      permissionLevel: 'L2' as const,
      runId: 'run-1',
      sessionId: 'session-current',
      workspace: '/workspace',
      cwd: '/workspace',
    };

    applyToolExecutionEvent(
      { type: 'tool_progress', data: progress, sessionId: 'session-current' },
      deps,
    );
    applyToolExecutionEvent(
      {
        type: 'tool_output_delta',
        data: {
          toolCallId: 'bash-1',
          toolName: 'Bash',
          stream: 'stdout',
          content: 'second\n',
        },
        sessionId: 'session-current',
      },
      deps,
    );
    applyToolExecutionEvent(
      { type: 'tool_timeout', data: timeout, sessionId: 'session-current' },
      deps,
    );
    applyToolExecutionEvent(
      { type: 'tool_call_local', data: localCall, sessionId: 'session-current' },
      deps,
    );

    expect(state.activeToolProgress).toEqual(progress);
    expect(state.messages[0].toolCalls?.[0].liveOutput).toEqual({
      stdout: 'first\nsecond\n',
      truncated: false,
      updatedAt: 500,
    });
    expect(state.toolTimeoutWarning).toEqual(timeout);
    expect(state.bridgeToolCalls).toEqual([localCall]);
    expect(state.lastEventAt).toBe(500);
  });

  it('records foreign-session activity without applying its tool state', () => {
    const originalCall: ToolCall = {
      id: 'bash-current',
      name: 'Bash',
      arguments: {},
    };
    const { deps, state } = createHarness({
      messages: [assistantMessage('turn-current', [originalCall])],
    });

    applyToolExecutionEvent(
      {
        type: 'stream_tool_call_start',
        data: { index: 1, name: 'Read', turnId: 'turn-current' },
        sessionId: 'session-foreign',
      },
      deps,
    );
    applyToolExecutionEvent(
      {
        type: 'tool_output_delta',
        data: {
          toolCallId: 'bash-current',
          toolName: 'Bash',
          stream: 'stdout',
          content: 'foreign output',
        },
        sessionId: 'session-foreign',
      },
      deps,
    );
    applyToolExecutionEvent(
      {
        type: 'tool_progress',
        data: { toolCallId: 'foreign', toolName: 'Read', elapsedMs: 50 },
        sessionId: 'session-foreign',
      },
      deps,
    );
    applyToolExecutionEvent(
      {
        type: 'tool_timeout',
        data: {
          toolCallId: 'foreign',
          toolName: 'Read',
          elapsedMs: 100,
          threshold: 90,
        },
        sessionId: 'session-foreign',
      },
      deps,
    );

    expect(state.messages[0].toolCalls).toEqual([originalCall]);
    expect(state.activeToolProgress).toBeNull();
    expect(state.toolTimeoutWarning).toBeNull();
    expect(state.queuedUpdates).toEqual([]);
    expect(state.lastEventAt).toBe(500);
  });

  it('clears pointers only for unscoped or current-session terminal events', () => {
    const initialPointer = pointerEvent('active-pointer');
    const { deps, state } = createHarness({ pointerEvents: [initialPointer] });

    applyToolExecutionEvent(
      { type: 'agent_complete', data: null, sessionId: 'session-foreign' },
      deps,
    );
    expect(state.pointerEvents).toEqual([initialPointer]);
    expect(state.clearAgentPointersCount).toBe(0);

    applyToolExecutionEvent(
      { type: 'agent_cancelled', data: null, sessionId: 'session-current' },
      deps,
    );
    expect(state.pointerEvents).toEqual([]);
    expect(state.clearAgentPointersCount).toBe(1);

    state.pointerEvents = [initialPointer];
    applyToolExecutionEvent({ type: 'stream_end', data: null }, deps);
    expect(state.pointerEvents).toEqual([]);
    expect(state.clearAgentPointersCount).toBe(2);
    expect(state.lastEventAt).toBe(0);
  });
});
