import { describe, expect, it, vi } from 'vitest';
import { GoalModeController, buildGoalContract } from '../../../../../src/host/agent/goalModeController';
import { emitGoalAbort } from '../../../../../src/host/agent/runtime/goalAbort';
import { HostReasonCode } from '../../../../../src/shared/contract';

describe('emitGoalAbort', () => {
  it('同一终态只发一个带稳定 code 的 goal_complete，并把原始原因留在 modelText', () => {
    const onEvent = vi.fn();
    const goalMode = new GoalModeController(buildGoalContract({
      goal: '完成任务',
      verifyCommand: 'true',
      tokenBudget: 100,
      maxTurns: 5,
    }));
    const ctx = { goalMode, onEvent } as never;

    expect(emitGoalAbort(ctx, {
      code: HostReasonCode.GoalAbortTurnLimit,
      modelText: '达到轮次上限 5，目标未达成',
      turns: 5,
      tokensUsed: 0,
    })).toBe(true);
    expect(emitGoalAbort(ctx, {
      code: HostReasonCode.GoalAbortTurnLimit,
      modelText: '重复终态',
      turns: 5,
      tokensUsed: 0,
    })).toBe(false);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      type: 'goal_complete',
      data: {
        status: 'aborted',
        reason: {
          code: HostReasonCode.GoalAbortTurnLimit,
          modelText: '达到轮次上限 5，目标未达成',
        },
        turns: 5,
        tokensUsed: 0,
      },
    });
    expect(goalMode.getAbortReason()).toBe('达到轮次上限 5，目标未达成');
  });

  it('已 met 后再中止被拒：不发 goal_complete，不改首个终态', () => {
    const onEvent = vi.fn();
    const goalMode = new GoalModeController(buildGoalContract({
      goal: '完成任务',
      verifyCommand: 'true',
      tokenBudget: 100,
      maxTurns: 5,
    }));
    goalMode.markMet();
    const ctx = { goalMode, onEvent } as never;

    expect(emitGoalAbort(ctx, {
      code: HostReasonCode.GoalAbortTurnLimit,
      modelText: '后到的中止',
      turns: 5,
      tokensUsed: 0,
    })).toBe(false);

    expect(onEvent).not.toHaveBeenCalled();
    expect(goalMode.getStatus()).toBe('met');
    expect(goalMode.getAbortReason()).toBeUndefined();
  });

  it('markAborted 返回 false 时不发第二个 goal_complete', () => {
    const onEvent = vi.fn();
    const markAborted = vi.fn().mockReturnValue(false);
    const ctx = {
      goalMode: { isPending: () => true, markAborted },
      onEvent,
    } as never;

    expect(emitGoalAbort(ctx, {
      code: HostReasonCode.GoalAbortTurnLimit,
      modelText: '被拒的中止',
      turns: 2,
      tokensUsed: 1,
    })).toBe(false);

    expect(markAborted).toHaveBeenCalledWith('被拒的中止');
    expect(onEvent).not.toHaveBeenCalled();
  });
});
