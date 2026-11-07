import type { ConversationReplayMessage } from '../../../shared/contract/conversationBranch';
import type { Message } from '../../../shared/contract/message';
import { sanitizeConversationMessageSnapshot } from '../core/conversationMessageSnapshot';

/** Resolve local display payloads only after the ledger has selected visible messages. */
export function restoreLocalMessageContent(
  sessionId: string,
  entry: ConversationReplayMessage,
  readProjection: (sessionId: string, messageId: string) => Message | null,
): Message {
  const snapshot = entry.message as Message;
  const provenanceIds = attachmentProvenanceIds(entry);
  if (
    entry.sourceSessionId !== sessionId
    || entry.sourceMessageId !== entry.projectedMessageId
    || snapshot.id !== entry.projectedMessageId
    || entry.aliasKind === 'fork_copy'
    || (!snapshot.content.includes('payload omitted]') && provenanceIds.size === 0)
  ) return snapshot;

  const local = readProjection(sessionId, entry.projectedMessageId);
  if (
    local?.id !== snapshot.id
    || local.role !== snapshot.role
    || local.timestamp !== snapshot.timestamp
    || local.visibility === 'rewound'
    || sanitizeConversationMessageSnapshot(local).content !== snapshot.content
  ) return snapshot;

  // Keep identity, visibility, tools and metadata from the validated ledger.
  // The immutable snapshot and fork/export privacy boundary remain unchanged.
  const restoredContent = snapshot.content.includes('payload omitted]') ? local.content : snapshot.content;
  // The ledger keeps only attachment provenance (no bytes/paths), so a reload would
  // render the user bubble without the file the user sent. Re-attach the local
  // projection's attachments, restricted to the ids the ledger actually recorded.
  const restoredAttachments = local.attachments?.filter((attachment) => provenanceIds.has(attachment.id));
  if (restoredContent === snapshot.content && !restoredAttachments?.length) return snapshot;
  return {
    ...snapshot,
    content: restoredContent,
    ...(restoredAttachments?.length ? { attachments: restoredAttachments } : {}),
  };
}

function attachmentProvenanceIds(entry: ConversationReplayMessage): Set<string> {
  const provenance = (entry.message as { readOnlyAttachmentProvenance?: unknown }).readOnlyAttachmentProvenance;
  if (!Array.isArray(provenance)) return new Set();
  return new Set(provenance.flatMap((item) => (
    item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
      ? [(item as { id: string }).id]
      : []
  )));
}
