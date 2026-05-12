import { beforeEach, describe, expect, it } from 'vitest';
import {
  getStreamingPerformanceSnapshot,
  installStreamingPerformanceDebugApi,
  recordStreamingPerformanceCounter,
  resetStreamingPerformanceMetrics,
  setStreamingPerformanceGauge,
} from '../../../src/renderer/utils/streamingPerformanceMetrics';

describe('streamingPerformanceMetrics', () => {
  beforeEach(() => {
    resetStreamingPerformanceMetrics();
  });

  it('records counters and gauges in an in-memory snapshot', () => {
    recordStreamingPerformanceCounter('stream.accumulator.append');
    recordStreamingPerformanceCounter('stream.accumulator.append_chars', 12);
    setStreamingPerformanceGauge('stream.accumulator.active_entries', 1);

    expect(getStreamingPerformanceSnapshot()).toMatchObject({
      counters: {
        'stream.accumulator.append': 1,
        'stream.accumulator.append_chars': 12,
      },
      gauges: {
        'stream.accumulator.active_entries': 1,
      },
    });
  });

  it('resets metrics without removing the debug api', () => {
    const api = installStreamingPerformanceDebugApi();
    api.record('stream.markdown.render', 3);

    expect(api.snapshot().counters['stream.markdown.render']).toBe(3);
    expect(api.reset().counters).toEqual({});
    expect(api.snapshot().counters).toEqual({});
  });
});
