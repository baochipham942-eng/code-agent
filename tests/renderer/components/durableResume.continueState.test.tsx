// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useDurableContinueVisible } from '../../../src/renderer/components/features/chat/durableResume';

describe('useDurableContinueVisible', () => {
  const parked = { mode: 'continue', canContinue: true };
  let loadSessions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loadSessions = vi.fn(async () => undefined);
    useSessionStore.setState({ loadSessions } as never);
  });

  it('shows Continue while idle and yields to Stop once the turn runs on a stale projection', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDurableContinueVisible(parked, active),
      { initialProps: { active: false } },
    );
    expect(result.current).toBe(true);
    rerender({ active: true });
    expect(result.current).toBe(false);
  });

  it('refreshes the session list whenever the run state flips so the projection catches up', () => {
    const { rerender } = renderHook(
      ({ active }) => useDurableContinueVisible(parked, active),
      { initialProps: { active: false } },
    );
    rerender({ active: true });
    rerender({ active: false });
    expect(loadSessions).toHaveBeenCalledTimes(3);
    expect(loadSessions).toHaveBeenCalledWith({ silent: true });
  });

  it('hides Continue for queued / non-continuable / absent projections and does not refresh without one', () => {
    expect(renderHook(() => useDurableContinueVisible({ mode: 'queued', canContinue: false }, false)).result.current).toBe(false);
    expect(renderHook(() => useDurableContinueVisible({ mode: 'continue', canContinue: false }, false)).result.current).toBe(false);
    loadSessions.mockClear();
    expect(renderHook(() => useDurableContinueVisible(undefined, false)).result.current).toBe(false);
    expect(loadSessions).not.toHaveBeenCalled();
  });
});
