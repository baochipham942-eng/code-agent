import { afterEach, describe, expect, it } from 'vitest';
import { redactCredentialText } from '../../../src/shared/security/secretPatterns';
import { secretPatternCanaries } from '../../shared/security/secretPatternCanaries';
import { scrubString } from '../../../src/shared/observability/scrubEvent';
import { redactSecrets } from '../../../src/host/security/secretRedaction';
import { prepareRawPayload } from '../../../src/host/telemetry/telemetryStorageParsers';
import { TelemetryService } from '../../../src/host/telemetry/telemetryService';
import { TelemetryCollector } from '../../../src/host/telemetry/telemetryCollector';
import type { TelemetryModelCall, TelemetryPushEvent, TelemetryToolCall } from '../../../src/shared/contract/telemetry';

describe('secret redaction outlet matrix', () => {
  const service = TelemetryService.getInstance();
  let collector: TelemetryCollector | null = null;

  afterEach(async () => {
    service.reset();
    await collector?.dispose();
    collector = null;
  });

  it('redacts every shared secret canary across text, logs, crash scrubber, raw telemetry, and span attributes', () => {
    for (const canary of secretPatternCanaries) {
      expect(redactCredentialText(canary.positive), canary.id).not.toContain(canary.rawSecret);
      expect(redactSecrets(canary.positive), canary.id).not.toContain(canary.rawSecret);
      expect(scrubString(canary.positive), canary.id).not.toContain(canary.rawSecret);
      expect(prepareRawPayload(canary.positive)?.content, canary.id).not.toContain(canary.rawSecret);

      const span = service.startSpan(`span-${canary.id}`, 'internal', {
        'safe.detail': canary.positive,
        'safe.count': 1,
      });
      expect(JSON.stringify(span.attributes), canary.id).not.toContain(canary.rawSecret);
      service.reset();
    }
  });

  it('redacts model and tool live-push payloads before listeners receive them', () => {
    for (const canary of secretPatternCanaries) {
      collector = new TelemetryCollector();
      const events: TelemetryPushEvent[] = [];
      collector.addEventListener((event) => events.push(event));
      collector.startSession(`session-${canary.id}`, {
        title: 'secret matrix',
        modelProvider: 'test',
        modelName: 'test-model',
        workingDirectory: '/tmp/workbench',
      });
      collector.startTurn(`session-${canary.id}`, `turn-${canary.id}`, 1, 'diagnose redaction');

      const call: TelemetryModelCall = {
        id: `model-${canary.id}`,
        timestamp: 100,
        provider: 'test',
        model: 'test-model',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        responseType: 'text',
        toolCallCount: 0,
        truncated: false,
        prompt: canary.positive,
        completion: canary.positive,
      };
      collector.recordModelCall(`turn-${canary.id}`, call);
      collector.recordToolCallStart(`turn-${canary.id}`, `tool-${canary.id}`, 'Read', {
        note: canary.positive,
      }, 0, false);
      collector.recordToolCallEnd(`turn-${canary.id}`, `tool-${canary.id}`, true, undefined, 1, canary.positive);

      const modelEvent = events.find((event) => event.type === 'model_call');
      const toolEvent = events.find((event) => event.type === 'tool_call');
      expect(JSON.stringify(modelEvent?.data), canary.id).not.toContain(canary.rawSecret);
      expect(JSON.stringify(toolEvent?.data as TelemetryToolCall | undefined), canary.id).not.toContain(canary.rawSecret);

      void collector.dispose();
      collector = null;
    }
  });
});
