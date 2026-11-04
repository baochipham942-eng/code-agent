// Compaction must honour pin/exclude without moving array indexes or
// rewriting the live transcript. Callers pass the redacted copy only to the
// summariser, then put pinned plain-text survivors back after the marker.

import type { Message } from '../../shared/contract';
import type { ContextInterventionSnapshot } from '../../shared/contract/contextView';

const EXCLUDED_COMPACTION_PLACEHOLDER = '[excluded from model context]';

function isPlainTextMessage(message: Message): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') return false;
  return !message.toolCalls?.length;
}

export function redactExcludedMessagesForCompaction(
  messages: readonly Message[],
  interventions: ContextInterventionSnapshot,
): Message[] {
  const excluded = new Set(interventions.excluded);
  if (excluded.size === 0) return messages.slice();
  return messages.map((message) => {
    if (!excluded.has(message.id)) return message;
    return {
      ...message,
      content: EXCLUDED_COMPACTION_PLACEHOLDER,
      reasoning: undefined,
      thinking: undefined,
      contentParts: undefined,
      toolCalls: message.toolCalls?.map((call) => ({ ...call, arguments: {} })),
      toolResults: message.toolResults?.map((result) => ({
        ...result,
        output: EXCLUDED_COMPACTION_PLACEHOLDER,
        error: undefined,
      })),
      attachments: message.attachments?.map((attachment) => ({ ...attachment, data: undefined })),
    };
  });
}

/** Pinned user/assistant text inside the compacted prefix, in original order. */
export function pinnedPlainTextSurvivors(
  messages: readonly Message[],
  boundary: number,
  interventions: ContextInterventionSnapshot,
): Message[] {
  if (boundary <= 0 || interventions.pinned.length === 0) return [];
  const pinned = new Set(interventions.pinned);
  const excluded = new Set(interventions.excluded);
  return messages.slice(0, boundary).filter((message) =>
    pinned.has(message.id) && !excluded.has(message.id) && isPlainTextMessage(message),
  );
}

/**
 * Swap placeholder copies back to the original messages, then keep pinned
 * plain-text survivors immediately after the leading compaction message.
 */
export function commitCompactedMessagesKeepingPinned(
  originalMessages: readonly Message[],
  newMessages: readonly Message[],
  compactedMessageCount: number,
  interventions: ContextInterventionSnapshot,
): Message[] {
  const byId = new Map(originalMessages.map((message) => [message.id, message]));
  const restored = newMessages.map((message) => byId.get(message.id) ?? message);
  const survivors = pinnedPlainTextSurvivors(originalMessages, compactedMessageCount, interventions)
    .filter((message) => !restored.some((kept) => kept.id === message.id));
  if (survivors.length === 0) return restored;
  if (restored.length === 0) return survivors.slice();
  return [restored[0], ...survivors, ...restored.slice(1)];
}
