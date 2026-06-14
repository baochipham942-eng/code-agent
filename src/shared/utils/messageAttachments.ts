import type { MessageAttachment } from '../contract';

const INLINE_ATTACHMENT_BLOCK_RE = /\n{0,2}<attachment\b(?=[^>]*\bcategory=)[^>]*>[\s\S]*?<\/attachments?>/gi;
const MAX_PERSISTED_DATA_URL_CHARS = 512 * 1024;

export interface AttachmentPersistenceMetrics {
  attachmentCount: number;
  originalDataUrlCount: number;
  originalDataUrlChars: number;
  persistedDataUrlCount: number;
  persistedDataUrlChars: number;
  strippedDataUrlCount: number;
  strippedDataUrlChars: number;
}

function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && /^data:[^,]+,/i.test(value);
}

function isImageAttachment(attachment: MessageAttachment): boolean {
  return attachment.category === 'image' || attachment.type === 'image';
}

function isMediaAttachment(attachment: MessageAttachment): boolean {
  return (
    isImageAttachment(attachment)
    || attachment.category === 'audio'
    || attachment.category === 'video'
    || Boolean(attachment.mimeType?.startsWith('audio/') || attachment.mimeType?.startsWith('video/'))
  );
}

function isLargeDataUrl(value: unknown): value is string {
  return isDataUrl(value) && value.length > MAX_PERSISTED_DATA_URL_CHARS;
}

function getAttachmentId(attachment: MessageAttachment): string {
  return typeof attachment.id === 'string' ? attachment.id : '';
}

function shouldStripPersistedData(attachment: MessageAttachment): boolean {
  if (getAttachmentId(attachment).startsWith('appshot-')) return true;
  if (isLargeDataUrl(attachment.data) && isMediaAttachment(attachment)) return true;
  if (isImageAttachment(attachment)) return false;
  if (!isDataUrl(attachment.data)) return false;

  return attachment.category === 'presentation' || attachment.category === 'archive';
}

function persistentThumbnail(attachment: MessageAttachment): string | undefined {
  if (!isImageAttachment(attachment)) return undefined;
  if (attachment.thumbnail && !isLargeDataUrl(attachment.thumbnail)) return attachment.thumbnail;
  if (isDataUrl(attachment.data) && !isLargeDataUrl(attachment.data)) return attachment.data;
  return undefined;
}

export function sanitizeAttachmentForPersistence(attachment: MessageAttachment): MessageAttachment {
  const isAppshot = getAttachmentId(attachment).startsWith('appshot-');
  const data = shouldStripPersistedData(attachment) ? undefined : attachment.data;

  return {
    id: attachment.id,
    type: attachment.type,
    category: attachment.category,
    name: attachment.name,
    size: attachment.size,
    mimeType: attachment.mimeType,
    data,
    path: isAppshot ? undefined : attachment.path,
    thumbnail: persistentThumbnail(attachment),
    pageCount: attachment.pageCount,
    sheetCount: attachment.sheetCount,
    rowCount: attachment.rowCount,
    sheetsJson: attachment.sheetsJson,
    docxJson: attachment.docxJson,
    pptJson: attachment.pptJson,
    archiveManifest: attachment.archiveManifest,
    language: attachment.language,
    files: attachment.files,
    folderStats: attachment.folderStats,
    mediaState: attachment.mediaState,
    metadata: attachment.metadata,
  };
}

export function sanitizeAttachmentsForPersistence(
  attachments: MessageAttachment[] | undefined,
): MessageAttachment[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map(sanitizeAttachmentForPersistence);
}

function dataUrlLength(value: unknown): number {
  return isDataUrl(value) ? value.length : 0;
}

export function collectAttachmentPersistenceMetrics(
  original: MessageAttachment[] | undefined,
  persisted: MessageAttachment[] | undefined,
): AttachmentPersistenceMetrics {
  const originalAttachments = original ?? [];
  const persistedAttachments = persisted ?? [];
  let originalDataUrlCount = 0;
  let originalDataUrlChars = 0;
  let persistedDataUrlCount = 0;
  let persistedDataUrlChars = 0;

  for (const attachment of originalAttachments) {
    const dataChars = dataUrlLength(attachment.data);
    const thumbnailChars = dataUrlLength(attachment.thumbnail);
    if (dataChars > 0) {
      originalDataUrlCount++;
      originalDataUrlChars += dataChars;
    }
    if (thumbnailChars > 0 && attachment.thumbnail !== attachment.data) {
      originalDataUrlCount++;
      originalDataUrlChars += thumbnailChars;
    }
  }

  for (const attachment of persistedAttachments) {
    const dataChars = dataUrlLength(attachment.data);
    const thumbnailChars = dataUrlLength(attachment.thumbnail);
    if (dataChars > 0) {
      persistedDataUrlCount++;
      persistedDataUrlChars += dataChars;
    }
    if (thumbnailChars > 0 && attachment.thumbnail !== attachment.data) {
      persistedDataUrlCount++;
      persistedDataUrlChars += thumbnailChars;
    }
  }

  return {
    attachmentCount: originalAttachments.length,
    originalDataUrlCount,
    originalDataUrlChars,
    persistedDataUrlCount,
    persistedDataUrlChars,
    strippedDataUrlCount: Math.max(0, originalDataUrlCount - persistedDataUrlCount),
    strippedDataUrlChars: Math.max(0, originalDataUrlChars - persistedDataUrlChars),
  };
}

export function stripInlineAttachmentBlocks(content: string): string {
  return content
    .replace(INLINE_ATTACHMENT_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
