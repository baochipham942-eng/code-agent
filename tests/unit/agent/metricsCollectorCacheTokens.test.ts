import { describe, expect, it } from 'vitest';
import { MetricsCollector } from '../../../src/host/agent/metricsCollector';
import type { TelemetryModelCall } from '../../../src/shared/contract/telemetry';

const baseCall = (over: Partial<TelemetryModelCall> = {}): TelemetryModelCall => ({
  id: 'model-1',
  timestamp: 1,
  provider: 'test',
  model: 'test-model',
  inputTokens: 10,
  outputTokens: 5,
  latencyMs: 1,
  responseType: 'text',
  toolCallCount: 0,
  truncated: false,
  ...over,
});

describe('MetricsCollector prompt-cache token 观测（CLI --metrics 出口）', () => {
  it('累计 provider 报告的 cacheRead / cacheCreation，并写进 --metrics 的 JSON', () => {
    const collector = new MetricsCollector('s1');
    collector.onModelCall('t1', baseCall({ cacheReadTokens: 683, cacheCreationTokens: 12996 }));
    collector.onModelCall('t1', baseCall({ id: 'model-2', cacheReadTokens: 12996, cacheCreationTokens: 0 }));

    expect(collector.getMetrics().cacheReadTokens).toBe(683 + 12996);
    expect(collector.getMetrics().cacheCreationTokens).toBe(12996);
    // --metrics 落盘走 toJSON()，字段必须真的出现在文件里，而不是只活在内存对象上
    const written = JSON.parse(collector.toJSON()) as Record<string, unknown>;
    expect(written.cacheReadTokens).toBe(13679);
    expect(written.cacheCreationTokens).toBe(12996);
  });

  it('provider 从没报过字段时，出口里不出现该键——不许伪造成 0', () => {
    const collector = new MetricsCollector('s2');
    collector.onModelCall('t1', baseCall());

    const written = JSON.parse(collector.toJSON()) as Record<string, unknown>;
    expect('cacheReadTokens' in written).toBe(false);
    expect('cacheCreationTokens' in written).toBe(false);
  });

  it('provider 明确报 0（真没命中）与「没报」可区分：键存在且为 0', () => {
    const collector = new MetricsCollector('s3');
    collector.onModelCall('t1', baseCall({ cacheReadTokens: 0 }));

    const written = JSON.parse(collector.toJSON()) as Record<string, unknown>;
    expect('cacheReadTokens' in written).toBe(true);
    expect(written.cacheReadTokens).toBe(0);
    expect('cacheCreationTokens' in written).toBe(false);
  });
});
