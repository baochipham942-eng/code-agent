// ============================================================================
// Context Intervention Helpers - shared transcript materialization utilities
// ============================================================================

import type { ContextInterventionSnapshot } from '../../shared/types/contextView';

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
  const sourceById = new Map((sourceMessages || baseMessages).map((message) => [message.id, message]));
  const pinned = interventions.pinned
    .map((messageId) => sourceById.get(messageId))
    .filter((message): message is T => message !== undefined && !excludedIds.has(message.id));
  const retained = interventions.retained
    .map((messageId) => sourceById.get(messageId))
    .filter((message): message is T => message !== undefined && !excludedIds.has(message.id));
  const base = baseMessages.filter((message) => !excludedIds.has(message.id));
  const seen = new Set<string>();

  return [...pinned, ...retained, ...base].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}
