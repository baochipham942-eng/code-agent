// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import {
  suppressLegacyInterruptionDecision,
  useDurableContinueVisible,
  useGuardedDurableContinue,
} from '../../../src/renderer/components/features/chat/durableResume';

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

  it.each(['continue', 'auto-resuming', 'queued'] as const)('suppresses the legacy interruption action for durable %s', (mode) => {
    const decision = { retryMessage: { id: 'source' } };
    expect(suppressLegacyInterruptionDecision(decision, mode)).toBeNull();
  });

  it('keeps the legacy interruption action when there is no durable resume projection', () => {
    const decision = { retryMessage: { id: 'source' } };
    expect(suppressLegacyInterruptionDecision(decision, undefined)).toBe(decision);
  });
});

// N-RESUME-PARKED-RECLAIM ②：guard_halt（外部写入结果未知）点「继续」先弹模态二次确认，
// 取消不续跑，确认才调 continue；其它停靠原因直接续跑、不弹框。
describe('useGuardedDurableContinue', () => {
  function Harness({ cause, onContinue }: { cause: string | undefined; onContinue: () => Promise<void> }) {
    const guarded = useGuardedDurableContinue(cause, onContinue);
    return (
      <>
        <button type="button" data-testid="composer-continue" onClick={guarded.onContinue}>continue</button>
        {guarded.confirmDialog}
      </>
    );
  }

  it('guard_halt opens a modal first; cancel never continues, confirm continues exactly once', () => {
    const onContinue = vi.fn(async () => undefined);
    render(<Harness cause="guard_halt" onContinue={onContinue} />);

    fireEvent.click(screen.getByTestId('composer-continue'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/可能已经执行|may have already run/);
    expect(onContinue).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /取消|Cancel/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onContinue).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('composer-continue'));
    const confirm = screen.getAllByRole('button', { name: /^(继续|Continue)$/ }).find((button) => screen.getByRole('dialog').contains(button));
    fireEvent.click(confirm!);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['user_stop', 'crash_or_quit'])('%s continues directly without a modal', (cause) => {
    const onContinue = vi.fn(async () => undefined);
    render(<Harness cause={cause} onContinue={onContinue} />);
    fireEvent.click(screen.getByTestId('composer-continue'));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
