import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerDoomLoopHandback,
  DOOM_LOOP_HANDBACK_STOP,
  stopUnattendedDoomLoop,
  waitForDoomLoopHandback,
} from '../../../src/host/agent/runtime/doomLoopHandback';
import { takeUnattendedApprovalTimeout } from '../../../src/host/agent/unattendedApprovalTerminal';

describe('doom loop handback', () => {
  afterEach(() => {
    vi.useRealTimers();
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
});
