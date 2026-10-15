const LEADING_MENTION = /^(?:@_user_\d+|@[^\s@]+|<at\b[^>]*>[\s\S]*?<\/at>|<at\b[^>]*\/?>)\s+/iu;
const COMMAND_PATTERN = /^\/(stop|new|status)(?:@[^\s@]+)?$/iu;
// 不知道命令的用户发一句「停」也要停得下来（爸 10-14 定 A）：整条消息恰好是固定短句才算，
// 不做前缀/包含匹配——「帮我查下停车场」这类正常句子绝不误判。带 natural 标记：调用方只在
// 任务运行中才按停止处理，空闲时照常交给模型（「取消」可能是在回答 agent 的提问）。
const NATURAL_STOP_PHRASES = new Set(['停', '停止', '停下', '别做了', '不要做了', '取消', 'stop', 'abort', 'cancel']);
const EDGE_PUNCTUATION = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;

export type ChannelCommandName = 'stop' | 'new' | 'status';

/**
 * Slash commands: first token only. Extra words are ignored. `/stopwatch` and `/statuses` are not commands.
 * Group mention checks happen before a message reaches the bridge; this only strips the tokens.
 */
export function parseChannelCommand(
  text: string,
  options: { chatType: 'p2p' | 'group' | 'channel' },
): { command: ChannelCommandName; natural?: true } | null {
  if (options.chatType !== 'p2p' && options.chatType !== 'group' && options.chatType !== 'channel') {
    return null;
  }
  const body = stripLeadingMentions(text.normalize('NFKC').trim());
  const token = body.split(/\s+/u)[0] ?? '';
  const name = COMMAND_PATTERN.exec(token)?.[1]?.toLowerCase();
  if (name === 'stop' || name === 'new' || name === 'status') return { command: name };
  if (NATURAL_STOP_PHRASES.has(body.replace(EDGE_PUNCTUATION, '').toLowerCase())) return { command: 'stop', natural: true };
  return null;
}

function stripLeadingMentions(text: string): string {
  let rest = text;
  for (let i = 0; i < 16; i += 1) {
    const next = rest.replace(LEADING_MENTION, '').trim();
    if (next === rest) return rest;
    rest = next;
  }
  return rest;
}
