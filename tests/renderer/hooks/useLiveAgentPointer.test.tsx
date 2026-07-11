// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPointerEvent } from '../../../src/shared/contract';
import { useLiveAgentPointer } from '../../../src/renderer/hooks/useLiveAgentPointer';
import { useAgentPointerStore } from '../../../src/renderer/stores/agentPointerStore';

const NOW_MS = 10_000;

function pointerEvent(id: string, expiresAtMs: number): AgentPointerEvent {
  return {
    id,
    surface: 'browser',
    tone: 'browser',
    phase: 'move',
    coordSpace: 'browserViewport',
    point: { x: 120, y: 80, unit: 'px' },
    targetSource: 'coordinate',
    success: null,
    expiresAtMs,
  };
}

function record(event: AgentPointerEvent): void {
  act(() => useAgentPointerStore.getState().recordEvent(event));
}

describe('useLiveAgentPointer', () => {
  beforeEach(() => {
    useAgentPointerStore.getState().clearAll();
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    cleanup();
    useAgentPointerStore.getState().clearAll();
    vi.useRealTimers();
  });

  it('transitions from live to idle exactly at the entry TTL', () => {
    const view = renderHook(() => useLiveAgentPointer('browser'));
    record(pointerEvent('live', NOW_MS + 1_000));

    expect(view.result.current.event?.id).toBe('live');
    expect(view.result.current.isLive).toBe(true);

    act(() => vi.advanceTimersByTime(999));
    expect(view.result.current.isLive).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(view.result.current.event).toBeNull();
    expect(view.result.current.isLive).toBe(false);
  });

  it('rejects an already-expired event arriving after a delay', () => {
    const view = renderHook(() => useLiveAgentPointer('browser'));
    act(() => vi.setSystemTime(NOW_MS + 5_000));
    record(pointerEvent('delayed', NOW_MS + 4_000));

    expect(view.result.current.event).toBeNull();
    expect(view.result.current.isLive).toBe(false);
    expect(view.result.current.lastEvent?.id).toBe('delayed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the old expiry and arms the replacement entry timeout', () => {
    const view = renderHook(() => useLiveAgentPointer('browser'));
    record(pointerEvent('first', NOW_MS + 1_000));
    act(() => vi.advanceTimersByTime(500));

    record(pointerEvent('replacement', NOW_MS + 3_000));
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(500));
    expect(view.result.current.event?.id).toBe('replacement');
    expect(view.result.current.isLive).toBe(true);

    act(() => vi.advanceTimersByTime(2_000));
    expect(view.result.current.event).toBeNull();
    expect(view.result.current.isLive).toBe(false);
  });

  it('clears the entry-scoped timeout on unmount', () => {
    const view = renderHook(() => useLiveAgentPointer('browser'));
    record(pointerEvent('live', NOW_MS + 1_000));
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains lastEvent and lastBySurface after the live event expires', () => {
    const view = renderHook(() => useLiveAgentPointer('browser'));
    record(pointerEvent('retained', NOW_MS + 1_000));

    act(() => vi.advanceTimersByTime(1_000));

    expect(view.result.current.event).toBeNull();
    expect(view.result.current.lastEvent?.id).toBe('retained');
    expect(useAgentPointerStore.getState().lastBySurface.browser?.event.id).toBe('retained');
  });
});
