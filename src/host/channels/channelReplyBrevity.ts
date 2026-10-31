// ============================================================================
// Channel Reply Brevity（N-CHANNEL-REPLY-BREVITY）
// ----------------------------------------------------------------------------
// IM 回复纪律：① 给 channel 来源的 run 注入回复风格指令（桌面 run 不经过本模块）；
// ② 出站软上限：超限不硬截断，按首个段落边界截取并附"全文在 Neo 会话里"提示，
// 全文已由会话记录持久化。Telegram splitMessage 只在软限后仍超平台上限时兜底。
// ============================================================================

import { CHANNEL_REPLY_CHAR_LIMIT_DEFAULT } from '../../shared/constants';

export const CHANNEL_REPLY_STYLE_INSTRUCTION = [
  '[IM 回复纪律]',
  '- 单条 IM 回复不超过 150 个汉字：先给结论，再用一行写依据。',
  '- 内容较长时只发摘要，完整内容写进会话（文件/交付物）并告诉用户在哪里。',
  '- 不要在 IM 里输出进度播报；只在有结果、需要用户决定、或无法完成时说话。',
].join('\n');

export const CHANNEL_REPLY_FULL_TEXT_NOTE = '（完整内容见 Neo 会话）';

export function buildChannelRunContent(content: string): string {
  return `${content}\n\n${CHANNEL_REPLY_STYLE_INSTRUCTION}`;
}

export function resolveChannelReplyLimit(configured: unknown): number {
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : CHANNEL_REPLY_CHAR_LIMIT_DEFAULT;
}

/**
 * 回复不超限原样返回；超限则按段落累积不超限的前几段，首段本身超限时在该段内
 * 取最近的句末标点（找不到才按上限切），最后附固定提示。
 */
export function softLimitChannelReply(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const paragraphs = text.split(/\n\s*\n/);
  let kept = '';
  for (const paragraph of paragraphs) {
    const next = kept ? `${kept}\n\n${paragraph}` : paragraph;
    if (next.length > limit) break;
    kept = next;
  }
  if (!kept) {
    const head = paragraphs[0].slice(0, limit);
    const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('. '), head.lastIndexOf('！'), head.lastIndexOf('？'));
    kept = cut > 0 ? head.slice(0, cut + 1) : head;
  }
  return `${kept}\n\n${CHANNEL_REPLY_FULL_TEXT_NOTE}`;
}
