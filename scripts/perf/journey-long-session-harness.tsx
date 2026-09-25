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
        const mountedBefore = await waitForMountedTurns();
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true }));
        scroller.scrollTop = Math.min(240, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await nextFrame();
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await nextFrame();
        const mountedTurns = Math.max(mountedBefore, document.querySelectorAll('[data-trace-turn-id]').length);
        if (mountedTurns < 1) throw new Error('long-session: no turns mounted after scroll');
        if (!cancelled) {
          publishJourneyResult('long-session', instrument, {
            turnCount: TURN_COUNT,
            mountedTurns,
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
