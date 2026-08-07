// ============================================================================
// 全局记忆写入确认失败的用户可见文案 —— 单一来源（A1 收口）。
//
// 纪律：这三条文案只允许在本文件定义；toolExecutor / toolResolver / memoryWrite
// 一律 import 使用，禁止另起硬编码副本——同一条规则散在三处，改文案漏一处
// 就不一致。静态契约测试 tests/unit/memory/directiveMemoryMessage.singleSource.test.ts
// 钉着这条纪律。
//
// 每条文案必须回答用户的三个问题：发生了什么 / 为什么 / 我现在能做什么。
// 这些 error 字符串同时是 tool result，模型也会读到——所以末尾附「给模型」
// 的行动指引：该请用户确认，而不是盲目重试或绕过。
// ============================================================================

import { MEMORY_TIMEOUTS } from '../../shared/constants';
import type { DirectiveMemoryConfirmationResult } from './directiveMemoryConfirmation';

// 超时时长从 MEMORY_TIMEOUTS 推导，文案跟着配置走，不另写死一份会漂移的数字。
const CONFIRM_WINDOW_MINUTES = Math.round(MEMORY_TIMEOUTS.DIRECTIVE_CONFIRM / 60_000);

/** 确认窗口超时（用户可能根本没看到弹窗）。 */
export const DIRECTIVE_MEMORY_CONFIRMATION_TIMEOUT_ERROR =
  `保存到全局记忆需要你确认，但确认窗口等了 ${CONFIRM_WINDOW_MINUTES} 分钟没有等到响应，已自动关闭，这次没有写入。` +
  '全局记忆会影响你之后的所有会话，所以必须你本人点头。' +
  '需要保存的话再跟我说一次，弹窗出现时点「确认」即可。' +
  '（给模型：不要直接重试同一次写入；先提醒用户留意确认弹窗，再重新发起保存。）';

/** 用户在确认窗口里明确点了拒绝。 */
export const DIRECTIVE_MEMORY_CONFIRMATION_DECLINED_ERROR =
  '保存到全局记忆的请求被你在确认窗口里拒绝了，这次没有写入。' +
  '全局记忆会影响你之后的所有会话，所以必须你明确同意才会保存。' +
  '如果刚才是误点，再让我保存一次即可；如果是不想保存，告诉我一声就行。' +
  '（给模型：用户已明确拒绝，不要自动重试同一次写入；先与用户确认意图。）';

/** 没有有效确认记录就试图写入（dispatch / 模块层的 fail-closed 兜底，正常不会触达）。 */
export const DIRECTIVE_MEMORY_WRITE_NO_GRANT_ERROR =
  '写入全局记忆需要你本人确认，而这次调用没有携带有效的确认记录，所以没有写入。' +
  '全局记忆会影响你之后的所有会话，这道确认门不能跳过。' +
  '请回到对话里让我重新发起保存，并在弹出的确认窗口里点「确认」。' +
  '（给模型：不要重试或绕过；走正常确认流程重新发起。）';

/**
 * 按确认结果分流失败文案：超时与用户明确拒绝是两种不同处境，
 * 「没看见弹窗」和「点了拒绝」需要的下一步完全不一样。
 */
export function directiveMemoryConfirmationFailureError(
  result: Pick<DirectiveMemoryConfirmationResult, 'timedOut'>,
): string {
  return result.timedOut
    ? DIRECTIVE_MEMORY_CONFIRMATION_TIMEOUT_ERROR
    : DIRECTIVE_MEMORY_CONFIRMATION_DECLINED_ERROR;
}
