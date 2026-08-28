import {
  createHostReason,
  type HostReasonCode,
} from '../../../shared/contract';
import type { RuntimeContext } from './runtimeContext';

interface GoalAbortInput {
  code: HostReasonCode;
  modelText: string;
  turns: number;
  tokensUsed: number;
}

/**
 * goal 中止的唯一事件出口：状态机保留完整原因为日志/模型上下文，renderer 只按
 * 稳定 code 查登记文案。数值与 provider 原串不进入面向用户的 metadata。
 */
export function emitGoalAbort(ctx: RuntimeContext, input: GoalAbortInput): boolean {
  if (!ctx.goalMode?.isPending()) return false;

  ctx.goalMode.markAborted(input.modelText);
  ctx.onEvent({
    type: 'goal_complete',
    data: {
      status: 'aborted',
      reason: createHostReason(input.code, input.modelText),
      turns: input.turns,
      tokensUsed: input.tokensUsed,
    },
  });
  return true;
}
