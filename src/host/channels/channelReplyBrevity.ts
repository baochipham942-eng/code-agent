// ============================================================================
// Channel Reply Brevity（N-CHANNEL-REPLY-BREVITY）
// ----------------------------------------------------------------------------
// IM 回复纪律：① channel 来源的 run 注入回复风格指令——由 orchestrator 在
// executeMessage 里按 messageMetadata.channel 并进 turnSystemContext，只进模型面
// 请求（<user_request> 包裹 + modelFacingUserMessage 投影），落库/展示的用户
// 消息仍是原话；桌面 run 无 metadata.channel，不注入。
// ② 出站软上限：超限不硬截断，按首个段落边界截取并附"全文在 Neo 会话里"提示，
// 全文已由会话记录持久化。Telegram splitMessage 只在软限后仍超平台上限时兜底。
// ③ 开跑回执：收到请求后经同一 send 路径回一句「收到，开始处理：…」。
// ============================================================================

import type { InboundAccessLocale } from './inboundAccessI18n';
import { channelCommandText } from './channelCommandI18n';
import { CHANNEL_REPLY_CHAR_LIMIT_DEFAULT } from '../../shared/constants';

export const CHANNEL_REPLY_STYLE_INSTRUCTION = [
  '[IM 回复纪律]',
  '- 单条 IM 回复不超过 150 个汉字：先给结论，再用一行写依据。',
  '- 内容较长时：第一段只写摘要（结论＋一行依据，不超过 150 个汉字），完整内容写在同一条回复的后续段落；只有第一段会发到 IM，其余留在 Neo 会话里。不要为此写文件或创建交付物；第一段里不要提工具失败或权限。用户明确要求文件/文档时除外。',
  '- 不要在 IM 里输出进度播报；只在有结果、需要用户决定、或无法完成时说话。',
].join('\n');

const CHANNEL_REPLY_FULL_TEXT_NOTE = '（完整内容见 Neo 会话）';

/** 回执里携带的请求开头长度（字符） */
const ACK_REQUEST_HEAD_CHARS = 30;

export function resolveChannelReplyLimit(configured: unknown): number {
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : CHANNEL_REPLY_CHAR_LIMIT_DEFAULT;
}

/** 单行 Markdown 标题段：trimmed 后只有一行且以 1–6 个 # 加空白起头 */
function isHeadingOnlyParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  return !trimmed.includes('\n') && /^#{1,6}\s/.test(trimmed);
}

/**
 * 回复不超限原样返回；超限则按段落累积不超限的前几段，首段本身超限时在该段内
 * 取最近的句末标点（找不到才按上限切），最后附固定提示。正文被截断时，甩在截
 * 断点前的尾部标题段（下面已没有内容）一并丢弃，避免群里出现孤标题。
 */
export function softLimitChannelReply(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const paragraphs = text.split(/\n\s*\n/);
  const kept: string[] = [];
  let keptLength = 0;
  for (const paragraph of paragraphs) {
    const nextLength = keptLength ? keptLength + 2 + paragraph.length : paragraph.length;
    if (nextLength > limit) break;
    kept.push(paragraph);
    keptLength = nextLength;
  }
  if (kept.length < paragraphs.length) {
    while (kept.length > 0 && isHeadingOnlyParagraph(kept[kept.length - 1])) kept.pop();
  }
  if (kept.length === 0) {
    const head = paragraphs[0].slice(0, limit);
    const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('. '), head.lastIndexOf('！'), head.lastIndexOf('？'));
    return `${cut > 0 ? head.slice(0, cut + 1) : head}\n\n${CHANNEL_REPLY_FULL_TEXT_NOTE}`;
  }
  return `${kept.join('\n\n')}\n\n${CHANNEL_REPLY_FULL_TEXT_NOTE}`;
}

/** 开跑回执：「收到，开始处理：<请求前 30 字>」。空请求返回空串（调用方跳过回执）。 */
export function buildChannelAckText(locale: InboundAccessLocale | undefined, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  const head = trimmed.slice(0, ACK_REQUEST_HEAD_CHARS);
  const ellipsized = head + (trimmed.length > head.length ? '…' : '');
  return channelCommandText(locale, 'ackStart').replace('{request}', ellipsized);
}
