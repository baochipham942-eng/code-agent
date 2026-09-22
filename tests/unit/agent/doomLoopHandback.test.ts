import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoomLoopGuard } from '../../../src/host/agent/runtime/doomLoopGuard';
import {
  answerDoomLoopHandback,
  DOOM_LOOP_HANDBACK_STOP,
  settleDoomLoopHandback,
  stopUnattendedDoomLoop,
  waitForDoomLoopHandback,
} from '../../../src/host/agent/runtime/doomLoopHandback';
import { takeUnattendedApprovalTimeout } from '../../../src/host/agent/unattendedApprovalTerminal';
import { setBrowserWindowInteractionProbe } from '../../../src/host/platform/windowBridge';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

function host(partial: {
  sessionId: string;
  unattendedTurn?: boolean;
  onEvent?: RuntimeContext['onEvent'];
  runAbortController?: AbortController | null;
}): RuntimeContext {
  return {
    sessionId: partial.sessionId,
    unattendedTurn: partial.unattendedTurn,
    onEvent: partial.onEvent ?? vi.fn(),
    control: { runAbortController: partial.runAbortController ?? null },
  } as never;
}

describe('doom loop handback', () => {
  afterEach(() => {
    vi.useRealTimers();
    setBrowserWindowInteractionProbe(null);
  });

  it('无人值守不等人，原因码进执行记录', () => {
    stopUnattendedDoomLoop('cron-1');
    expect(takeUnattendedApprovalTimeout('cron-1')).toBe(DOOM_LOOP_HANDBACK_STOP);
  });

  it('交互会话点换方法才续跑，超时则停止', async () => {
    vi.useFakeTimers();
    const pending = waitForDoomLoopHandback('chat-1', 60_000);
    expect(answerDoomLoopHandback('chat-1', 'retry')).toBe(true);
    await expect(pending).resolves.toBe('retry');

    const timed = waitForDoomLoopHandback('chat-2', 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(timed).resolves.toBe('timeout');
    expect(answerDoomLoopHandback('chat-2', 'stop')).toBe(false);
  });

  it('取消立刻停，上一轮计时器不会清掉新的等待', async () => {
    const controller = new AbortController();
    const cancelled = waitForDoomLoopHandback('chat-3', 60_000, controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toBe('stop');
    expect(answerDoomLoopHandback('chat-3', 'retry')).toBe(false);

    vi.useFakeTimers();
    const first = waitForDoomLoopHandback('chat-4', 30_000);
    const second = waitForDoomLoopHandback('chat-4', 90_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toBe('timeout');
    expect(answerDoomLoopHandback('chat-4', 'retry')).toBe(true);
    await expect(second).resolves.toBe('retry');
  });

  it('没有界面或无人值守时立刻停，不发卡片', async () => {
    setBrowserWindowInteractionProbe(() => false);
    const quiet = vi.fn();
    await expect(settleDoomLoopHandback(host({ sessionId: 'eval-1', onEvent: quiet }), new DoomLoopGuard(), 4, vi.fn()))
      .resolves.toBe('stop');
    expect(quiet).not.toHaveBeenCalled();

    setBrowserWindowInteractionProbe(() => true);
    const cron = vi.fn();
    await expect(settleDoomLoopHandback(
      host({ sessionId: 'cron-ui', unattendedTurn: true, onEvent: cron }),
      new DoomLoopGuard(),
      2,
      vi.fn(),
    )).resolves.toBe('stop');
    expect(cron).not.toHaveBeenCalled();
    expect(takeUnattendedApprovalTimeout('cron-ui')).toBe(DOOM_LOOP_HANDBACK_STOP);
  });

  it('有界面才发卡片，运行被取消时不等待', async () => {
    setBrowserWindowInteractionProbe(() => true);
    const onEvent = vi.fn();
    const controller = new AbortController();
    const pending = settleDoomLoopHandback(
      host({ sessionId: 'desk-1', onEvent, runAbortController: controller }),
      new DoomLoopGuard(),
      3,
      vi.fn(),
    );
    expect(onEvent).toHaveBeenCalledWith({ type: 'doom_loop_handback', data: { sessionId: 'desk-1' } });
    controller.abort();
    await expect(pending).resolves.toBe('stop');
  });
});
