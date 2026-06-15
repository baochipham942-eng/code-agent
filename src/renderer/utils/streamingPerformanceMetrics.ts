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

export type StreamingPerformanceTiming =
  | 'stream.projection.base_ms'
  | 'stream.projection.overlay_ms'
  | 'stream.diff.summary_ms'
  | 'stream.diff.lines_ms'
  | 'stream.markdown.render_ms'
  | 'stream.code.preview_ms'
  | 'stream.code.highlight_ms';

export interface StreamingPerformanceTimingSummary {
  count: number;
  totalMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
  p95Ms: number;
  recentMs: number[];
}

export interface StreamingPerformanceSnapshot {
  startedAt: number;
  updatedAt: number;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  timings: Record<string, StreamingPerformanceTimingSummary>;
}

export interface StreamingPerformanceDebugApi {
  snapshot: () => StreamingPerformanceSnapshot;
  reset: () => StreamingPerformanceSnapshot;
  record: (name: StreamingPerformanceCounter, amount?: number) => StreamingPerformanceSnapshot;
  time: (name: StreamingPerformanceTiming, durationMs: number) => StreamingPerformanceSnapshot;
}

const GLOBAL_KEY = '__CODE_AGENT_STREAMING_PERF__';
const MAX_RECENT_TIMING_SAMPLES = 100;

let metricsState: StreamingPerformanceSnapshot = createEmptySnapshot();

function createEmptySnapshot(): StreamingPerformanceSnapshot {
  const now = Date.now();
  return {
    startedAt: now,
    updatedAt: now,
    counters: {},
    gauges: {},
    timings: {},
  };
}

function cloneTimingSummary(summary: StreamingPerformanceTimingSummary): StreamingPerformanceTimingSummary {
  return {
    ...summary,
    recentMs: [...summary.recentMs],
  };
}

function cloneSnapshot(): StreamingPerformanceSnapshot {
  return {
    startedAt: metricsState.startedAt,
    updatedAt: metricsState.updatedAt,
    counters: { ...metricsState.counters },
    gauges: { ...metricsState.gauges },
    timings: Object.fromEntries(
      Object.entries(metricsState.timings).map(([name, summary]) => [name, cloneTimingSummary(summary)]),
    ),
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

function roundTiming(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function percentile(samples: number[], ratio: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function summarizeTiming(
  existing: StreamingPerformanceTimingSummary | undefined,
  durationMs: number,
): StreamingPerformanceTimingSummary {
  const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  const recentMs = [...(existing?.recentMs ?? []), roundTiming(safeDuration)].slice(-MAX_RECENT_TIMING_SAMPLES);
  const count = (existing?.count ?? 0) + 1;
  const totalMs = (existing?.totalMs ?? 0) + safeDuration;
  const minMs = existing ? Math.min(existing.minMs, safeDuration) : safeDuration;
  const maxMs = existing ? Math.max(existing.maxMs, safeDuration) : safeDuration;

  return {
    count,
    totalMs: roundTiming(totalMs),
    meanMs: roundTiming(totalMs / count),
    minMs: roundTiming(minMs),
    maxMs: roundTiming(maxMs),
    lastMs: roundTiming(safeDuration),
    p95Ms: roundTiming(percentile(recentMs, 0.95)),
    recentMs,
  };
}

export function recordStreamingPerformanceTiming(
  name: StreamingPerformanceTiming,
  durationMs: number,
): StreamingPerformanceSnapshot {
  metricsState = {
    ...metricsState,
    updatedAt: Date.now(),
    timings: {
      ...metricsState.timings,
      [name]: summarizeTiming(metricsState.timings[name], durationMs),
    },
  };
  return cloneSnapshot();
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function measureStreamingPerformanceTiming<T>(
  name: StreamingPerformanceTiming,
  fn: () => T,
): T {
  const startedAt = nowMs();
  try {
    return fn();
  } finally {
    recordStreamingPerformanceTiming(name, nowMs() - startedAt);
  }
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
    time: recordStreamingPerformanceTiming,
  };
  (globalThis as typeof globalThis & Record<typeof GLOBAL_KEY, StreamingPerformanceDebugApi>)[GLOBAL_KEY] = api;
  return api;
}

installStreamingPerformanceDebugApi();
