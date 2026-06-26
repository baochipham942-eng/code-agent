import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryModelCall } from '../../../src/shared/contract/telemetry';
import { INCOMPLETE_TOOL_RESULT_MARKER } from '../../../src/shared/contract/agentTrajectory';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  storage: {
    insertSession: vi.fn(),
    updateSession: vi.fn(),
    insertTurn: vi.fn(),
    batchInsert: vi.fn(),
    pruneRawPayloads: vi.fn(),
    insertDiagnosticBundle: vi.fn(),
    getToolUsageStats: vi.fn(() => []),
    getToolCallsBySession: vi.fn(() => []),
  },
  trackNode: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

vi.mock('../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

vi.mock('../../../src/host/observability/posthogNode', () => ({
  trackNode: mocks.trackNode,
}));

vi.mock('../../../src/host/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: () => ({ ensureTable: vi.fn() }),
}));

vi.mock('../../../src/host/telemetry/diagnosticVersions', () => ({
  getDiagnosticVersions: () => ({
    agentVersion: 'test-agent',
    promptVersion: 'test-prompt',
    toolSchemaVersion: 'test-tools',
  }),
}));

vi.mock('../../../src/host/telemetry/telemetryStorage', () => ({
  getTelemetryStorage: () => mocks.storage,
}));

const { TelemetryCollector } = await import('../../../src/host/telemetry/telemetryCollector');

function modelCall(overrides: Partial<TelemetryModelCall> = {}): TelemetryModelCall {
  return {
    id: 'mc-turn-no-active-1',
    timestamp: 100,
    provider: 'test',
    model: 'test-model',
    inputTokens: 11,
    outputTokens: 13,
    latencyMs: 42,
    responseType: 'text',
    toolCallCount: 0,
    truncated: false,
    ...overrides,
  };
}

describe('TelemetryCollector adapter no-active-turn fallback', () => {
  let collector: InstanceType<typeof TelemetryCollector>;

  beforeEach(() => {
    vi.clearAllMocks();
    collector = new TelemetryCollector();
  });

  afterEach(async () => {
    await collector.dispose();
  });

  it('persists model call and turn data without logging turnId mismatch when no active turn exists', () => {
    collector.startSession('session-no-active', {
      title: 'No active turn',
      modelProvider: 'test',
      modelName: 'test-model',
      workingDirectory: '/tmp/workbench',
    });

    const adapter = collector.createAdapter('session-no-active', 'main');
    adapter.onModelCall('turn-no-active', modelCall());
    adapter.onTurnEnd('turn-no-active', 'final response', 'thinking text', 'system-hash');

    expect(mocks.storage.insertTurn).toHaveBeenCalledWith(expect.objectContaining({
      id: 'turn-no-active',
      sessionId: 'session-no-active',
      agentId: 'main',
      agentMode: 'normal',
      turnType: 'user',
      assistantResponse: 'final response',
      thinkingContent: 'thinking text',
      systemPromptHash: 'system-hash',
      totalInputTokens: 11,
      totalOutputTokens: 13,
    }));
    expect(mocks.storage.batchInsert).toHaveBeenCalledWith(expect.objectContaining({
      modelCalls: [
        expect.objectContaining({
          id: 'mc-turn-no-active-1',
          turnId: 'turn-no-active',
          sessionId: 'session-no-active',
          inputTokens: 11,
          outputTokens: 13,
        }),
      ],
    }));
    expect(collector.getSessionData('session-no-active')).toMatchObject({
      turnCount: 1,
      totalInputTokens: 11,
      totalOutputTokens: 13,
      totalTokens: 24,
    });
    expect(mocks.logger.warn.mock.calls.some(([message]) => String(message).includes('turnId mismatch'))).toBe(false);
  });

  it('closes active pending tool calls as failed results when a turn ends', () => {
    collector.startSession('session-pending-tool', {
      title: 'Pending tool',
      modelProvider: 'test',
      modelName: 'test-model',
      workingDirectory: '/tmp/workbench',
    });
    collector.startTurn('session-pending-tool', 'turn-pending', 1, 'Read something');
    collector.recordToolCallStart('turn-pending', 'tool-pending-1', 'Read', {
      file_path: 'package.json',
    }, 0, false);

    collector.endTurn('session-pending-tool', 'turn-pending', 'Could not finish.');

    expect(mocks.storage.batchInsert).toHaveBeenCalledWith(expect.objectContaining({
      toolCalls: [
        expect.objectContaining({
          turnId: 'turn-pending',
          sessionId: 'session-pending-tool',
          toolCallId: 'tool-pending-1',
          name: 'Read',
          success: false,
          resultSummary: expect.stringContaining(INCOMPLETE_TOOL_RESULT_MARKER),
          error: expect.stringContaining(INCOMPLETE_TOOL_RESULT_MARKER),
        }),
      ],
    }));
    expect(collector.getSessionData('session-pending-tool')).toMatchObject({
      totalToolCalls: 1,
      totalErrors: 1,
      toolSuccessRate: 0,
    });
  });

  it('closes detached pending tool calls as failed results when a detached turn ends', () => {
    collector.startSession('session-detached-pending-tool', {
      title: 'Detached pending tool',
      modelProvider: 'test',
      modelName: 'test-model',
      workingDirectory: '/tmp/workbench',
    });

    const adapter = collector.createAdapter('session-detached-pending-tool', 'agent-reviewer');
    adapter.onToolCallStart('turn-detached-pending', 'tool-pending-2', 'Read', {
      file_path: 'package.json',
    }, 0, false);
    adapter.onTurnEnd('turn-detached-pending', 'Detached turn finished.');

    expect(mocks.storage.batchInsert).toHaveBeenCalledWith(expect.objectContaining({
      toolCalls: [
        expect.objectContaining({
          turnId: 'turn-detached-pending',
          sessionId: 'session-detached-pending-tool',
          toolCallId: 'tool-pending-2',
          name: 'Read',
          success: false,
          resultSummary: expect.stringContaining(INCOMPLETE_TOOL_RESULT_MARKER),
          error: expect.stringContaining(INCOMPLETE_TOOL_RESULT_MARKER),
        }),
      ],
    }));
    expect(collector.getSessionData('session-detached-pending-tool')).toMatchObject({
      totalToolCalls: 1,
      totalErrors: 1,
      toolSuccessRate: 0,
    });
  });
});
