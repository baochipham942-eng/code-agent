export type StreamingPerformanceCounter =
  | 'stream.accumulator.append'
  | 'stream.accumulator.append_chars'
  | 'stream.accumulator.flush'
  | 'stream.accumulator.flush_chars'
  | 'stream.accumulator.clear'
  | 'stream.ipc.batch_received'
  | 'stream.ipc.batch_events'
  | 'stream.ipc.duplicate_dropped'
  | 'stream.projection.base_commit'
  | 'stream.projection.overlay_commit'
  | 'stream.active_display_scroll'
  | 'stream.message_content.render'
  | 'stream.message_content.streaming_plain_render'
  | 'stream.message_content.streaming_markdown_render'
  | 'stream.markdown.render'
  | 'stream.markdown.throttle_flush';

export type StreamingPerformanceGauge =
  | 'stream.accumulator.active_entries'
  | 'stream.accumulator.active_chars';

export interface StreamingPerformanceSnapshot {
  startedAt: number;
  updatedAt: number;
  counters: Record<string, number>;
  gauges: Record<string, number>;
}

export interface StreamingPerformanceDebugApi {
  snapshot: () => StreamingPerformanceSnapshot;
  reset: () => StreamingPerformanceSnapshot;
  record: (name: StreamingPerformanceCounter, amount?: number) => StreamingPerformanceSnapshot;
}

const GLOBAL_KEY = '__CODE_AGENT_STREAMING_PERF__';

let metricsState: StreamingPerformanceSnapshot = createEmptySnapshot();

function createEmptySnapshot(): StreamingPerformanceSnapshot {
  const now = Date.now();
  return {
    startedAt: now,
    updatedAt: now,
    counters: {},
    gauges: {},
  };
}

function cloneSnapshot(): StreamingPerformanceSnapshot {
  return {
    startedAt: metricsState.startedAt,
    updatedAt: metricsState.updatedAt,
    counters: { ...metricsState.counters },
    gauges: { ...metricsState.gauges },
  };
}

export function recordStreamingPerformanceCounter(
  name: StreamingPerformanceCounter,
  amount = 1,
): StreamingPerformanceSnapshot {
  metricsState = {
    ...metricsState,
    updatedAt: Date.now(),
    counters: {
      ...metricsState.counters,
      [name]: (metricsState.counters[name] || 0) + amount,
    },
  };
  return cloneSnapshot();
}

export function setStreamingPerformanceGauge(
  name: StreamingPerformanceGauge,
  value: number,
): StreamingPerformanceSnapshot {
  metricsState = {
    ...metricsState,
    updatedAt: Date.now(),
    gauges: {
      ...metricsState.gauges,
      [name]: value,
    },
  };
  return cloneSnapshot();
}

export function getStreamingPerformanceSnapshot(): StreamingPerformanceSnapshot {
  return cloneSnapshot();
}

export function resetStreamingPerformanceMetrics(): StreamingPerformanceSnapshot {
  metricsState = createEmptySnapshot();
  return cloneSnapshot();
}

export function installStreamingPerformanceDebugApi(): StreamingPerformanceDebugApi {
  const api: StreamingPerformanceDebugApi = {
    snapshot: getStreamingPerformanceSnapshot,
    reset: resetStreamingPerformanceMetrics,
    record: recordStreamingPerformanceCounter,
  };
  (globalThis as typeof globalThis & Record<typeof GLOBAL_KEY, StreamingPerformanceDebugApi>)[GLOBAL_KEY] = api;
  return api;
}

installStreamingPerformanceDebugApi();
