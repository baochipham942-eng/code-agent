import { beforeEach, describe, expect, it } from 'vitest';
import { createTelemetryAdapter } from '../../../../src/host/telemetry/telemetryAdapter';
import { TelemetryService } from '../../../../src/host/telemetry/telemetryService';
import { createRunTraceContext, withRunTraceContext } from '../../../../src/host/telemetry/runTraceContext';

describe('TelemetryAdapter run hierarchy', () => {
  const service = TelemetryService.getInstance();

  beforeEach(() => service.reset());

  it('builds turn/model/tool children with safe attributes and terminal status', () => {
    const run = createRunTraceContext({
      runId: 'run-adapter', sessionId: 'session-adapter', attempt: 1, ownerEpoch: 1,
      engine: 'native', workspace: '/tmp/adapter', processInstanceId: 'process-adapter',
    });
    service.startRunAttemptSpan(run);
    const adapter = createTelemetryAdapter(service);

    withRunTraceContext(run, () => {
      adapter.onTurnStart('turn-1', 1, 'secret prompt');
      adapter.onModelCall('turn-1', {
        id: 'model-1', timestamp: 1, provider: 'openai', model: 'gpt-test', inputTokens: 10,
        outputTokens: 3, latencyMs: 25, responseType: 'tool_use', toolCallCount: 1,
        truncated: false, requestProtocol: 'responses', retryCount: 2, resultStatus: 'success',
        prompt: 'secret prompt', completion: 'secret output',
      });
      adapter.onToolCallStart('turn-1', 'tool-1', 'Bash', {
        authorization: 'Bearer secret', command: 'print secret',
      }, 0, false);
      adapter.onToolCallEnd('turn-1', 'tool-1', false, 'timed out', 100, 'secret output');
      adapter.onTurnEnd('turn-1', 'secret output');
    });

    const spans = service.getRecentSpans(10);
    const turn = spans.find((span) => span.kind === 'turn')!;
    const model = spans.find((span) => span.kind === 'model')!;
    const tool = spans.find((span) => span.kind === 'tool')!;
    expect(model.parentSpanId).toBe(turn.spanId);
    expect(tool.parentSpanId).toBe(turn.spanId);
    expect(model.traceId).toBe(run.traceId);
    expect(tool.attributes).toMatchObject({ 'terminal.status': 'timeout' });
    expect(model.attributes).toMatchObject({
      'model.request_protocol': 'responses',
      'model.retry_count': 2,
      'model.result_status': 'success',
    });
    expect(JSON.stringify(spans)).not.toMatch(/Bearer secret|secret prompt|secret output|print secret/);
  });
});
