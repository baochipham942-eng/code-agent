// ============================================================================
// pendingCommand - 特色能力命令 chip（2026-07-29 UX round2 任务 17）
// ============================================================================
//
// /goal /schedule /loop /workflow 这类「需要参数的特色命令」从 slash 面板选中后
// 不再把「/goal 」纯文本前缀留在输入框，而是挂一颗命令 chip（composerStore.pendingCommand），
// 用户随后输入的文字就是参数；发送时这里把 `/${id} ` 前缀拼回去走原解析链路，
// 行为与手打「/goal xxx」完全一致。

export interface PendingCommandSelection {
  /** 命令 id（goal / schedule / loop / workflow），提交时拼回 `/${id} ` 前缀 */
  id: string;
  /** 面板上的中文名（如「设定目标」），chip 上展示 */
  name: string;
}

/**
 * 把 pendingCommand 前缀拼回输入文本。用户自己又把命令打了一遍
 * （chip 还在但文本已以 /goal 开头）时不重复加前缀，与手打路径保持逐字一致。
 */
export function applyPendingCommandPrefix(value: string, command: PendingCommandSelection): string {
  const trimmed = value.trim();
  if (new RegExp(`^/${command.id}\\b`, 'i').test(trimmed)) return trimmed;
  return trimmed ? `/${command.id} ${trimmed}` : `/${command.id}`;
}
