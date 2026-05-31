import type { ChannelMessage, ChannelPrivacyMode } from '../../../shared/contract/channel';
import {
  resolveChannelPrivacyMode,
  sanitizeChannelMessage,
} from '../privacy/channelPrivacyFirewall';

export function resolveFeishuPrivacyMode(mode: unknown): ChannelPrivacyMode {
  return resolveChannelPrivacyMode(mode);
}

export function sanitizeFeishuInboundMessage(
  message: ChannelMessage,
  privacyMode?: ChannelPrivacyMode | null,
): ChannelMessage {
  return sanitizeChannelMessage(message, { retainRaw: true, mode: privacyMode });
}
