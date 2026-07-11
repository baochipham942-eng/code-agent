import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/styles/global.css';
import { TurnBasedTraceView } from '../../src/renderer/components/features/chat/TurnBasedTraceView';
import type { SearchMatch } from '../../src/renderer/components/features/chat/ChatSearchBar';
import type { TraceProjection, TraceTurn } from '../../src/shared/contract/trace';

interface LongTaskEntry {
  startTime: number;
  duration: number;
}

interface LongSessionBrowserResult {
  scenarios: {
    turns500: { interactiveMs: number; renderedTurns: number };
    turns1000: { updateMs: number; renderedTurns: number };
    denseCodeStreaming: { codeBlocks: number; updates: number; durationMs: number };
    historyPrepend: { prependedTurns: number; anchorTurnId: string; anchorDriftPx: number; firstItemIndex: number | null };
    userScroll: { retainedPosition: boolean; distanceFromBottomPx: number };
    streamingFollow: { resumedAtBottom: boolean; distanceFromBottomPx: number };
    search: { targetTurnIndex: number; targetMounted: boolean; targetVisible: boolean };
    /** Renderer-only state transition. This is not evidence that a real tool or Run stopped. */
    uiStateSimulation: { convergenceMs: number; terminal: boolean };
  };
  mainThread: {
    longTaskCount: number;
    longTaskMaxMs: number;
    longTaskTotalMs: number;
    over500ms: number;
  };
  memory: {
    supported: boolean;
    baselineBytes: number | null;
    peakBytes: number | null;
    deltaBytes: number | null;
  };
}

declare global {
  interface Window {
    __LONG_SESSION_STARTED_AT__?: number;
    __LONG_SESSION_LONG_TASKS__?: LongTaskEntry[];
    __LONG_SESSION_RESULT__?: LongSessionBrowserResult;
  }
}

const SESSION_ID = 'long-session-gold';
const CODE_BLOCK_COUNT = 100;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | null, timeoutMs = 3_000): Promise<T | null> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(50);
  }
  return null;
}

function makeTurn(index: number, prefix = 'turn'): TraceTurn {
  const number = index + 1;
  return {
    turnNumber: number,
    turnId: `${prefix}-${number}`,
    status: 'completed',
    startTime: 1_780_000_000_000 + number * 2_000,
    endTime: 1_780_000_000_900 + number * 2_000,
    nodes: [
      {
        id: `${prefix}-user-${number}`,
        type: 'user',
        content: `Question ${number}`,
        timestamp: 1_780_000_000_000 + number * 2_000,
      },
      {
        id: `${prefix}-assistant-${number}`,
        type: 'assistant_text',
        content: number === 121 ? `SEARCH_TARGET_${number}` : `Answer ${number}. `.repeat(5),
        reasoning: number % 10 === 0 ? `Thinking evidence ${number}` : undefined,
        timestamp: 1_780_000_000_700 + number * 2_000,
      },
    ],
  };
}

function makeProjection(turnCount: number): TraceProjection {
  return {
    sessionId: SESSION_ID,
    turns: Array.from({ length: turnCount }, (_, index) => makeTurn(index)),
    activeTurnIndex: -1,
  };
}

function makeDenseCodeContent(suffix = ''): string {
  return Array.from({ length: CODE_BLOCK_COUNT }, (_, index) => [
    `Block ${index + 1}`,
    '```ts',
    `export const block_${index + 1} = ${index + 1};`,
    '```',
  ].join('\n')).join('\n\n') + suffix;
}

function heapBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null;
}

function installLongTaskObserver(): void {
  window.__LONG_SESSION_LONG_TASKS__ = [];
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__LONG_SESSION_LONG_TASKS__?.push({
        startTime: round(entry.startTime),
        duration: round(entry.duration),
      });
    }
  });
  observer.observe({ entryTypes: ['longtask'] });
}

function getScroller(): HTMLElement {
  const scroller = document.querySelector<HTMLElement>('[role="log"]');
  if (!scroller) throw new Error('Long-session harness could not find the Virtuoso scroller.');
  return scroller;
}

