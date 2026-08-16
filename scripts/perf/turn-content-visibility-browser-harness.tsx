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
  deferredByType: Record<string, number>;
  observedTurnHeights: Record<string, number[]>;
  activeTurnDeferredBlocks: number;
  scrollFrames: {
    p95Ms: number;
    droppedFramesOver25Ms: number;
    anchorDriftPx: number | null;
    scrollHeightDriftPx: number;
  };
  computedStyle: Record<string, {
    contentVisibility: string;
    containIntrinsicSize: string;
    scrollBehavior?: string;
  }>;
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

async function waitForElement(selector: string, maxFrames = 120): Promise<HTMLElement | null> {
  for (let frame = 0; frame < maxFrames; frame += 1) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) return element;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return null;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function makeHeavyMarkdown(index: number): string {
  return Array.from({ length: 18 }, (_, paragraph) => (
    `Turn ${index + 1}, paragraph ${paragraph + 1}. `
    + 'This completed assistant content exercises offscreen markdown layout and paint containment. '.repeat(2)
  )).join('\n\n');
}

function makeTurn(index: number): TraceTurn {
  const timestamp = 1_780_000_000_000 + index * 2_000;
  const kind = index % 3;
  const assistantContent = kind === 2
    ? ['```ts', ...Array.from({ length: 40 }, (_, line) => `const turn${index}Line${line} = ${line};`), '```'].join('\n')
    : makeHeavyMarkdown(index);
  const toolNode = kind === 1 ? [{
    id: `perf-tool-node-${index + 1}`,
    messageId: `perf-assistant-${index + 1}`,
    type: 'tool_call' as const,
    content: '',
    timestamp: timestamp + 500,
    toolCall: {
      id: `perf-tool-${index + 1}`,
      name: 'Read',
      args: { file_path: `/tmp/perf-${index + 1}.ts` },
      result: 'completed',
      success: true,
      duration: 12,
    },
  }] : [];
  const isActive = index === TURN_COUNT - 1;
  return {
    turnNumber: index + 1,
    turnId: `perf-turn-${index + 1}`,
    status: isActive ? 'streaming' : 'completed',
    startTime: timestamp,
    endTime: timestamp + 900,
    nodes: [
      { id: `perf-user-${index + 1}`, type: 'user', content: `Question ${index + 1}`, timestamp },
      ...toolNode,
      {
        id: `perf-assistant-${index + 1}`,
        messageId: `perf-assistant-${index + 1}`,
        type: 'assistant_text',
        content: assistantContent,
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
    activeTurnIndex: TURN_COUNT - 1,
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
      const deferredBlock = await waitForElement('[data-deferred-content]');
      if (!deferredBlock) throw new Error('Deferred turn content was not mounted.');

      const styleSelectors = {
        turnText: '[data-deferred-content="turn"][data-deferred-content-kind="turnText"]',
        turnTool: '[data-deferred-content="turn"][data-deferred-content-kind="turnTool"]',
        turnCode: '[data-deferred-content="turn"][data-deferred-content-kind="turnCode"]',
        toolCard: '[data-deferred-content="tool-card"]',
        codeBlock: '[data-deferred-content="code-block"]',
      } as const;
      const observedStyles: Record<string, { contentVisibility: string; containIntrinsicSize: string }> = {};
      const observedTurnHeights: Record<string, number[]> = {};
      const captureMountedStyles = () => {
        for (const [key, selector] of Object.entries(styleSelectors)) {
          if (observedStyles[key]) continue;
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) continue;
          const style = getComputedStyle(element);
          observedStyles[key] = {
            contentVisibility: style.contentVisibility,
            containIntrinsicSize: style.containIntrinsicSize,
          };
        }
        for (const element of document.querySelectorAll<HTMLElement>('[data-deferred-content="turn"]')) {
          const kind = element.dataset.deferredContentKind;
          if (!kind) continue;
          const rect = element.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          if (rect.bottom <= scrollerRect.top || rect.top >= scrollerRect.bottom) continue;
          const heights = observedTurnHeights[kind] ?? [];
          const height = round(rect.height);
          if (!heights.includes(height)) heights.push(height);
          observedTurnHeights[kind] = heights;
        }
      };
      captureMountedStyles();

      const frameDurations: number[] = [];
      let previousFrameAt = performance.now();
      for (let frame = 0; frame < 48; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame((now) => {
          frameDurations.push(now - previousFrameAt);
          previousFrameAt = now;
          const direction = frame < 24 ? 1 : -1;
          scroller.scrollTop += direction * 180;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          resolve();
        }));
        captureMountedStyles();
      }
      await nextFrame();
      const visibleTurns = [...document.querySelectorAll<HTMLElement>('[data-trace-turn-id]')]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
        });
      const anchor = visibleTurns[0];
      const anchorTurnId = anchor?.dataset.traceTurnId;
      const anchorBefore = anchor?.getBoundingClientRect().top;
      const scrollHeightBefore = scroller.scrollHeight;
      await nextFrame();
      await nextFrame();
      const anchoredAfter = anchorTurnId
        ? document.querySelector<HTMLElement>(`[data-trace-turn-id="${anchorTurnId}"]`)
        : null;
      const anchorAfter = anchoredAfter?.getBoundingClientRect().top;
      const scrollHeightAfter = scroller.scrollHeight;

      const scrollerStyle = getComputedStyle(scroller);
      const result: TurnContentVisibilityBrowserResult = {
        mode: document.documentElement.dataset.contentVisibility === 'off' ? 'before' : 'after',
        initialRenderMs: round(initialRenderMs),
        scrollRenderMs: round(scrollRenderMs),
        mountedTurns: document.querySelectorAll('[data-trace-turn-id]').length,
        deferredContentBlocks: document.querySelectorAll('[data-deferred-content]').length,
        deferredByType: {
          turn: document.querySelectorAll('[data-deferred-content="turn"]').length,
          toolCard: document.querySelectorAll('[data-deferred-content="tool-card"]').length,
          codeBlock: document.querySelectorAll('[data-deferred-content="code-block"]').length,
          assistantText: document.querySelectorAll('[data-turn-heavy-content="true"]').length,
        },
        observedTurnHeights,
        activeTurnDeferredBlocks: document.querySelectorAll(
          `[data-trace-turn-id="perf-turn-${TURN_COUNT}"] [data-deferred-content], [data-trace-turn-id="perf-turn-${TURN_COUNT}"] [data-turn-heavy-content="true"]`,
        ).length,
        scrollFrames: {
          p95Ms: round(percentile95(frameDurations)),
          droppedFramesOver25Ms: frameDurations.filter((duration) => duration > 25).length,
          anchorDriftPx: typeof anchorBefore === 'number' && typeof anchorAfter === 'number'
            ? round(Math.abs(anchorAfter - anchorBefore))
            : null,
          scrollHeightDriftPx: round(Math.abs(scrollHeightAfter - scrollHeightBefore)),
        },
        computedStyle: {
          turnText: observedStyles.turnText ?? { contentVisibility: '', containIntrinsicSize: '' },
          turnTool: observedStyles.turnTool ?? { contentVisibility: '', containIntrinsicSize: '' },
          turnCode: observedStyles.turnCode ?? { contentVisibility: '', containIntrinsicSize: '' },
          toolCard: observedStyles.toolCard ?? { contentVisibility: '', containIntrinsicSize: '' },
          codeBlock: observedStyles.codeBlock ?? { contentVisibility: '', containIntrinsicSize: '' },
          scroller: {
            contentVisibility: scrollerStyle.contentVisibility,
            containIntrinsicSize: scrollerStyle.containIntrinsicSize,
            scrollBehavior: scrollerStyle.scrollBehavior,
          },
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
