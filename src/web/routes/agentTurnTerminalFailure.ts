// ============================================================================
// agentTurnTerminalFailure — /api/run 一轮的终态失败记录构造
//
// N-CHAT-EMPTY-FINAL-NO-EXIT：失败终态必须落库（会话重开后仍显示人话原因 +
// 重试/换模型出路），否则失败只活在内存事件里，刷新后「无回复也无失败提示」。
// 分类用 @shared/utils/agentErrorClassification——与 renderer 的 AgentErrorCard
// 同一份判据，刷新前后不漂移。
// ============================================================================

import type { AgentErrorMetadata } from '../../shared/contract';
import { classifyAgentError } from '../../shared/utils/agentErrorClassification';

export interface TurnTerminalFailureInput {
  /** 引擎终态 error 事件的完整载荷（runController.lastTerminalErrorData）。 */
  errorData: Record<string, unknown> | null;
  /** 引擎没发过 error 事件时的兜底（catch 里抛出的原始错误 message）。 */
  fallbackMessage: string | null;
  /** 这一轮真跑的模型 id（分类回填 modelId 用）。 */
  modelId: string | undefined;
  runCancelled: boolean;
}

export function buildTurnTerminalFailure(
  input: TurnTerminalFailureInput,
): { agentError: AgentErrorMetadata } | null {
  if (input.runCancelled) return null;
  const source = input.errorData
    ?? (input.fallbackMessage ? { message: input.fallbackMessage } : null);
  if (!source) return null;
  const agentError = classifyAgentError(source, { modelId: input.modelId });
  return agentError ? { agentError } : null;
}
