import { describe, expect, it, vi } from 'vitest';
import { composeTelemetryAdapters } from '../../../src/host/agent/metricsCollector';
import type { TelemetryAdapter } from '../../../src/shared/contract/telemetry';

describe('telemetry exporter failure isolation', () => {
  it('continues dispatching telemetry callbacks when one exporter throws', () => {
    const throwing = Object.fromEntries([
      'onTurnStart', 'onModelCall', 'onToolCallStart', 'onToolCallEnd', 'onTurnEnd',
    ].map((name) => [name, vi.fn(() => { throw new Error('exporter unavailable'); })])) as unknown as TelemetryAdapter;
    const healthy = {
      onTurnStart: vi.fn(),
      onModelCall: vi.fn(),
      onToolCallStart: vi.fn(),
      onToolCallEnd: vi.fn(),
      onTurnEnd: vi.fn(),
    } satisfies TelemetryAdapter;
    const adapter = composeTelemetryAdapters(throwing, healthy);

    expect(() => adapter.onTurnStart('turn-1', 1, 'secret prompt')).not.toThrow();
    expect(() => adapter.onModelCall('turn-1', {
      id: 'model-1', timestamp: 1, provider: 'test', model: 'test-model', inputTokens: 1,
      outputTokens: 1, latencyMs: 1, responseType: 'text', toolCallCount: 0, truncated: false,
    })).not.toThrow();
    expect(() => adapter.onToolCallStart('turn-1', 'tool-1', 'Read', {}, 0, false)).not.toThrow();
    expect(() => adapter.onToolCallEnd('turn-1', 'tool-1', true, undefined, 1, 'secret output')).not.toThrow();
    expect(() => adapter.onTurnEnd('turn-1', 'secret output')).not.toThrow();

    expect(healthy.onTurnStart).toHaveBeenCalledOnce();
    expect(healthy.onModelCall).toHaveBeenCalledOnce();
    expect(healthy.onToolCallStart).toHaveBeenCalledOnce();
    expect(healthy.onToolCallEnd).toHaveBeenCalledOnce();
    expect(healthy.onTurnEnd).toHaveBeenCalledOnce();
  });
});
