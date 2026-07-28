// ============================================================================
// 一轮消息的「系统脚手架 ↔ 用户原话」封装（2026-07-28）
//
// `applyTurnSystemContext` 会把 turnSystemContext 拼在用户内容前面，用
// <user_request> 包住真正的请求。这份包装**只给模型看**，用户界面显示的是原话。
//
// 但它还有第二类消费者：轮首那批「用户想干什么」的分类器（skill 别名匹配、
// 任务复杂度、任务特征）。它们此前拿的是**拼好之后**的整段文本，于是系统上下文里
// 出现的任何词都会被当成用户的诉求——2026-07-28 真机实证：语音派活带上通话近窗字幕后，
// 块里反复出现的「语音」二字命中 skill 别名，连续 4 次把派活 run 劫持进
// research-brief-and-split 技能，块本身 600+ 字还把复杂度顶成 complex。
// 角色资料块、通话钳档告知同理，只是没被抓现行。
//
// 所以标签定义与拆包收在这一个文件里：谁拼的谁负责拆，别让两处各写一遍正则。
// ============================================================================

const USER_REQUEST_OPEN = '<user_request>';
const USER_REQUEST_CLOSE = '</user_request>';

/** 把系统上下文拼在前面，用户原话用 <user_request> 包住。空上下文原样返回。 */
export function wrapWithTurnSystemContext(blocks: string[], content: string): string {
  if (blocks.length === 0) return content;
  return `${blocks.join('\n\n')}\n\n${USER_REQUEST_OPEN}\n${content}\n${USER_REQUEST_CLOSE}`;
}

/**
 * 取回用户原话。没有包装（绝大多数轮）时原样返回——判据是「有没有这层包装」，
 * 不是「有没有系统上下文」，所以对没走 turnSystemContext 的路径零影响。
 *
 * 判据钉在「整条消息**以结束标签收尾**」：包装总是把结束标签放在最末一个字符上。
 * 用户原话里出现同名标签是可能的（他在问这个标签怎么用），按「首个开始标签 + 末尾结束标签」
 * 取中间那段，才不会把他的话截断——这条被测试钉住。
 */
export function extractUserRequest(message: string): string {
  const trimmed = message.trimEnd();
  if (!trimmed.endsWith(USER_REQUEST_CLOSE)) return message;
  const open = trimmed.indexOf(USER_REQUEST_OPEN);
  if (open === -1) return message;
  return trimmed.slice(open + USER_REQUEST_OPEN.length, trimmed.length - USER_REQUEST_CLOSE.length).trim();
}
