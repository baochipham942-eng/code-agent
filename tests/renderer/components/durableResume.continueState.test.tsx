// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, StreamRecoverySnapshot } from '../../../src/shared/contract';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { DecisionSlot } from '../../../src/renderer/components/features/chat/DecisionSlot';
import { SendButton } from '../../../src/renderer/components/features/chat/ChatInput/SendButton';
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

describe('parked continue projection in the composer', () => {
  const snapshot: StreamRecoverySnapshot = {
    sessionId: 'session-parked',
    turnId: 'interrupted-turn-1',
    content: '部分回复',
    reasoning: '',
    toolCalls: [{ id: 'write-1', name: 'Write', arguments: '{"file_path":"/workspace/report.md"}' }],
    estimatedTokens: 10,
    timestamp: 1,
    isFinal: false,
    streamStatus: 'incomplete',
    stableForExecution: false,
    incompleteToolCallIds: [],
  };
  const retryMessage: Message = {
    id: 'user-before-interrupt',
    role: 'user',
    content: '写一篇长文',
    timestamp: 0,
  };

  beforeEach(() => {
    useSessionStore.setState({
      currentSessionId: 'session-parked',
      loadSessions: vi.fn(async () => undefined),
    } as never);
    window.localStorage.clear();
  });

  function ParkedComposer({ turnActive }: { turnActive: boolean }) {
    const resume = { mode: 'continue' as const, canContinue: true };
    const showContinue = useDurableContinueVisible(resume, turnActive);
    const legacy = suppressLegacyInterruptionDecision({
      snapshot,
      retryMessage,
      onContinue: async () => true,
    }, resume.mode);
    return (
      <>
        <SendButton
          hasContinuation={showContinue}
          isProcessing={turnActive}
          onContinue={() => undefined}
          onStop={() => undefined}
        />
        <DecisionSlot streamInterruption={legacy} />
      </>
    );
  }

  it('shows the composer continue action and hides the legacy interruption banner when the turn is idle', () => {
    const view = render(<ParkedComposer turnActive={false} />);
    expect(screen.getByTestId('continue-run-button')).toBeTruthy();
    expect(screen.queryByTestId('stream-interruption-decision')).toBeNull();

    view.rerender(<ParkedComposer turnActive={true} />);
    expect(screen.queryByTestId('continue-run-button')).toBeNull();
    expect(screen.queryByTestId('stream-interruption-decision')).toBeNull();
  });
});
