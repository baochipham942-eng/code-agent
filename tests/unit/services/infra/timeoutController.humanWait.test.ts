import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TimeoutController,
  beginHumanWait,
  createHumanWaitBoundTimeout,
  endHumanWait,
  getHumanWaitMs,
  isHumanWaitActive,
  withHumanWait,
} from '../../../../src/host/services/infra/timeoutController';
import {
  beginApprovalWait,
  clearApprovalWait,
  endApprovalWait,
  getApprovalWaitMs,
} from '../../../../src/host/tools/toolExecutionTelemetry';

function drainHumanWait(): void {
  while (isHumanWaitActive()) endHumanWait();
}

describe('TimeoutController pause/resume remaining', () => {
  afterEach(() => {
    vi.useRealTimers();
    drainHumanWait();
  });

  it('subtracts each running segment from remainingMs across pause/resume cycles', async () => {
    vi.useFakeTimers();
    const controller = new TimeoutController();
    const rejected = vi.fn();
    void controller.createTimeoutPromise(1_000, 'timeout').catch(rejected);

    await vi.advanceTimersByTimeAsync(300);
    controller.pause();
    expect(controller.isPaused()).toBe(true);
    expect(controller.getRemainingMs()).toBe(700);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(rejected).not.toHaveBeenCalled();
    expect(controller.getRemainingMs()).toBe(700);
    expect(controller.getElapsedMs()).toBe(300);

    controller.resume();
    await vi.advanceTimersByTimeAsync(200);
    controller.pause();
    expect(controller.getRemainingMs()).toBe(500);
    expect(controller.getElapsedMs()).toBe(500);

    controller.resume();
    await vi.advanceTimersByTimeAsync(500);
    expect(rejected).toHaveBeenCalledOnce();
    expect(controller.isTimedOut()).toBe(true);
    controller.clear();
  });
});

describe('human wait bound timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    drainHumanWait();
  });

  it('does not fire while a human wait is active even after the timeout threshold', async () => {
    vi.useFakeTimers();
    const bound = createHumanWaitBoundTimeout(50, 'timeout');
    const timedOut = vi.fn();
    void bound.promise.catch(timedOut);

    beginHumanWait();
    await vi.advanceTimersByTimeAsync(500);
    expect(timedOut).not.toHaveBeenCalled();
    expect(bound.controller.isPaused()).toBe(true);
    expect(bound.controller.isTimedOut()).toBe(false);

    endHumanWait();
    expect(bound.controller.isPaused()).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(timedOut).toHaveBeenCalledOnce();
    bound.unbind();
    bound.controller.clear();
  });

  it('resumes after reject / timeout / cancel / exception so the clock is not stuck paused', async () => {
    vi.useFakeTimers();
    const bound = createHumanWaitBoundTimeout(80, 'timeout');
    const timedOut = vi.fn();
    void bound.promise.catch(timedOut);

    await expect(withHumanWait(async () => {
      await vi.advanceTimersByTimeAsync(200);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(isHumanWaitActive()).toBe(false);
    expect(bound.controller.isPaused()).toBe(false);
    expect(timedOut).not.toHaveBeenCalled();

    beginHumanWait();
    endHumanWait();
    beginHumanWait();
    endHumanWait();
    expect(isHumanWaitActive()).toBe(false);

    await vi.advanceTimersByTimeAsync(80);
    expect(timedOut).toHaveBeenCalledOnce();
    bound.unbind();
    bound.controller.clear();
  });

  it('records approval waitMs from the same Date.now source as the pause interval', async () => {
    vi.useFakeTimers();
    const bound = createHumanWaitBoundTimeout(10_000, 'timeout');
    const remainingAtStart = bound.controller.getRemainingMs();
    const waitBefore = getHumanWaitMs();
    const toolCallId = 'wait-ms-same-clock';

    beginApprovalWait(toolCallId);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(bound.controller.getRemainingMs()).toBe(remainingAtStart);
    endApprovalWait(toolCallId);

    expect(getApprovalWaitMs(toolCallId, Date.now())).toBe(1_250);
    expect(getHumanWaitMs() - waitBefore).toBe(1_250);
    expect(bound.controller.getElapsedMs()).toBe(0);

    clearApprovalWait(toolCallId);
    bound.unbind();
    bound.controller.clear();
  });

  it('Goal wall-clock elapsed excludes the paused human-wait interval', async () => {
    vi.useFakeTimers();
    const wall = createHumanWaitBoundTimeout(600_000, 'goal wall-clock budget');

    await vi.advanceTimersByTimeAsync(5_000);
    beginHumanWait();
    await vi.advanceTimersByTimeAsync(180_000);
    endHumanWait();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(wall.controller.getElapsedMs()).toBe(6_000);
    expect(wall.controller.isTimedOut()).toBe(false);

    wall.unbind();
    wall.controller.clear();
  });
});
