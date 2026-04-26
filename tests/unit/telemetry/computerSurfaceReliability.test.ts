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
});
