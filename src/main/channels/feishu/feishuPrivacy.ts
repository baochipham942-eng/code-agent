import type { ChannelMessage, ChannelPrivacyMode } from '../../../shared/contract/channel';
import {
  resolveChannelPrivacyMode,
  sanitizeChannelMessage,
  sanitizeChannelRaw,
  sanitizeChannelText,
} from '../privacy/channelPrivacyFirewall';

export function resolveFeishuPrivacyMode(mode: unknown): ChannelPrivacyMode {
  return resolveChannelPrivacyMode(mode);
}

export function sanitizeFeishuInboundContent(
  content: string,
  privacyMode?: ChannelPrivacyMode | null,
): string {
  return sanitizeChannelText(content, 12_000, { mode: privacyMode });
}

export function sanitizeFeishuInboundMessage(
  message: ChannelMessage,
  privacyMode?: ChannelPrivacyMode | null,
): ChannelMessage {
  return sanitizeChannelMessage(message, { retainRaw: true, mode: privacyMode });
}

export function sanitizeFeishuRawEventForStorage(
  event: unknown,
  privacyMode?: ChannelPrivacyMode | null,
): unknown {
  return sanitizeChannelRaw(event, { mode: privacyMode });
}
