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
  if (
    entry.sourceSessionId !== sessionId
    || entry.sourceMessageId !== entry.projectedMessageId
    || snapshot.id !== entry.projectedMessageId
    || entry.aliasKind === 'fork_copy'
    || !snapshot.content.includes('payload omitted]')
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
  return { ...snapshot, content: local.content };
}
