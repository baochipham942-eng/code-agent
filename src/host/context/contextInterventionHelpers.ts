// ============================================================================
// Context Intervention Helpers - shared transcript materialization utilities
// ============================================================================

import type { ContextInterventionSnapshot } from '../../shared/contract/contextView';

export function getProtectedMessageIds(interventions: ContextInterventionSnapshot): Set<string> {
  return new Set([
    ...interventions.pinned,
    ...interventions.retained,
  ]);
}

export function applyInterventionsToMessages<T extends { id: string }>(
  baseMessages: T[],
  interventions: ContextInterventionSnapshot,
  sourceMessages?: ReadonlyArray<T>,
): T[] {
  const excludedIds = new Set(interventions.excluded);
  const source = sourceMessages ?? baseMessages;
  const sourceById = new Map(source.map((message) => [message.id, message]));
  const pinnedIds = new Set(
    interventions.pinned.filter((messageId) => !excludedIds.has(messageId) && sourceById.has(messageId)),
  );
  const retained = interventions.retained
    .map((messageId) => sourceById.get(messageId))
    .filter((message): message is T => message !== undefined && !excludedIds.has(message.id));
  const baseIds = new Set(baseMessages.map((message) => message.id));
  const chronological: T[] = [];
  const seenInSpine = new Set<string>();
  const push = (message: T) => {
    if (excludedIds.has(message.id) || seenInSpine.has(message.id)) return;
    chronological.push(message);
    seenInSpine.add(message.id);
  };
  for (const message of source) {
    if (!baseIds.has(message.id) && !pinnedIds.has(message.id)) continue;
    push(sourceById.get(message.id) ?? message);
  }
  for (const message of baseMessages) push(message);

  const seen = new Set<string>();
  return [...retained, ...chronological].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}
