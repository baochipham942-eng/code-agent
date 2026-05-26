import type { MessageAttachment } from '../contract';

const INLINE_ATTACHMENT_BLOCK_RE = /\n{0,2}<attachment\b(?=[^>]*\bcategory=)[^>]*>[\s\S]*?<\/attachments?>/gi;

function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && /^data:[^,]+,/i.test(value);
}

function isImageAttachment(attachment: MessageAttachment): boolean {
  return attachment.category === 'image' || attachment.type === 'image';
}

function getAttachmentId(attachment: MessageAttachment): string {
  return typeof attachment.id === 'string' ? attachment.id : '';
}

function shouldStripPersistedData(attachment: MessageAttachment): boolean {
  if (getAttachmentId(attachment).startsWith('appshot-')) return true;
  if (isImageAttachment(attachment)) return false;
  if (!isDataUrl(attachment.data)) return false;

  return attachment.category === 'presentation' || attachment.category === 'archive';
}

export function sanitizeAttachmentForPersistence(attachment: MessageAttachment): MessageAttachment {
  const isAppshot = getAttachmentId(attachment).startsWith('appshot-');
  const isImage = isImageAttachment(attachment);
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
    thumbnail: isImage ? (attachment.thumbnail || attachment.data) : undefined,
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
  };
}

export function sanitizeAttachmentsForPersistence(
  attachments: MessageAttachment[] | undefined,
): MessageAttachment[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map(sanitizeAttachmentForPersistence);
}

export function stripInlineAttachmentBlocks(content: string): string {
  return content
    .replace(INLINE_ATTACHMENT_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
