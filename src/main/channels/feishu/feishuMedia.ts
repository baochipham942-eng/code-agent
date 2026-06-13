import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import type { ChannelAttachment } from '../../../shared/contract/channel';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('FeishuMedia');

export type FeishuMediaMessageType = 'image' | 'file' | 'audio' | 'media';

export interface FeishuMediaMaterializeOptions {
  accountId: string;
  platform?: 'feishu' | 'lark';
  messageId: string;
  messageType: FeishuMediaMessageType;
  content: string;
  client?: unknown;
  cacheRoot?: string;
}

export interface FeishuMediaMaterialization {
  content: string;
  attachments: ChannelAttachment[];
}

interface ParsedFeishuMedia {
  fileKey: string;
  fileName: string;
  mimeType: string;
  size?: number;
  resourceType: FeishuMediaMessageType;
}

type MessageResourceApi = {
  get?: (request: unknown, ...options: unknown[]) => Promise<unknown>;
};

type FeishuClientLike = {
  im?: {
    messageResource?: MessageResourceApi;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseFeishuMediaContent(
  messageType: FeishuMediaMessageType,
  rawContent: string,
): ParsedFeishuMedia | null {
  const content = parseJsonRecord(rawContent);
  const fileKey =
    readString(content, 'image_key') ??
    readString(content, 'file_key') ??
    readString(content, 'audio_key') ??
    readString(content, 'media_key');

  if (!fileKey) return null;

  const resourceType = messageType;
  const fallbackName = buildFallbackName(messageType, fileKey);
  const fileName =
    readString(content, 'file_name') ??
    readString(content, 'name') ??
    fallbackName;
  const mimeType =
    readString(content, 'mime_type') ??
    readString(content, 'mimeType') ??
    inferMimeType(messageType, fileName);
  const size =
    readNumber(content, 'file_size') ??
    readNumber(content, 'size');

  return {
    fileKey,
    fileName,
    mimeType,
    size,
    resourceType,
  };
}

export async function materializeFeishuMedia(
  options: FeishuMediaMaterializeOptions,
): Promise<FeishuMediaMaterialization | null> {
  const parsed = parseFeishuMediaContent(options.messageType, options.content);
  if (!parsed) return null;

  const attachment: ChannelAttachment = {
    id: parsed.fileKey,
    type: toChannelAttachmentType(options.messageType),
    name: parsed.fileName,
    mimeType: parsed.mimeType,
    size: parsed.size,
    url: parsed.fileKey,
    platformFileKey: parsed.fileKey,
    mediaState: 'downloading',
    metadata: {
      platform: options.platform ?? 'feishu',
      accountId: options.accountId,
      messageId: options.messageId,
      resourceType: parsed.resourceType,
      platformFileKey: parsed.fileKey,
      materializationState: 'pending',
    },
  };

  const downloaded = await downloadFeishuMessageResource({
    client: options.client,
    accountId: options.accountId,
    messageId: options.messageId,
    fileKey: parsed.fileKey,
    fileName: parsed.fileName,
    mimeType: parsed.mimeType,
    resourceType: parsed.resourceType,
    platform: options.platform ?? 'feishu',
    cacheRoot: options.cacheRoot,
  });

  if (downloaded) {
    attachment.localPath = downloaded.path;
    attachment.size = downloaded.size;
    attachment.mediaState = 'ready';
    attachment.metadata = {
      ...attachment.metadata,
      materializationState: 'ready',
      localPath: downloaded.path,
    };
  } else {
    attachment.mediaState = 'failed';
    attachment.metadata = {
      ...attachment.metadata,
      materializationState: 'failed',
    };
  }

  return {
    content: mediaContentLabel(options.messageType, parsed.fileName, Boolean(downloaded)),
    attachments: [attachment],
  };
}

export async function downloadFeishuMessageResource(options: {
  client?: unknown;
  accountId: string;
  messageId: string;
  fileKey: string;
  fileName: string;
  mimeType: string;
  resourceType: FeishuMediaMessageType;
  platform?: 'feishu' | 'lark';
  cacheRoot?: string;
}): Promise<{ path: string; size: number } | null> {
  const api = getMessageResourceApi(options.client);
  if (!api?.get) return null;

  try {
    const response = await api.get({
      path: {
        message_id: options.messageId,
        file_key: options.fileKey,
      },
      params: {
        type: options.resourceType,
      },
    });
    const buffer = await toBuffer(response);
    if (!buffer?.length) return null;

    const dir = buildCacheDir(options.cacheRoot, options.platform ?? 'feishu', options.accountId);
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(options.fileName) || extensionForMime(options.mimeType);
    const fileName = `${safeSegment(options.messageId)}-${safeSegment(options.fileKey)}${ext}`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, buffer);
    return { path: filePath, size: buffer.length };
  } catch (error) {
    logger.warn('Failed to download Feishu media resource', {
      messageId: options.messageId,
      fileKey: options.fileKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function getMessageResourceApi(client: unknown): MessageResourceApi | null {
  const candidate = client as FeishuClientLike | undefined;
  return candidate?.im?.messageResource ?? null;
}

async function toBuffer(value: unknown): Promise<Buffer | null> {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof Readable) return readableToBuffer(value);
  if (isRecord(value)) {
    for (const key of ['data', 'file', 'body', 'content']) {
      const nested = value[key];
      const buffer = await toBuffer(nested);
      if (buffer) return buffer;
    }
  }
  return null;
}

async function readableToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

function buildCacheDir(cacheRoot: string | undefined, platform: 'feishu' | 'lark', accountId: string): string {
  return path.join(cacheRoot ?? path.join(os.homedir(), '.code-agent', 'cache', 'channel-media'), platform, safeSegment(accountId));
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'file';
}

function buildFallbackName(messageType: FeishuMediaMessageType, fileKey: string): string {
  const ext = messageType === 'image'
    ? '.png'
    : messageType === 'audio'
      ? '.wav'
      : '';
  return `${messageType}-${safeSegment(fileKey)}${ext}`;
}

function inferMimeType(messageType: FeishuMediaMessageType, fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (messageType === 'image') return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  if (messageType === 'audio') return ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
  if (messageType === 'media') return ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';
  return 'application/octet-stream';
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg';
  if (mimeType.includes('mpeg')) return '.mp3';
  if (mimeType.includes('wav')) return '.wav';
  if (mimeType.includes('mp4')) return '.mp4';
  return '';
}

function toChannelAttachmentType(messageType: FeishuMediaMessageType): ChannelAttachment['type'] {
  if (messageType === 'image') return 'image';
  if (messageType === 'audio') return 'audio';
  if (messageType === 'media') return 'video';
  return 'file';
}

function mediaContentLabel(
  messageType: FeishuMediaMessageType,
  fileName: string,
  downloaded: boolean,
): string {
  const noun = messageType === 'image'
    ? '图片'
    : messageType === 'audio'
      ? '语音'
      : messageType === 'media'
        ? '视频'
        : '文件';
  return downloaded ? `[${noun}: ${fileName}]` : `[${noun}: ${fileName}，下载失败]`;
}
