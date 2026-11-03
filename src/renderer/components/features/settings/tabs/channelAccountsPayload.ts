import type { ChannelAccount } from '@shared/contract/channel';

/**
 * Normalize the `channel:accounts-changed` listener args to ChannelAccount[].
 * Native bridge passes one array; HTTP/SSE transport spreads it, so the
 * listener sees N account objects (or a lone `undefined` for an empty list).
 */
export function normalizeChannelAccountsPayload(...args: unknown[]): ChannelAccount[] {
  if (Array.isArray(args[0])) return args[0] as ChannelAccount[];
  return args.filter(
    (item): item is ChannelAccount => typeof item === 'object' && item !== null && !Array.isArray(item),
  );
}
