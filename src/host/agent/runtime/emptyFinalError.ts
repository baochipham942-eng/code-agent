// 本轮以零可见正文收尾（模型连续空输出已用尽 L3 续接，或工具后没有总结）时的失败说明。
// 经 runFinalizer 的 RUN_FAILED 事件进入既有 agentError 卡（带重试）；这里只决定人话文案并留痕原因。
import type { Message } from '../../../shared/contract';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('EmptyFinalError');

/**
 * 「这轮有没有看得见的最终回复」判定：最后一条 user 之后存在正文非空的 assistant。
 * （N-CHAT-EMPTY-FINAL-NO-EXIT：完成必须有非空最终回复，不许用排除法兜底）。
 * 运行中转向（injectSteerMessage）会把 role:'user' 推进同一轮 history，最终回复在转向之后。
 */
export function hasVisibleAssistantTextAfterLastUser(messages: Message[]): boolean {
  let seenLastUser = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') {
      seenLastUser = true;
      break;
    }

    if (message.role !== 'assistant') continue;
    if (typeof message.content === 'string' && message.content.trim().length > 0) return true;
  }

  return !seenLastUser;
}

export function buildEmptyFinalError(messages: Message[]): Error {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUser = i; break; }
  }
  const ranTools = messages.slice(lastUser + 1).some((m) => (m.toolCalls?.length ?? 0) > 0);
  logger.warn('[EmptyFinal] Run ended without visible assistant text', {
    reason: ranTools ? 'no_summary_after_tools' : 'model_empty_output',
  });
  return new Error(ranTools
    ? '任务已结束，执行记录和产物已保留。这一轮没有生成最终说明，请直接查看上面的工具结果。'
    : '模型这次没有返回任何内容，已自动重试仍为空。请点重试再发一次，或换个模型。');
}
