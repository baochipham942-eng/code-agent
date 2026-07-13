import React, { useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/styles/global.css';
import { TurnBasedTraceView } from '../../src/renderer/components/features/chat/TurnBasedTraceView';
import {
  getStreamingPerformanceSnapshot,
  resetStreamingPerformanceMetrics,
  type StreamingPerformanceSnapshot,
} from '../../src/renderer/utils/streamingPerformanceMetrics';
import type { TraceProjection, TraceTurn } from '../../src/shared/contract/trace';

interface TurnContentVisibilityBrowserResult {
  mode: 'before' | 'after';
  initialRenderMs: number;
  scrollRenderMs: number;
  mountedTurns: number;
  deferredContentBlocks: number;
  computedStyle: {
    contentVisibility: string;
    containIntrinsicSize: string;
    scrollerScrollBehavior: string;
  };
  streamingPerformanceMetrics: StreamingPerformanceSnapshot;
}

declare global {
  interface Window {
    __TURN_CONTENT_VISIBILITY_RESULT__?: TurnContentVisibilityBrowserResult;
  }
}

const TURN_COUNT = 500;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function makeHeavyMarkdown(index: number): string {
  return Array.from({ length: 18 }, (_, paragraph) => (
    `Turn ${index + 1}, paragraph ${paragraph + 1}. `
    + 'This completed assistant content exercises offscreen markdown layout and paint containment. '.repeat(2)
  )).join('\n\n');
}

function makeTurn(index: number): TraceTurn {
  const timestamp = 1_780_000_000_000 + index * 2_000;
  return {
    turnNumber: index + 1,
    turnId: `perf-turn-${index + 1}`,
    status: 'completed',
    startTime: timestamp,
    endTime: timestamp + 900,
    nodes: [
      { id: `perf-user-${index + 1}`, type: 'user', content: `Question ${index + 1}`, timestamp },
      {
        id: `perf-assistant-${index + 1}`,
        type: 'assistant_text',
        content: makeHeavyMarkdown(index),
        timestamp: timestamp + 700,
      },
    ],
  };
}

function Harness(): React.ReactElement {
  const startedAtRef = useRef(performance.now());
  const projection = useMemo<TraceProjection>(() => ({
    sessionId: 'turn-content-visibility-perf',
    turns: Array.from({ length: TURN_COUNT }, (_, index) => makeTurn(index)),
    activeTurnIndex: -1,
  }), []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      await nextFrame();
      const initialRenderMs = performance.now() - startedAtRef.current;
      const scroller = document.querySelector<HTMLElement>('[role="log"]');
      if (!scroller) throw new Error('Virtuoso scroller was not mounted.');

      const scrollStartedAt = performance.now();
      scroller.scrollTo({ top: Math.max(0, scroller.scrollHeight * 0.45), behavior: 'auto' });
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await nextFrame();
      const scrollRenderMs = performance.now() - scrollStartedAt;
      const deferredBlock = document.querySelector<HTMLElement>('[data-turn-heavy-content="true"]');
      if (!deferredBlock) throw new Error('Heavy turn content was not mounted.');

      const blockStyle = getComputedStyle(deferredBlock);
      const scrollerStyle = getComputedStyle(scroller);
      const result: TurnContentVisibilityBrowserResult = {
        mode: document.documentElement.dataset.contentVisibility === 'off' ? 'before' : 'after',
        initialRenderMs: round(initialRenderMs),
        scrollRenderMs: round(scrollRenderMs),
        mountedTurns: document.querySelectorAll('[data-trace-turn-id]').length,
        deferredContentBlocks: document.querySelectorAll('[data-turn-heavy-content="true"]').length,
        computedStyle: {
          contentVisibility: blockStyle.contentVisibility,
          containIntrinsicSize: blockStyle.containIntrinsicSize,
          scrollerScrollBehavior: scrollerStyle.scrollBehavior,
        },
        streamingPerformanceMetrics: getStreamingPerformanceSnapshot(),
      };
      if (!cancelled) {
        window.__TURN_CONTENT_VISIBILITY_RESULT__ = result;
        document.body.dataset.turnContentVisibilityReady = 'true';
      }
    };

    void run();
    return () => { cancelled = true; };
  }, []);

  return (
    <main className="h-screen bg-zinc-950 text-zinc-100">
      <TurnBasedTraceView projection={projection} />
    </main>
  );
}

resetStreamingPerformanceMetrics();
const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.contentVisibility = params.get('mode') === 'before' ? 'off' : 'on';
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for turn content visibility harness.');
createRoot(root).render(<Harness />);
