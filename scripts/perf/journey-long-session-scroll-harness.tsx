import React, { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { TurnBasedTraceView } from '../../src/renderer/components/features/chat/TurnBasedTraceView';
import type { TraceProjection, TraceTurn } from '../../src/shared/contract/trace';
import {
  createJourneyInstrument,
  installLongTaskObserver,
  JourneyProfiler,
  markJourneyStarted,
  nextFrame,
  publishJourneyError,
  publishJourneyResult,
  waitForCommitSettlement,
  type JourneyInstrument,
} from './journey-probe-instrument';

const instrument = createJourneyInstrument();
const TURN_COUNT = 32;
const SESSION_ID = 'perf-journey-long-session-scroll';
// Must equal defaultItemHeight in TurnBasedTraceView's Virtuoso: the fixture
// below pins every rendered row to this height, so the estimate a newly
// mounted row starts with is already its measured height and the
// estimate->measured correction tail (the historical 18/19/20 window-swap
// flake, see scripts/perf-journey-ratchet-baseline.json) never exists on this
// journey. If defaultItemHeight ever drifts, the estimate mismatch adds work
// and the ratchet catches the changed count; the drain below still refuses to
// publish while that correction is in flight.
const FIXTURE_ROW_HEIGHT_PX = 80;

function createScrollPhaseInstrument(startCommitCount: number): JourneyInstrument {
  return {
    get commitCount() {
      return instrument.commitCount - startCommitCount;
    },
    get hotRenderCount() {
      return instrument.hotRenderCount;
    },
    onRender: instrument.onRender,
    HotProbe: instrument.HotProbe,
  };
}

// Fixed-height fixture (N-PERF-LONG-SESSION-SCROLL-COVERAGE): deterministic
// row heights for the scripted window-swap scrolls. The [data-trace-turn-id]
// div is the only child of the Virtuoso item wrapper, so pinning it pins the
// measured wrapper size too. Harness-only CSS - no product file is touched.
// The scroller geometry stays exactly the long-session probe's (Tailwind is
// not loaded on probe pages, so the product's h-full list container resolves
// to 0 there): that is the geometry whose entry cascade is proven
// deterministic (13 across 22+ runs of one commit), and the swaps below move
// the mounted window across the full scroll range on top of it.
const fixtureStyle = document.createElement('style');
fixtureStyle.textContent = `[data-trace-turn-id] { height: ${FIXTURE_ROW_HEIGHT_PX}px !important; overflow: hidden !important; margin: 0 !important; }`;
document.head.appendChild(fixtureStyle);

function makeTurn(index: number): TraceTurn {
  const number = index + 1;
  return {
    turnNumber: number,
    turnId: `turn-${number}`,
    status: 'completed',
    startTime: 1_780_000_000_000 + number * 2_000,
    endTime: 1_780_000_000_900 + number * 2_000,
    nodes: [
      {
        id: `user-${number}`,
        type: 'user',
        content: `Question ${number}`,
        timestamp: 1_780_000_000_000 + number * 2_000,
      },
      {
        id: `assistant-${number}`,
        type: 'assistant_text',
        content: `Answer ${number}.`,
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

async function waitForScroller(): Promise<HTMLElement> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const scroller = document.querySelector<HTMLElement>('[role="log"]');
    if (scroller) return scroller;
    await nextFrame();
  }
  throw new Error('long-session-scroll: Virtuoso scroller missing');
}

async function waitForMountedTurns(): Promise<number> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const mounted = document.querySelectorAll('[data-trace-turn-id]').length;
    if (mounted > 0) return mounted;
    await nextFrame();
  }
  throw new Error('long-session-scroll: no turns mounted');
}

/**
 * Drain gate: every mounted Virtuoso row's known size equals its real rendered
 * height, i.e. no estimate->measured correction is still in flight.
 * react-virtuoso lands size corrections via ResizeObserver -> rAF -> store ->
 * React flush, and the trailing correction commit of a window swap is what
 * made the pre-#2831 scroll protocol read 18/19/20 on one commit. With the
 * fixture above this passes on the first check; if it ever stops matching,
 * the journey fails loudly here instead of publishing half-settled.
 */
async function waitForMountedRowsMeasured(): Promise<void> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="virtuoso-item-list"] [data-item-index]'));
    if (
      rows.length > 0
      && rows.every((row) => Math.round(row.getBoundingClientRect().height) === Number(row.dataset.knownSize))
    ) {
      return;
    }
    if (performance.now() >= deadline) {
      throw new Error('long-session-scroll: mounted rows never reached measured heights (estimate->measured correction tail did not settle; check FIXTURE_ROW_HEIGHT_PX against defaultItemHeight)');
    }
    await nextFrame();
  }
}

