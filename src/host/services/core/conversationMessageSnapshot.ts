import { createHash } from 'node:crypto';

import type { ConversationMessageSnapshot } from '../../../shared/contract/conversationBranch';
import type { Message } from '../../../shared/contract/message';

const ARTIFACT_BLOCK =
  /```(?:chart|spreadsheet|mermaid|html|generative_ui|neo_ui|question-form)\s*\n[\s\S]*?```/gu;

function attachmentContentDigest(attachment: Record<string, unknown>): string {
  const existing = attachment.contentDigest;
  if (typeof existing === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/iu.test(existing)) {
    return existing.replace(/^sha256:/iu, '').toLowerCase();
  }
  return createHash('sha256').update(JSON.stringify(attachment)).digest('hex');
}

function importedArtifactProvenance(
  metadata: Message['metadata'],
): Array<Record<string, unknown>> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const value = (metadata as Record<string, unknown>).readOnlyArtifactProvenanceV2;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    if (typeof source.id !== 'string' || typeof source.type !== 'string') return [];
    const existingDigest = source.contentDigest;
    if (
      typeof existingDigest !== 'string'
      || !/^(?:sha256:)?[a-f0-9]{64}$/iu.test(existingDigest)
    ) {
      return [];
    }
    return [{
      id: source.id,
      type: source.type,
      ...(typeof source.title === 'string' ? { title: source.title } : {}),
      ...(typeof source.version === 'number' ? { version: source.version } : {}),
      ...(typeof source.parentId === 'string' ? { parentId: source.parentId } : {}),
      contentDigest: existingDigest.replace(/^sha256:/iu, '').toLowerCase(),
    }];
  });
}

/**
 * Canonical privacy boundary for the append-only conversation ledger.
 * Runtime attachment bytes, absolute paths, and renderable Artifact payloads
 * never enter immutable storage. The compatibility message table remains the
 * source used to construct this snapshot.
 */
export function sanitizeConversationMessageSnapshot(
  message: Message,
): ConversationMessageSnapshot {
  const sanitized = structuredClone(message) as Message;
  const importedArtifacts = importedArtifactProvenance(sanitized.metadata);
  const attachments = sanitized.attachments?.map((attachment) => ({
    id: attachment.id,
    type: attachment.type,
    category: attachment.category,
    name: attachment.name,
    size: attachment.size,
    mimeType: attachment.mimeType,
    ...(attachment.pageCount !== undefined ? { pageCount: attachment.pageCount } : {}),
    ...(attachment.sheetCount !== undefined ? { sheetCount: attachment.sheetCount } : {}),
    ...(attachment.rowCount !== undefined ? { rowCount: attachment.rowCount } : {}),
    ...(attachment.language !== undefined ? { language: attachment.language } : {}),
    contentDigest: attachmentContentDigest(attachment as unknown as Record<string, unknown>),
  }));
  const artifacts = sanitized.artifacts?.map((artifact) => ({
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    version: artifact.version,
    parentId: artifact.parentId,
    contentDigest: createHash('sha256').update(artifact.content).digest('hex'),
  })) ?? importedArtifacts;
  if (
    sanitized.metadata
    && typeof sanitized.metadata === 'object'
    && !Array.isArray(sanitized.metadata)
    && Object.prototype.hasOwnProperty.call(
      sanitized.metadata,
      'readOnlyArtifactProvenanceV2',
    )
  ) {
    const metadata = { ...sanitized.metadata } as Record<string, unknown>;
    delete metadata.readOnlyArtifactProvenanceV2;
    sanitized.metadata = Object.keys(metadata).length > 0
      ? metadata as Message['metadata']
      : undefined;
  }
  sanitized.content = sanitized.content.replace(
    ARTIFACT_BLOCK,
    '[只读 Artifact provenance：payload omitted]',
  );
  delete sanitized.artifacts;
  delete sanitized.attachments;
  return {
    ...(sanitized as unknown as Record<string, unknown>),
    ...(attachments?.length ? { readOnlyAttachmentProvenance: attachments } : {}),
    ...(artifacts?.length ? { readOnlyArtifactProvenance: artifacts } : {}),
    id: sanitized.id,
    role: sanitized.role as ConversationMessageSnapshot['role'],
    content: sanitized.content,
    timestamp: sanitized.timestamp,
  };
}
