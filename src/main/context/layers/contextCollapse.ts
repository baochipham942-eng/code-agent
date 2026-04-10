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
 * Returns true if a message is "tool-related":
 * - role is 'tool', OR
 * - role is 'assistant' and content mentions a tool_call/tool use pattern
 */
function isToolRelated(msg: { role: string; content: string }): boolean {
  if (msg.role === 'tool') return true;
  if (msg.role === 'assistant') {
    // Heuristic: look for tool call indicators in assistant messages
    return (
      msg.content.includes('tool_call') ||
      msg.content.includes('<tool_use>') ||
      msg.content.includes('function_call')
    );
  }
  return false;
}

/**
 * Find contiguous spans of tool-related messages.
 * Returns array of spans, each span is a list of indices.
 */
function findCollapsibleSpans(
  messages: Array<{ id: string; role: string; content: string; turnIndex: number }>,
  excludedIds: Set<string>,
  minSpanSize: number,
): number[][] {
  const spans: number[][] = [];
  let currentSpan: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (excludedIds.has(msg.id)) {
      // Break span on excluded messages
      if (currentSpan.length >= minSpanSize) {
        spans.push([...currentSpan]);
      }
      currentSpan = [];
      continue;
    }

    if (isToolRelated(msg)) {
      currentSpan.push(i);
    } else {
      if (currentSpan.length >= minSpanSize) {
        spans.push([...currentSpan]);
      }
      currentSpan = [];
    }
  }

  // Flush trailing span
  if (currentSpan.length >= minSpanSize) {
    spans.push([...currentSpan]);
  }

  return spans;
}

/**
 * Apply context collapse: find spans, summarize, write commits.
 */
export async function applyContextCollapse(
  messages: Array<{ id: string; role: string; content: string; turnIndex: number }>,
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