function distanceFromBottom(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
}

function getVisibleAnchor(scroller: HTMLElement): HTMLElement | null {
  const scrollerRect = scroller.getBoundingClientRect();
  return Array.from(scroller.querySelectorAll<HTMLElement>('[data-trace-turn-id]'))
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom)
    .sort((left, right) => left.rect.top - right.rect.top)[0]?.element ?? null;
}

function LongSessionHarness(): React.ReactElement {
  const [projection, setProjection] = useState<TraceProjection>(() => makeProjection(500));
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const startedRef = useRef(window.__LONG_SESSION_STARTED_AT__ ?? performance.now());
  const baselineHeapRef = useRef(heapBytes());

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      await nextFrame();
      const turns500InteractiveMs = round(performance.now() - startedRef.current);

      const turns1000StartedAt = performance.now();
      setProjection(makeProjection(1000));
      await nextFrame();
      const turns1000UpdateMs = round(performance.now() - turns1000StartedAt);

      const denseStartedAt = performance.now();
      let denseProjection = makeProjection(1000);
      denseProjection = {
        ...denseProjection,
        activeTurnIndex: 999,
        turns: denseProjection.turns.map((turn, index) => index === 999 ? {
          ...turn,
          status: 'streaming',
          nodes: [
            turn.nodes[0],
            { ...turn.nodes[1], content: makeDenseCodeContent() },
          ],
        } : turn),
      };
      setProjection(denseProjection);
      await nextFrame();
      for (let update = 1; update <= 20; update += 1) {
        const suffix = `\nstream-update-${update}`;
        setProjection((current) => ({
          ...current,
          turns: current.turns.map((turn, index) => index === 999 ? {
            ...turn,
            nodes: [turn.nodes[0], { ...turn.nodes[1], content: makeDenseCodeContent(suffix) }],
          } : turn),
        }));
        await nextFrame();
      }
      const denseDurationMs = round(performance.now() - denseStartedAt);

      // Let the last output-follow layout task settle before beginning a new,
      // explicit user scroll gesture.
      await delay(500);
      const scroller = getScroller();
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      scroller.scrollTo({ top: 0, behavior: 'auto' });
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitFor(() => scroller.scrollTop < 100 ? true : null);
      await delay(100);
      setProjection((current) => ({
        ...current,
        turns: current.turns.map((turn, index) => index === 999 ? {
          ...turn,
          nodes: [turn.nodes[0], { ...turn.nodes[1], content: `${turn.nodes[1].content}\nuser-scroll-update` }],
        } : turn),
      }));
      await delay(350);
      const userScrollDistance = distanceFromBottom(scroller);

      const jumpButton = await waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="回到底部"]'));
      jumpButton?.click();
      await delay(500);
      const resumedDistance = distanceFromBottom(scroller);

      const targetIndex = 120;
      setProjection(makeProjection(1000));
      setSearchMatches([
        { turnIndex: 999, nodeIndex: 1, offset: 0 },
        { turnIndex: targetIndex, nodeIndex: 1, offset: 0 },
      ]);
      setActiveMatchIndex(1);
      const searchTarget = await waitFor(
        () => document.querySelector<HTMLElement>('[data-trace-turn-id="turn-121"]'),
        5_000,
      );
      const searchRect = searchTarget?.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const searchVisible = Boolean(searchRect && searchRect.bottom >= scrollerRect.top && searchRect.top <= scrollerRect.bottom);

      // Search navigation and history prepend have independent gates. Clear the
      // active search before measuring prepend so its scroll effect cannot race
      // Virtuoso's firstItemIndex anchor preservation.
      setSearchMatches([]);
      setActiveMatchIndex(0);
      await nextFrame();
      const visibleAnchor = getVisibleAnchor(scroller);
      const anchorTurnId = visibleAnchor?.dataset.traceTurnId ?? '';
      const anchorBefore = visibleAnchor?.getBoundingClientRect().top ?? Number.NaN;
      const olderTurns = Array.from({ length: 30 }, (_, index) => makeTurn(index, 'older'));
      setSearchMatches([
        { turnIndex: 1_029, nodeIndex: 1, offset: 0 },
        { turnIndex: targetIndex + 30, nodeIndex: 1, offset: 0 },
      ]);
      setProjection((current) => ({
        ...current,
        turns: [...olderTurns, ...current.turns],
        activeTurnIndex: -1,
      }));
      await waitFor(() => document.querySelector('[data-long-session-status]')?.textContent === '1030 turns' ? true : null);
      await nextFrame();
      await waitFor(
        () => document.querySelector<HTMLElement>(`[data-trace-turn-id="${anchorTurnId}"]`),
        3_000,
      );
      await nextFrame();
      const anchoredTarget = document.querySelector<HTMLElement>(`[data-trace-turn-id="${anchorTurnId}"]`);
      const anchorAfter = anchoredTarget?.getBoundingClientRect().top ?? Number.NaN;
      const anchorDriftPx = Number.isFinite(anchorBefore) && Number.isFinite(anchorAfter)
        ? round(Math.abs(anchorAfter - anchorBefore))
        : Number.POSITIVE_INFINITY;

      const stopStartedAt = performance.now();
      await nextFrame();
      const terminal = true;
      const convergenceMs = round(performance.now() - stopStartedAt);

      const longTasks = window.__LONG_SESSION_LONG_TASKS__ ?? [];
      const peakHeap = heapBytes();
      const baselineHeap = baselineHeapRef.current;
      const result: LongSessionBrowserResult = {
        scenarios: {
          turns500: { interactiveMs: turns500InteractiveMs, renderedTurns: 500 },
          turns1000: { updateMs: turns1000UpdateMs, renderedTurns: 1000 },
          denseCodeStreaming: { codeBlocks: CODE_BLOCK_COUNT, updates: 20, durationMs: denseDurationMs },
          historyPrepend: {
            prependedTurns: 30,
            anchorTurnId,
            anchorDriftPx,
            firstItemIndex: Number(document.querySelector('[data-virtuoso-first-item-index]')?.getAttribute('data-virtuoso-first-item-index')) || null,
          },
          userScroll: { retainedPosition: userScrollDistance > 96, distanceFromBottomPx: round(userScrollDistance) },
          streamingFollow: { resumedAtBottom: resumedDistance <= 96, distanceFromBottomPx: round(resumedDistance) },
          search: { targetTurnIndex: targetIndex, targetMounted: Boolean(searchTarget), targetVisible: searchVisible },
          uiStateSimulation: { convergenceMs, terminal },
        },
        mainThread: {
          longTaskCount: longTasks.length,
          longTaskMaxMs: round(longTasks.length ? Math.max(...longTasks.map((task) => task.duration)) : 0),
          longTaskTotalMs: round(longTasks.reduce((sum, task) => sum + task.duration, 0)),
          over500ms: longTasks.filter((task) => task.duration >= 500).length,
        },
        memory: {
          supported: baselineHeap !== null && peakHeap !== null,
          baselineBytes: baselineHeap,
          peakBytes: peakHeap,
          deltaBytes: baselineHeap !== null && peakHeap !== null ? peakHeap - baselineHeap : null,
        },
      };

      if (!cancelled) {
        window.__LONG_SESSION_RESULT__ = result;
        document.body.setAttribute('data-long-session-ready', 'true');
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const status = useMemo(() => `${projection.turns.length} turns`, [projection.turns.length]);
  return (
    <main className="h-screen bg-zinc-950 text-zinc-100">
      <div className="h-8 px-3 py-1 text-xs" data-long-session-status>{status}</div>
      <div className="h-[calc(100vh-2rem)]">
        <TurnBasedTraceView
          projection={projection}
          searchMatches={searchMatches}
          activeMatchIndex={activeMatchIndex}
        />
      </div>
    </main>
  );
}

installLongTaskObserver();
window.__LONG_SESSION_STARTED_AT__ = performance.now();
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for long-session harness.');
createRoot(root).render(<LongSessionHarness />);
