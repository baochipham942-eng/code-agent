// ============================================================================
// L4: Context Collapse — summarize consecutive tool-related message spans
// ============================================================================
// Finds collapsible spans (consecutive tool-related messages),
// skips already processed messages, only collapses if savings > 3x summary cost.
// Uses an injected summarize function — no direct AI dependency.
// ============================================================================

import { CompressionState } from '../compressionState';
import { estimateTokens } from '../tokenEstimator';

export interface ContextCollapseConfig {
  minSpanSize: number; // default: 3
  summarize: (messages: Array<{ role: string; content: string }>) => Promise<string>;
  maxSummaryTokens: number; // default: 200
  protectedMessageIds?: Set<string>;
}

const DEFAULT_MIN_SPAN_SIZE = 3;
const DEFAULT_MAX_SUMMARY_TOKENS = 200;
const SAVINGS_RATIO_THRESHOLD = 3; // must save at least 3x summary cost

/**
 * Returns true if a message participates in the tool protocol.
 * Tool structure lives in dedicated fields; message text is not protocol evidence.
 */
function isToolRelated(msg: {
  role: string;
  toolCalls?: unknown[];
  toolCallId?: string;
}): boolean {
  return (
    msg.role === 'tool'
    || typeof msg.toolCallId === 'string'
    || (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0)
  );
}

function startsToolRound(msg: { role: string; toolCalls?: unknown[] }): boolean {
  return msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0;
}

function getToolRoundCallIds(msg: { toolCalls?: unknown[] }): Set<string> | undefined {
  if (!Array.isArray(msg.toolCalls) || msg.toolCalls.length === 0) return undefined;
  const ids = msg.toolCalls.map((call) => (
    typeof call === 'object' && call !== null && typeof (call as { id?: unknown }).id === 'string'
      ? (call as { id: string }).id
      : undefined
  ));
  return ids.every((id): id is string => id !== undefined) ? new Set(ids) : undefined;
}

/**
 * Find atomic rounds of tool-related messages.
 * Returns array of spans, each span is a list of indices.
 */
function findCollapsibleSpans(
  messages: Array<{
    id: string;
    role: string;
    content: string;
    turnIndex: number;
    toolCalls?: unknown[];
    toolCallId?: string;
  }>,
  excludedIds: Set<string>,
  minSpanSize: number,
): number[][] {
  const spans: number[][] = [];
  let currentRound: number[] = [];
  let roundIsExcluded = false;
  let roundCallIds: Set<string> | undefined;
  let pendingCallIds: Set<string> | undefined;

  const flushRound = (): void => {
    if (!roundIsExcluded && currentRound.length >= minSpanSize) {
      spans.push([...currentRound]);
    }
    currentRound = [];
    roundIsExcluded = false;
    roundCallIds = undefined;
    pendingCallIds = undefined;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isToolRelated(msg)) {
      flushRound();
      continue;
    }

    // A tool-calling assistant starts a new atomic round. Once all of its
    // identified results have arrived, a tool with another call ID starts a
    // standalone round so unrelated legacy/tool-only spans remain collapsible.
    if (startsToolRound(msg)) {
      if (currentRound.length > 0) flushRound();
      roundCallIds = getToolRoundCallIds(msg);
      pendingCallIds = roundCallIds ? new Set(roundCallIds) : undefined;
    } else if (
      roundCallIds
      && pendingCallIds?.size === 0
      && (typeof msg.toolCallId !== 'string' || !roundCallIds.has(msg.toolCallId))
    ) {
      flushRound();
    }

    currentRound.push(i);
    if (excludedIds.has(msg.id)) roundIsExcluded = true;
    if (pendingCallIds && typeof msg.toolCallId === 'string') {
      pendingCallIds.delete(msg.toolCallId);
    }
  }

  flushRound();

  return spans;
}

/**
 * Apply context collapse: find spans, summarize, write commits.
 */
export async function applyContextCollapse(
  messages: Array<{
    id: string;
    role: string;
    content: string;
    turnIndex: number;
    toolCalls?: unknown[];
    toolCallId?: string;
  }>,
  state: CompressionState,
  config: ContextCollapseConfig,
): Promise<void> {
  const minSpanSize = config.minSpanSize ?? DEFAULT_MIN_SPAN_SIZE;
  const maxSummaryTokens = config.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;

  const snapshot = state.getSnapshot();

  // Build set of already-processed message IDs
  const excludedIds = new Set<string>([
    ...snapshot.snippedIds,
    ...snapshot.microcompactedIds,
  ]);
  for (const id of config.protectedMessageIds ?? []) {
    excludedIds.add(id);
  }
  // Also exclude messages already in collapsed spans
  for (const span of snapshot.collapsedSpans) {
    for (const id of span.messageIds) {
      excludedIds.add(id);
    }
  }

  const spans = findCollapsibleSpans(messages, excludedIds, minSpanSize);

  for (const spanIndices of spans) {
    const spanMessages = spanIndices.map((i) => messages[i]);
    const spanIds = spanMessages.map((m) => m.id);

    // Calculate original tokens for this span
    const originalTokens = spanMessages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );

    // Only collapse if savings > 3x summary cost
    const summaryCost = maxSummaryTokens;
    const savings = originalTokens - summaryCost;
    if (savings < SAVINGS_RATIO_THRESHOLD * summaryCost) continue;

    // Call the injected summarize function
    const summary = await config.summarize(
      spanMessages.map((m) => ({ role: m.role, content: m.content })),
    );

    if (summary.trim().length === 0) continue;
    if (estimateTokens(summary) > maxSummaryTokens) continue;

    state.applyCommit({
      layer: 'contextCollapse',
      operation: 'collapse',
      targetMessageIds: spanIds,
      timestamp: Date.now(),
      metadata: {
        summary,
        originalTokens,
        summaryCost,
      },
    });
  }
}
