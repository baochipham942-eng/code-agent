// ============================================================================
// 一轮消息的「系统脚手架 ↔ 用户原话」封装（2026-07-28；2026-07-29 挪到 shared）
//
// `wrapWithTurnSystemContext` 会把 turnSystemContext 拼在用户内容前面，用
// <user_request> 包住真正的请求。这份包装**只给模型看**，用户界面显示的是原话。
// 定义放在 shared：host 负责拼，renderer 负责拆（历史脏数据/未知泄漏路径里脚手架
// 整块落到展示层时，展示侧用 extractUserRequest 还原，见 UX round2 20f）。
// ============================================================================

const USER_REQUEST_OPEN = '<user_request>';
const USER_REQUEST_CLOSE = '</user_request>';

/**
 * 定位包装体真正的开始标签：必须独占一行的行首（整条消息的开头，或紧跟换行符）。
 * wrapWithTurnSystemContext 写出的开始标签永远在行首（`\n\n<user_request>\n`）；
 * 而 prose 行中提到的同名标签不算——真机实录（realrun35 / FB-596）：候选能力块的
 * 措辞里有「…下面 <user_request> 里的用户原话。」，indexOf 的首个命中落在块内
 * 行中间，preannounce 把「 里的用户原话。）统计内容：…」当成了用户任务去转述。
 */
function findLineStartOpenTag(text: string): number {
  let from = 0;
  for (;;) {
    const at = text.indexOf(USER_REQUEST_OPEN, from);
    if (at === -1) return -1;
    if (at === 0 || text[at - 1] === '\n') return at;
    from = at + 1;
  }
}

/** 把系统上下文拼在前面，用户原话用 <user_request> 包住。空上下文原样返回。 */
export function wrapWithTurnSystemContext(blocks: string[], content: string): string {
  if (blocks.length === 0) return content;
  return `${blocks.join('\n\n')}\n\n${USER_REQUEST_OPEN}\n${content}\n${USER_REQUEST_CLOSE}`;
}

/**
 * 给已经可能带 turnSystemContext 的模型面请求追加上下文块。
 * 已包装时复用同一层 user_request，避免共同运行层再次包装形成嵌套脚手架。
 */
export function mergeTurnSystemContext(blocks: string[], content: string): string {
  const additions = blocks.filter((block) => block.trim().length > 0);
  if (additions.length === 0) return content;

  const trimmed = content.trimEnd();
  const requestOpen = findLineStartOpenTag(trimmed);
  if (requestOpen !== -1 && trimmed.endsWith(USER_REQUEST_CLOSE)) {
    const prefix = trimmed.slice(0, requestOpen).trimEnd();
    const request = trimmed.slice(requestOpen);
    return [prefix, ...additions, request].filter(Boolean).join('\n\n');
  }
  return wrapWithTurnSystemContext(additions, content);
}

/**
 * 取回用户原话。没有包装（绝大多数轮）时原样返回——判据是「有没有这层包装」，
 * 不是「有没有系统上下文」，所以对没走 turnSystemContext 的路径零影响。
 *
 * 判据钉在「整条消息**以结束标签收尾**」：包装总是把结束标签放在最末一个字符上。
 * 用户原话里出现同名标签是可能的（他在问这个标签怎么用），按「首个行首开始标签 + 末尾结束标签」
 * 取中间那段，才不会把他的话截断——这条被测试钉住。
 */
export function extractUserRequest(message: string): string {
  const trimmed = message.trimEnd();
  if (!trimmed.endsWith(USER_REQUEST_CLOSE)) return message;
  const open = findLineStartOpenTag(trimmed);
  if (open === -1) return message;
  return trimmed.slice(open + USER_REQUEST_OPEN.length, trimmed.length - USER_REQUEST_CLOSE.length).trim();
}

/**
 * 展示层剥离 <system-reminder kind="...">...</system-reminder> 块（注入卫生工单，2026-08-01）。
 * design-acceptance-contract-json / design-code-handoff-json 等几种 reminder 目前仍走 renderer
 * 侧 prepend 进发出的 content（该注入语义本次不动），这些块因此会和用户原话一起落库/发出——
 * 用户气泡渲染时只应看到自己的话，不该看到给模型的隐藏意图。只影响展示，不改存储/发送内容。
 */
export function stripSystemReminderBlocks(content: string): string {
  return content
    .replace(/\s*<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
