const LEADING_MENTION = /^(?:@_user_\d+|@[^\s@]+|<at\b[^>]*>[\s\S]*?<\/at>|<at\b[^>]*\/?>)\s+/iu;
const COMMAND_PATTERN = /^\/(stop|new|status)(?:@[^\s@]+)?$/iu;

export type ChannelCommandName = 'stop' | 'new' | 'status';

/**
 * First token only. Extra words are ignored. `/stopwatch` and `/statuses` are not commands.
 * Group mention checks happen before a message reaches the bridge; this only strips the tokens.
 */
export function parseChannelCommand(
  text: string,
  options: { chatType: 'p2p' | 'group' | 'channel' },
): { command: ChannelCommandName } | null {
  if (options.chatType !== 'p2p' && options.chatType !== 'group' && options.chatType !== 'channel') {
    return null;
  }
  const token = stripLeadingMentions(text.normalize('NFKC').trim()).split(/\s+/u)[0] ?? '';
  const name = COMMAND_PATTERN.exec(token)?.[1]?.toLowerCase();
  if (name === 'stop' || name === 'new' || name === 'status') return { command: name };
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
