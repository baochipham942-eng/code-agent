import { beforeEach, describe, expect, it } from 'vitest';
import { useStreamingMessageAccumulatorStore } from '../../../src/renderer/stores/streamingMessageAccumulatorStore';
import {
  getStreamingPerformanceSnapshot,
  resetStreamingPerformanceMetrics,
} from '../../../src/renderer/utils/streamingPerformanceMetrics';

describe('streamingMessageAccumulatorStore metrics', () => {
  beforeEach(() => {
    useStreamingMessageAccumulatorStore.setState({ entries: {} });
    resetStreamingPerformanceMetrics();
  });

  it('tracks active accumulator entry and char gauges', () => {
    useStreamingMessageAccumulatorStore.getState().appendDelta('assistant-1', {
      content: 'hello',
      reasoning: 'r',
    });

    expect(getStreamingPerformanceSnapshot()).toMatchObject({
      counters: {
        'stream.accumulator.append': 1,
        'stream.accumulator.append_chars': 6,
      },
      gauges: {
        'stream.accumulator.active_entries': 1,
        'stream.accumulator.active_chars': 6,
      },
    });

    useStreamingMessageAccumulatorStore.getState().consumeDelta('assistant-1');

    expect(getStreamingPerformanceSnapshot().gauges).toMatchObject({
      'stream.accumulator.active_entries': 0,
      'stream.accumulator.active_chars': 0,
    });
  });
});