/**
 * Wait until the current cascade is fully drained: commit silence first, then
 * every mounted row measured. If the drain wait let a late correction commit
 * through, the count moved and the settle repeats - the loop exits only from
 * a state (silent + measured + count unchanged across both checks) that is
 * identical across runs, so the next scripted step starts deterministically.
 */
async function settleScrollStep(): Promise<void> {
  let seen = instrument.commitCount;
  for (;;) {
    await waitForCommitSettlement(instrument);
    await waitForMountedRowsMeasured();
    if (instrument.commitCount === seen) return;
    seen = instrument.commitCount;
  }
}

/**
 * One scripted window-swap step: jump, then drain. Do not synthesize a second
 * scroll event after the scrollTop write: Chromium already queues the native
 * event, and duplicating it made React batch the two handler cascades as four
 * or five commits depending on timing. One native event is deterministic.
 */
async function jumpScrollerTo(scroller: HTMLElement, top: number): Promise<void> {
  scroller.scrollTop = top;
  await settleScrollStep();
}

function LongSessionScrollSurface(): React.ReactElement {
  const projection = useMemo(() => makeProjection(TURN_COUNT), []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const scroller = await waitForScroller();
        await waitForMountedTurns();
        // Entry protocol identical to long-session (same scroller geometry,
        // same wheel timing): the wheel fires right after the first turn
        // mounts, before Virtuoso's first rangeChanged, so
        // useSessionEntryScroll aborts its bottom-jump settlement pre-jump
        // (product semantics: user scrolled, no auto re-pin) and the 60-frame
        // re-pin loop - measured at ~131 commits when it does run - never
        // starts on this journey either.
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true }));
        await settleScrollStep();
        const entryCommitCount = instrument.commitCount;
        // This journey gates the second phase only. Entry already has its own
        // long-session ratchet (13); excluding it also keeps CPU-load batching
        // in the mount cascade from contaminating the scroll/window-swap count.
        const scrollPhaseInstrument = createScrollPhaseInstrument(entryCommitCount);
        // Window swap 1: top window -> bottom window, every mounted row fresh.
        await jumpScrollerTo(scroller, scroller.scrollHeight);
        const bottomCommitCount = scrollPhaseInstrument.commitCount;
        const bottomMountedTurns = document.querySelectorAll('[data-trace-turn-id]').length;
        // Window swap 2: bottom window -> top window, fresh rows plus rows the
        // list already measured before the first swap.
        await jumpScrollerTo(scroller, 0);
        const settledTurns = document.querySelectorAll('[data-trace-turn-id]').length;
        if (!cancelled) {
          publishJourneyResult('long-session-scroll', scrollPhaseInstrument, {
            turnCount: TURN_COUNT,
            mountedTurns: Math.max(bottomMountedTurns, settledTurns),
            entryCommitCount,
            bottomCommitCount,
            scrollTopEnd: Math.round(scroller.scrollTop),
          });
        }
      } catch (error) {
        publishJourneyError(error);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const status = useMemo(() => `${projection.turns.length} turns`, [projection.turns.length]);

  return (
    <main style={{ height: '100vh' }}>
      <div style={{ height: 32, padding: '4px 12px', fontSize: 12 }} data-long-session-scroll-status>{status}</div>
      <div style={{ height: 'calc(100vh - 32px)' }}>
        <instrument.HotProbe>
          <TurnBasedTraceView projection={projection} />
        </instrument.HotProbe>
      </div>
    </main>
  );
}

function LongSessionScrollJourney(): React.ReactElement {
  return (
    <JourneyProfiler id="long-session-scroll" instrument={instrument}>
      <LongSessionScrollSurface />
    </JourneyProfiler>
  );
}

installLongTaskObserver();
markJourneyStarted();
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for long-session-scroll journey.');
createRoot(root).render(<LongSessionScrollJourney />);
