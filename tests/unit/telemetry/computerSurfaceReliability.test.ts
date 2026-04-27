import { afterEach, describe, expect, it } from 'vitest';
import type { TelemetryPushEvent, TelemetryToolCall } from '../../../src/shared/contract/telemetry';
import { TelemetryCollector } from '../../../src/main/telemetry/telemetryCollector';

describe('TelemetryCollector computer surface reliability fields', () => {
  let collector: TelemetryCollector | null = null;

  afterEach(async () => {
    await collector?.dispose();
    collector = null;
  });

  it('extracts Computer Use failure taxonomy and AX quality from tool metadata', () => {
    collector = new TelemetryCollector();
    const events: TelemetryPushEvent[] = [];
    collector.addEventListener((event) => events.push(event));
    collector.startSession('session-computer-surface', {
      title: 'Computer Surface dogfood',
      modelProvider: 'test',
      modelName: 'test-model',
      workingDirectory: '/tmp/workbench',
    });
    collector.startTurn('session-computer-surface', 'turn-1', 1, 'Click Finder Back');

    collector.recordToolCallStart('turn-1', 'tool-1', 'computer_use', {
      action: 'click',
      targetApp: 'Finder',
      axPath: '1.2',
    }, 0, false);
    collector.recordToolCallEnd(
      'turn-1',
      'tool-1',
      false,
      'Background action failed: Target element not found',
      42,
      undefined,
      {
        failureKind: 'locator_missing',
        computerSurfaceMode: 'background_ax',
        targetApp: 'Finder',
        workbenchTrace: {
          action: 'click',
        },
        axQuality: {
          score: 0.3,
          grade: 'poor',
          elementCount: 0,
          reasons: ['no interactive AX elements returned'],
        },
      },
    );

    const toolEvent = events.find((event) => event.type === 'tool_call');
    const toolCall = toolEvent?.data as TelemetryToolCall | undefined;
    expect(toolCall).toMatchObject({
      name: 'computer_use',
      success: false,
      computerSurfaceFailureKind: 'locator_missing',
      computerSurfaceMode: 'background_ax',
      computerSurfaceTargetApp: 'Finder',
      computerSurfaceAction: 'click',
      computerSurfaceAxQualityScore: 0.3,
      computerSurfaceAxQualityGrade: 'poor',
    });
  });

  it('redacts Computer Use arguments and result summaries before telemetry events', () => {
    const secret = 'telemetry-secret@example.com';
    collector = new TelemetryCollector();
    const events: TelemetryPushEvent[] = [];
    collector.addEventListener((event) => events.push(event));
    collector.startSession('session-computer-redaction', {
      title: 'Computer Surface redaction',
      modelProvider: 'test',
      modelName: 'test-model',
      workingDirectory: '/tmp/workbench',
    });
    collector.startTurn('session-computer-redaction', 'turn-1', 1, 'Type into app');

    collector.recordToolCallStart('turn-1', 'tool-1', 'computer_use', {
      action: 'smart_type',
      selector: '#email',
      text: secret,
    }, 0, false);
    collector.recordToolCallEnd(
      'turn-1',
      'tool-1',
      false,
      `No element found after ${secret}`,
      42,
      undefined,
      {
        computerSurfaceMode: 'foreground_fallback',
      },
    );

    const toolEvent = events.find((event) => event.type === 'tool_call');
    const json = JSON.stringify(toolEvent?.data);
    expect(json).toContain('[redacted 28 chars]');
    expect(json).not.toContain(secret);
  });

  it('records detached subagent turns without requiring the active turn buffer', () => {
    collector = new TelemetryCollector();
    const events: TelemetryPushEvent[] = [];
    collector.addEventListener((event) => events.push(event));
    collector.startSession('session-subagent-telemetry', {
      title: 'Subagent telemetry',
      modelProvider: 'test',
      modelName: 'test-model',
      workingDirectory: '/tmp/workbench',
    });

    const recorded = collector.recordDetachedTurn({
      sessionId: 'session-subagent-telemetry',
      turnId: 'turn-subagent-1',
      turnNumber: 1,
      userPrompt: 'Inspect file',
      assistantResponse: 'Calling read_file',
      agentId: 'agent-reviewer',
      startTime: 100,
      endTime: 150,
      modelCalls: [{
        id: 'mc-1',
        timestamp: 110,
        provider: 'test',
        model: 'test-model',
        inputTokens: 5,
        outputTokens: 7,
        latencyMs: 12,
        responseType: 'tool_use',
        toolCallCount: 1,
        truncated: false,
      }],
      toolCalls: [{
        toolCallId: 'tool-1',
        name: 'read_file',
        arguments: { file_path: 'src/main.ts' },
        resultSummary: 'ok',
        success: true,
        durationMs: 8,
        timestamp: 120,
        index: 0,
      }],
    });

    expect(recorded).toBe(true);
    expect(collector.getSessionData('session-subagent-telemetry')).toMatchObject({
      turnCount: 1,
      totalInputTokens: 5,
      totalOutputTokens: 7,
      totalToolCalls: 1,
      toolSuccessRate: 1,
    });
    expect(events.some((event) => event.type === 'turn_end' && (event.data as { detached?: boolean }).detached)).toBe(true);
  });
});
