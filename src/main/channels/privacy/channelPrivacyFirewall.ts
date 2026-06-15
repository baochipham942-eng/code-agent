import type {
  ChannelAttachment,
  ChannelMessage,
  ChannelPrivacyMode,
} from '../../../shared/contract/channel';
import { guardSensitiveText } from '../../security/sensitiveDataGuard';

export interface ChannelPrivacyOptions {
  retainRaw?: boolean;
  mode?: ChannelPrivacyMode | null;
}

export const DEFAULT_CHANNEL_PRIVACY_MODE: ChannelPrivacyMode = 'local-redact';

const CHANNEL_PRIVACY_MODES = new Set<ChannelPrivacyMode>([
  'local-redact',
  'allow-raw',
  'off',
]);

export function resolveChannelPrivacyMode(mode: unknown): ChannelPrivacyMode {
  return typeof mode === 'string' && CHANNEL_PRIVACY_MODES.has(mode as ChannelPrivacyMode)
    ? mode as ChannelPrivacyMode
    : DEFAULT_CHANNEL_PRIVACY_MODE;
}

export function sanitizeChannelText(
  value: unknown,
  maxLength = 12_000,
  options: ChannelPrivacyOptions = {},
): string {
  if (resolveChannelPrivacyMode(options.mode) === 'off') {
    return trimChannelText(value, maxLength);
  }

  return guardSensitiveText(value, {
    surface: 'activity',
    mode: 'local-persist',
    maxLength,
  }).trim();
}

export function sanitizeChannelMessage<T extends ChannelMessage>(
  message: T,
  options: ChannelPrivacyOptions = {},
): T {
  const mode = resolveChannelPrivacyMode(options.mode);

  if (mode === 'off') {
    return {
      ...message,
      sender: {
        ...message.sender,
        name: trimChannelText(message.sender.name, 1_000) || message.sender.name,
        avatarUrl: message.sender.avatarUrl ? trimChannelText(message.sender.avatarUrl, 2_000) : undefined,
      },
      context: {
        ...message.context,
        chatName: message.context.chatName ? trimChannelText(message.context.chatName, 1_000) : undefined,
      },
      content: trimChannelText(message.content),
      raw: options.retainRaw ? message.raw : undefined,
    };
  }

  return {
    ...message,
    sender: {
      ...message.sender,
      name: sanitizeChannelText(message.sender.name, 1_000, options) || message.sender.name,
      avatarUrl: message.sender.avatarUrl ? sanitizeChannelText(message.sender.avatarUrl, 2_000, options) : undefined,
    },
    context: {
      ...message.context,
      chatName: message.context.chatName ? sanitizeChannelText(message.context.chatName, 1_000, options) : undefined,
    },
    content: sanitizeChannelText(message.content, 12_000, options),
    attachments: sanitizeChannelAttachments(message.attachments, options),
    raw: options.retainRaw
      ? mode === 'allow-raw'
        ? message.raw
        : sanitizeChannelRaw(message.raw, options)
      : undefined,
  };
}

export function sanitizeChannelRaw(value: unknown, options: ChannelPrivacyOptions = {}): unknown {
  if (resolveChannelPrivacyMode(options.mode) === 'off') return value;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeChannelText(value, 12_000, options);
  if (Array.isArray(value)) return value.map((item) => sanitizeChannelRaw(item, options));
  if (typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (/content|text|body|raw|token|secret|password|authorization|cookie/i.test(key)) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = sanitizeChannelRaw(rawValue, options);
  }
  return output;
}

function sanitizeChannelAttachments(
  attachments: ChannelAttachment[] | undefined,
  options: ChannelPrivacyOptions,
): ChannelAttachment[] | undefined {
  if (!attachments?.length) return undefined;
  // 白名单构造（不用 {...attachment} 透传）：新增字段必须在此显式决策，
  // 避免像 localPath/platformFileKey/metadata 那样悄悄绕过脱敏落地。
  return attachments.map((attachment) => ({
    id: attachment.id,
    type: attachment.type,
    name: sanitizeChannelText(attachment.name, 1_000, options) || 'attachment',
    mimeType: attachment.mimeType,
    size: attachment.size,
    url: attachment.url ? sanitizeChannelText(attachment.url, 2_000, options) : undefined,
    thumbnailUrl: attachment.thumbnailUrl ? sanitizeChannelText(attachment.thumbnailUrl, 2_000, options) : undefined,
    data: undefined,
    // localPath / platformFileKey 是下游功能字段（转写需要 localPath 定位文件），
    // 本地路径不外发，保留；metadata 里的敏感内容（如 transcript）逐项脱敏。
    localPath: attachment.localPath,
    platformFileKey: attachment.platformFileKey,
    metadata: sanitizeChannelAttachmentMetadata(attachment.metadata, options),
    mediaState: attachment.mediaState,
  }));
}

function sanitizeChannelAttachmentMetadata(
  metadata: Record<string, unknown> | undefined,
  options: ChannelPrivacyOptions,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  if (resolveChannelPrivacyMode(options.mode) === 'off') return metadata;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    output[key] = typeof value === 'string' ? sanitizeChannelText(value, 12_000, options) : value;
  }
  return output;
}

function trimChannelText(value: unknown, maxLength = 12_000): string {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, maxLength).trim();
}
