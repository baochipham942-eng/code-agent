import React, { Profiler, useLayoutEffect, useState, type ReactNode } from 'react';
import type { JourneyId, JourneyLongTask, JourneyProbeResult } from './journey-probe-protocol';
import { roundMs } from './journey-probe-protocol';

export interface JourneyInstrument {
  commitCount: number;
  hotRenderCount: number;
  onRender: () => void;
  HotProbe: (props: { children: ReactNode }) => React.ReactElement;
}

declare global {
  interface Window {
    __PERF_JOURNEY_RESULT__?: JourneyProbeResult;
    __PERF_JOURNEY_LONG_TASKS__?: JourneyLongTask[];
    __PERF_JOURNEY_STARTED_AT__?: number;
    __PERF_JOURNEY_PAD__?: number;
  }
}

export function extraRenderCount(): number {
  const raw = new URLSearchParams(window.location.search).get('extraRenders');
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function createJourneyInstrument(): JourneyInstrument {
  const state = {
    commitCount: 0,
    hotRenderCount: 0,
  };

  function HotProbe({ children }: { children: ReactNode }): React.ReactElement {
    state.hotRenderCount += 1;
    return <>{children}</>;
  }

  return {
    get commitCount() {
      return state.commitCount;
    },
    get hotRenderCount() {
      return state.hotRenderCount;
    },
    onRender() {
      state.commitCount += 1;
    },
    HotProbe,
  };
}

export function ExtraRenderBurst({ count }: { count: number }): null {
  const [tick, setTick] = useState(0);
  useLayoutEffect(() => {
    if (count <= 0) return undefined;
    if (tick < count) setTick((current) => current + 1);
    return undefined;
  }, [count, tick]);
  if (count > 0 && tick > 0) {
    let acc = 0;
    for (let index = 0; index < 3_000_000; index += 1) acc += Math.imul(index, 17);
    window.__PERF_JOURNEY_PAD__ = (window.__PERF_JOURNEY_PAD__ ?? 0) + acc;
  }
  return null;
}

export function JourneyProfiler({
  id,
  instrument,
  children,
}: {
  id: JourneyId;
  instrument: JourneyInstrument;
  children: ReactNode;
}): React.ReactElement {
  return (
    <Profiler id={id} onRender={instrument.onRender}>
      <ExtraRenderBurst count={extraRenderCount()} />
      {children}
    </Profiler>
  );
}

export function installLongTaskObserver(): void {
  window.__PERF_JOURNEY_LONG_TASKS__ = [];
  if (!('PerformanceObserver' in window)) return;
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__PERF_JOURNEY_LONG_TASKS__?.push({
          name: entry.name,
          startTime: roundMs(entry.startTime),
          duration: roundMs(entry.duration),
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Long-task observation is best-effort and never gated.
  }
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function publishJourneyResult(
  journey: JourneyId,
  instrument: JourneyInstrument,
  ready: Record<string, unknown>,
): void {
  const startedAt = window.__PERF_JOURNEY_STARTED_AT__ ?? performance.now();
  const longTasks = window.__PERF_JOURNEY_LONG_TASKS__ ?? [];
  const result: JourneyProbeResult = {
    schemaVersion: 1,
    journey,
    commitCount: instrument.commitCount,
    hotRenderCount: instrument.hotRenderCount,
    wallClockMs: roundMs(performance.now() - startedAt),
    longTaskCount: longTasks.length,
    longTaskMaxMs: longTasks.length > 0
      ? roundMs(Math.max(...longTasks.map((task) => task.duration)))
      : 0,
    extraRenders: extraRenderCount(),
    ready,
  };
  window.__PERF_JOURNEY_RESULT__ = result;
  document.body.setAttribute('data-perf-journey-ready', journey);
}

export function markJourneyStarted(): void {
  window.__PERF_JOURNEY_STARTED_AT__ = performance.now();
}

export function publishJourneyError(error: unknown): void {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  document.body.setAttribute('data-perf-journey-error', message);
  console.error(error);
}
