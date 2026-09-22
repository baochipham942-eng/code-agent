import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoomLoopGuard } from '../../../src/host/agent/runtime/doomLoopGuard';
import {
  answerDoomLoopHandback,
  releaseDoomLoopHandbackForSteer,
  settleDoomLoopHandback,
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

  it('无人值守不等人，原因码进执行记录', async () => {
    await expect(settleDoomLoopHandback(
      host({ sessionId: 'cron-1', unattendedTurn: true }),
      new DoomLoopGuard(),
      1,
      vi.fn(),
    )).resolves.toBe('stop');
    expect(takeUnattendedApprovalTimeout('cron-1')).toBe('DOOM_LOOP_HANDBACK_STOP');
  });

  it('交互会话点换方法才续跑，超时则停止', async () => {
    setBrowserWindowInteractionProbe(() => true);
    vi.useFakeTimers();
    const inject = vi.fn();
    const pending = settleDoomLoopHandback(host({ sessionId: 'chat-1', onEvent: vi.fn() }), new DoomLoopGuard(), 1, inject, 60_000);
    expect(answerDoomLoopHandback('chat-1', 'retry')).toBe(true);
    await expect(pending).resolves.toBe('retry');
    expect(inject).toHaveBeenCalledOnce();

    const timed = settleDoomLoopHandback(host({ sessionId: 'chat-2', onEvent: vi.fn() }), new DoomLoopGuard(), 1, vi.fn(), 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(timed).resolves.toBe('stop');
    expect(answerDoomLoopHandback('chat-2', 'stop')).toBe(false);
  });

  it('取消立刻停，上一轮计时器不会清掉新的等待', async () => {
    setBrowserWindowInteractionProbe(() => true);
    const controller = new AbortController();
    const cancelled = settleDoomLoopHandback(
      host({ sessionId: 'chat-3', onEvent: vi.fn(), runAbortController: controller }),
      new DoomLoopGuard(),
      1,
      vi.fn(),
      60_000,
    );
    controller.abort();
    await expect(cancelled).resolves.toBe('stop');
    expect(answerDoomLoopHandback('chat-3', 'retry')).toBe(false);

    vi.useFakeTimers();
    const first = settleDoomLoopHandback(host({ sessionId: 'chat-4', onEvent: vi.fn() }), new DoomLoopGuard(), 1, vi.fn(), 30_000);
    const secondInject = vi.fn();
    const second = settleDoomLoopHandback(host({ sessionId: 'chat-4', onEvent: vi.fn() }), new DoomLoopGuard(), 1, secondInject, 90_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toBe('stop');
    expect(answerDoomLoopHandback('chat-4', 'retry')).toBe(true);
    await expect(second).resolves.toBe('retry');
    expect(secondInject).toHaveBeenCalledOnce();
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
    expect(takeUnattendedApprovalTimeout('cron-ui')).toBe('DOOM_LOOP_HANDBACK_STOP');
  });

  it('改口发新消息会结束等待并继续这一轮，不再注入换方法提示', async () => {
    setBrowserWindowInteractionProbe(() => true);
    const inject = vi.fn();
    const pending = settleDoomLoopHandback(
      host({ sessionId: 'desk-steer', onEvent: vi.fn() }),
      new DoomLoopGuard(),
      3,
      inject,
    );
    expect(releaseDoomLoopHandbackForSteer('desk-steer')).toBe(true);
    await expect(pending).resolves.toBe('retry');
    expect(inject).not.toHaveBeenCalled();
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
