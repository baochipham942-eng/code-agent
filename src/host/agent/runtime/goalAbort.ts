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
  // paused 不是终态，但本出口只中止仍 pending 的 goal。先挡住，避免把暂停写成 aborted。
  if (!ctx.goalMode?.isPending()) return false;
  // 终态粘性：pending 检查之后若 markAborted 被拒，不得再发 goal_complete。
  if (!ctx.goalMode.markAborted(input.modelText)) return false;
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
