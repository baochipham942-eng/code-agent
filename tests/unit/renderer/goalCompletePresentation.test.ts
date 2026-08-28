import { describe, expect, it } from 'vitest';
import {
  createHostReason,
  HostReasonCode,
} from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import { classifyAgentError } from '../../../src/renderer/hooks/agent/effects/useSessionLifecycleEffects';
import { projectGoalCompletePresentation } from '../../../src/renderer/utils/goalCompletePresentation';

const run = {
  goal: '完成验收',
  startedAt: 1,
  status: 'running' as const,
  turn: 5,
  maxTurns: 5,
  tokensUsed: 0,
  tokenBudget: 100,
  gates: [],
};

describe('goal abort 单一用户信号', () => {
  it('provider 429 只交给错误行，不再产出第二张 goal 中止卡', () => {
    const goal = projectGoalCompletePresentation({
      status: 'aborted',
      reason: createHostReason(
        HostReasonCode.GoalAbortRuntimeFailure,
        '运行失败：Too Many Requests',
      ),
      turns: 1,
      tokensUsed: 0,
    }, run, zh);
    const error = classifyAgentError({
      code: 'RUN_FAILED',
      message: 'Too Many Requests',
      details: { model: 'deepseek-v4-flash' },
      goalAbort: true,
    });

    const userSignals = [goal.notice, error].filter(Boolean);
    expect(userSignals).toHaveLength(1);
    expect(goal.notice).toBeNull();
    expect(error).toMatchObject({ category: 'rate_limited', goalAbort: true });
  });

  it('轮次到限只产出一张人话卡，payload 不带原串、模型、轮数或 token', () => {
    const result = projectGoalCompletePresentation({
      status: 'aborted',
      reason: createHostReason(
        HostReasonCode.GoalAbortTurnLimit,
        '达到轮次上限 5，目标未达成；实际使用 deepseek-v4-flash；Too Many Requests',
      ),
      turns: 5,
      tokensUsed: 0,
    }, run, zh);

    expect(result.notice).toMatchObject({
      kind: 'aborted',
      reason: '目标还没完成，已停止继续执行',
      suggestion: expect.stringContaining('重试'),
    });
    expect(JSON.stringify(result.notice)).not.toMatch(
      /Too Many Requests|deepseek-v4-flash|turns|tokensUsed|5 轮|token/i,
    );
  });
});
