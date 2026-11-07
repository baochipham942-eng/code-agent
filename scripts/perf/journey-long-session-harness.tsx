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
} from './journey-probe-instrument';

const instrument = createJourneyInstrument();
const TURN_COUNT = 32;
const SESSION_ID = 'perf-journey-long-session';

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
  throw new Error('long-session: Virtuoso scroller missing');
}

async function waitForMountedTurns(): Promise<number> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const mounted = document.querySelectorAll('[data-trace-turn-id]').length;
    if (mounted > 0) return mounted;
    await nextFrame();
  }
  throw new Error('long-session: no turns mounted');
}

function LongSessionSurface(): React.ReactElement {
  const projection = useMemo(() => makeProjection(TURN_COUNT), []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const scroller = await waitForScroller();
        const mountedTurns = await waitForMountedTurns();
        // The wheel fires right after the first turn mounts, before Virtuoso's
        // first rangeChanged: it marks a user interaction, so
        // useSessionEntryScroll aborts the session-entry settlement before its
        // bottom jump and 60-frame re-pin loop start. Letting the settlement
        // run instead is not measurable: its re-pin loop overlaps the
        // progressive height-measurement phase and self-sustains a
        // 2-commits-per-frame oscillation whose last frame batch-merges +-1
        // (130/131/132 across runs of one commit).
        // No scripted scrollTop jump follows the wheel: every window-swap
        // scroll mounts rows whose heights are still estimates, and the
        // estimate->measured correction tail lands ~300ms later in most runs
        // but not all (18/19/20 across runs). The deterministic surface is the
        // entry itself - mount cascade plus the user-scroll-start signal -
        // which holds a single count across runs.
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true }));
        // Publishing at a fixed frame read this cascade mid-flight (the
        // historical 18/19 flake); publish only once commits fall silent.
        await waitForCommitSettlement(instrument);
        const settledTurns = Math.max(mountedTurns, document.querySelectorAll('[data-trace-turn-id]').length);
        if (!cancelled) {
          publishJourneyResult('long-session', instrument, {
            turnCount: TURN_COUNT,
            mountedTurns: settledTurns,
            scrollTop: Math.round(scroller.scrollTop),
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
      <div style={{ height: 32, padding: '4px 12px', fontSize: 12 }} data-long-session-status>{status}</div>
      <div style={{ height: 'calc(100vh - 32px)' }}>
        <instrument.HotProbe>
          <TurnBasedTraceView projection={projection} />
        </instrument.HotProbe>
      </div>
    </main>
  );
}

function LongSessionJourney(): React.ReactElement {
  return (
    <JourneyProfiler id="long-session" instrument={instrument}>
      <LongSessionSurface />
    </JourneyProfiler>
  );
}

installLongTaskObserver();
markJourneyStarted();
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for long-session journey.');
createRoot(root).render(<LongSessionJourney />);
