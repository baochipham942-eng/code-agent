// ============================================================================
// ProjectionEngine — Generates API view by projecting transcript through state
// ============================================================================
// Design principle: "projection over mutation"
// - Takes an immutable transcript and a CompressionState
// - Returns a new array representing the API view — original is NEVER mutated
// - Projection order: collapses → snips → budgets (pass-through)
// ============================================================================

import { CompressionState, type CollapsedSpan } from './compressionState';

export interface ProjectableMessage {
  id: string;
  role: string;
  content: string;
  [key: string]: unknown;
}

export class ProjectionEngine {
  /**
   * Pure function: projects transcript through compression state.
   * Original transcript is not mutated.
   */
  projectMessages(
    transcript: ProjectableMessage[],
    state: CompressionState,
  ): ProjectableMessage[] {
    if (transcript.length === 0) return [];

    const snapshot = state.getSnapshot();

    // Build a set of all collapsed message IDs for fast lookup,
    // and a map from first-message-id → span for replacement.
    const collapsedFirstIds = new Map<string, CollapsedSpan>();
    const collapsedOtherIds = new Set<string>();

    for (const span of snapshot.collapsedSpans) {
      if (span.messageIds.length === 0) continue;
      const [first, ...rest] = span.messageIds;
      collapsedFirstIds.set(first, span);
      for (const id of rest) {
        collapsedOtherIds.add(id);
      }
    }

    const result: ProjectableMessage[] = [];

    for (const msg of transcript) {
      // --- Apply collapses ---
      if (collapsedOtherIds.has(msg.id)) {
        // Non-first messages of a span are removed
        continue;
      }

      if (collapsedFirstIds.has(msg.id)) {
        const span = collapsedFirstIds.get(msg.id)!;
        const summaryMsg: ProjectableMessage = {
          ...msg,
          role: 'system',
          content: `[collapsed: ${span.messageIds.length} turns] ${span.summary}`,
        };
        result.push(summaryMsg);
        continue;
      }

      // --- Apply snips ---
      if (snapshot.snippedIds.has(msg.id)) {
        result.push({
          ...msg,
          content: '[snipped: message compressed]',
        });
        continue;
      }

      // --- Budgeted results: pass-through (already truncated at commit time) ---
      // No transformation needed — the truncated content is already in the transcript.

      result.push(msg);
    }

    return result;
  }
}
