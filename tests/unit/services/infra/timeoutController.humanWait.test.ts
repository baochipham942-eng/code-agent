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

const SESSION_A = 'sess-a';
const SESSION_B = 'sess-b';

function drainHumanWait(): void {
  for (const sessionId of [SESSION_A, SESSION_B]) {
    while (isHumanWaitActive(sessionId)) endHumanWait(sessionId);
  }
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

  it('clamps pause elapsed to 0 when now is earlier than startedAt', () => {
    vi.useFakeTimers();
    const controller = new TimeoutController();
    void controller.createTimeoutPromise(1_000, 'timeout').catch(() => {});
    controller.pause(Date.now() - 500);
    expect(controller.getRemainingMs()).toBe(1_000);
    expect(controller.isPaused()).toBe(true);
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
    const bound = createHumanWaitBoundTimeout(50, 'timeout', SESSION_A);
    const timedOut = vi.fn();
    void bound.promise.catch(timedOut);

    beginHumanWait(SESSION_A);
    await vi.advanceTimersByTimeAsync(500);
    expect(timedOut).not.toHaveBeenCalled();
    expect(bound.controller.isPaused()).toBe(true);
    expect(bound.controller.isTimedOut()).toBe(false);

    endHumanWait(SESSION_A);
    expect(bound.controller.isPaused()).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(timedOut).toHaveBeenCalledOnce();
    bound.unbind();
    bound.controller.clear();
  });

  it('resumes after reject / timeout / cancel / exception so the clock is not stuck paused', async () => {
    vi.useFakeTimers();
    const bound = createHumanWaitBoundTimeout(80, 'timeout', SESSION_A);
    const timedOut = vi.fn();
    void bound.promise.catch(timedOut);

    await expect(withHumanWait(async () => {
      await vi.advanceTimersByTimeAsync(200);
      throw new Error('boom');
    }, SESSION_A)).rejects.toThrow('boom');
    expect(isHumanWaitActive(SESSION_A)).toBe(false);
    expect(bound.controller.isPaused()).toBe(false);
    expect(timedOut).not.toHaveBeenCalled();

    beginHumanWait(SESSION_A);
    endHumanWait(SESSION_A);
    beginHumanWait(SESSION_A);
    endHumanWait(SESSION_A);
    expect(isHumanWaitActive(SESSION_A)).toBe(false);

    await vi.advanceTimersByTimeAsync(80);
    expect(timedOut).toHaveBeenCalledOnce();
    bound.unbind();
    bound.controller.clear();
  });

  it('records approval waitMs from the same Date.now source as the pause interval', async () => {
    vi.useFakeTimers();
    const bound = createHumanWaitBoundTimeout(10_000, 'timeout', SESSION_A);
    const remainingAtStart = bound.controller.getRemainingMs();
    const waitBefore = getHumanWaitMs(SESSION_A);
    const toolCallId = 'wait-ms-same-clock';

    beginApprovalWait(toolCallId, SESSION_A);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(bound.controller.getRemainingMs()).toBe(remainingAtStart);
    endApprovalWait(toolCallId, SESSION_A);

    expect(getApprovalWaitMs(toolCallId, Date.now())).toBe(1_250);
    expect(getHumanWaitMs(SESSION_A) - waitBefore).toBe(1_250);
    expect(bound.controller.getElapsedMs()).toBe(0);

    clearApprovalWait(toolCallId);
    bound.unbind();
    bound.controller.clear();
  });

  it('Goal wall-clock elapsed excludes the paused human-wait interval', async () => {
    vi.useFakeTimers();
    const wall = createHumanWaitBoundTimeout(600_000, 'goal wall-clock budget', SESSION_A);

    await vi.advanceTimersByTimeAsync(5_000);
    beginHumanWait(SESSION_A);
    await vi.advanceTimersByTimeAsync(180_000);
    endHumanWait(SESSION_A);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(wall.controller.getElapsedMs()).toBe(6_000);
    expect(wall.controller.isTimedOut()).toBe(false);

    wall.unbind();
    wall.controller.clear();
  });

  it('pauses only the waiting session; other sessions keep counting and can time out', async () => {
    vi.useFakeTimers();
    const boundA = createHumanWaitBoundTimeout(50, 'timeout-a', SESSION_A);
    const boundB = createHumanWaitBoundTimeout(50, 'timeout-b', SESSION_B);
    const timedA = vi.fn();
    const timedB = vi.fn();
    void boundA.promise.catch(timedA);
    void boundB.promise.catch(timedB);

    beginHumanWait(SESSION_A);
    await vi.advanceTimersByTimeAsync(50);
    expect(timedA).not.toHaveBeenCalled();
    expect(timedB).toHaveBeenCalledOnce();
    expect(boundA.controller.isPaused()).toBe(true);
    expect(boundB.controller.isTimedOut()).toBe(true);

    endHumanWait(SESSION_A);
    await vi.advanceTimersByTimeAsync(50);
    expect(timedA).toHaveBeenCalledOnce();

    boundA.unbind();
    boundA.controller.clear();
    boundB.unbind();
    boundB.controller.clear();
  });

  it('does not inflate remainingMs when a timer is created during an active wait', async () => {
    vi.useFakeTimers();
    beginHumanWait(SESSION_A);
    await vi.advanceTimersByTimeAsync(500);

    const bound = createHumanWaitBoundTimeout(100, 'timeout', SESSION_A);
    const timedOut = vi.fn();
    void bound.promise.catch(timedOut);

    expect(bound.controller.isPaused()).toBe(true);
    expect(bound.controller.getRemainingMs()).toBe(100);
    expect(bound.controller.getElapsedMs()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(timedOut).not.toHaveBeenCalled();
    expect(bound.controller.getRemainingMs()).toBe(100);

    endHumanWait(SESSION_A);
    expect(bound.controller.isPaused()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(timedOut).toHaveBeenCalledOnce();

    bound.unbind();
    bound.controller.clear();
  });

  it('does not pause when beginHumanWait has no session scope', async () => {
    vi.useFakeTimers();
    const bound = createHumanWaitBoundTimeout(50, 'timeout', SESSION_A);
    const timedOut = vi.fn();
    void bound.promise.catch(timedOut);

    beginHumanWait();
    await vi.advanceTimersByTimeAsync(50);
    expect(timedOut).toHaveBeenCalledOnce();

    bound.unbind();
    bound.controller.clear();
  });

  it('does not subscribe when createHumanWaitBoundTimeout has no session scope', async () => {
    vi.useFakeTimers();
    beginHumanWait(SESSION_A);
    const bound = createHumanWaitBoundTimeout(50, 'timeout');
    const timedOut = vi.fn();
    void bound.promise.catch(timedOut);

    await vi.advanceTimersByTimeAsync(50);
    expect(timedOut).toHaveBeenCalledOnce();

    bound.unbind();
    bound.controller.clear();
  });
});
