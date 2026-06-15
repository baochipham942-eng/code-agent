import { beforeEach, describe, expect, it } from 'vitest';
import {
  getStreamingPerformanceSnapshot,
  installStreamingPerformanceDebugApi,
  measureStreamingPerformanceTiming,
  recordStreamingPerformanceCounter,
  recordStreamingPerformanceTiming,
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
      timings: {},
    });
  });

  it('records timing summaries and keeps recent samples bounded', () => {
    recordStreamingPerformanceTiming('stream.diff.lines_ms', 2);
    recordStreamingPerformanceTiming('stream.diff.lines_ms', 4);
    const result = measureStreamingPerformanceTiming('stream.projection.base_ms', () => 42);

    const snapshot = getStreamingPerformanceSnapshot();
    expect(result).toBe(42);
    expect(snapshot.timings['stream.diff.lines_ms']).toMatchObject({
      count: 2,
      totalMs: 6,
      meanMs: 3,
      minMs: 2,
      maxMs: 4,
      lastMs: 4,
    });
    expect(snapshot.timings['stream.diff.lines_ms'].recentMs).toEqual([2, 4]);
    expect(snapshot.timings['stream.projection.base_ms'].count).toBe(1);
  });

  it('resets metrics without removing the debug api', () => {
    const api = installStreamingPerformanceDebugApi();
    api.record('stream.markdown.render', 3);
    api.time('stream.code.preview_ms', 5);

    expect(api.snapshot().counters['stream.markdown.render']).toBe(3);
    expect(api.snapshot().timings['stream.code.preview_ms'].lastMs).toBe(5);
    expect(api.reset().counters).toEqual({});
    expect(api.snapshot().counters).toEqual({});
    expect(api.snapshot().timings).toEqual({});
  });
});
