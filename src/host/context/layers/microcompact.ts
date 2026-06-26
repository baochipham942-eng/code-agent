// ============================================================================
// L3: Microcompact — lightweight text compression for large messages
// ============================================================================
// Two paths:
//   cached  (cacheHot=true):    compress tool/assistant msgs >500 tokens
//   time-based (idle ≥5 min):   compress all msgs >300 tokens except recent 6
//
// compactText(): collapse whitespace, strip leading indent, preserve code blocks.
// Only runs on main thread.
// ============================================================================

import { CompressionState } from '../compressionState';
import { estimateTokens } from '../tokenEstimator';

export interface MicrocompactConfig {
  isMainThread: boolean;
  cacheHot: boolean;
  idleMinutes: number;
  protectedMessageIds?: Set<string>;
}

const CACHED_TOKEN_THRESHOLD = 500;
const IDLE_TOKEN_THRESHOLD = 300;
const IDLE_MINUTES_THRESHOLD = 5;
const IDLE_PRESERVE_RECENT = 6;

/**
 * Compact a text string:
 * - Collapse runs of 3+ newlines to 2
 * - Collapse runs of 2+ spaces (outside code blocks) to 1
 * - Strip leading indentation from non-code-block lines
 * - Preserve fenced code blocks verbatim
 */
export function compactText(text: string): string {
  // Split on code blocks to preserve them
  const segments = text.split(/(```[\s\S]*?```)/);

  const processedSegments = segments.map((segment, i) => {
    // Odd indices are code blocks — leave verbatim
    if (i % 2 === 1) return segment;

    // 1. Collapse 3+ consecutive newlines to 2
    let result = segment.replace(/\n{3,}/g, '\n\n');

    // 2. Collapse horizontal whitespace runs (2+ spaces/tabs) to single space
    result = result.replace(/[ \t]{2,}/g, ' ');

    // 3. Strip leading whitespace on each line
    result = result
      .split('\n')
      .map((line) => line.replace(/^[ \t]+/, ''))
      .join('\n');

    return result;
  });

  return processedSegments.join('');
}

/**
 * Apply microcompact compression to eligible messages.
 * Mutates message.content directly and writes a commit.
 */
export function applyMicrocompact(
  messages: Array<{ id: string; role: string; content: string }>,
  state: CompressionState,
  config: MicrocompactConfig,
): void {
  // Only runs on main thread
  if (!config.isMainThread) return;

  const snapshot = state.getSnapshot();
  const alreadyCompacted = snapshot.microcompactedIds;
  const alreadySnipped = snapshot.snippedIds;

  const compactedIds: string[] = [];

  if (config.cacheHot) {
    // Cached path: compress tool/assistant messages >500 tokens
    for (const msg of messages) {
      if (msg.role !== 'tool' && msg.role !== 'assistant') continue;
      if (alreadyCompacted.has(msg.id)) continue;
      if (alreadySnipped.has(msg.id)) continue;
      if (config.protectedMessageIds?.has(msg.id)) continue;
      if (estimateTokens(msg.content) <= CACHED_TOKEN_THRESHOLD) continue;

      msg.content = compactText(msg.content);
      compactedIds.push(msg.id);
    }
  } else if (config.idleMinutes >= IDLE_MINUTES_THRESHOLD) {
    // Time-based path: more aggressive — all messages >300 tokens except recent 6
    const recentCutoff = Math.max(0, messages.length - IDLE_PRESERVE_RECENT);

    for (let i = 0; i < recentCutoff; i++) {
      const msg = messages[i];
      if (msg.role === 'system') continue;
      if (alreadyCompacted.has(msg.id)) continue;
      if (alreadySnipped.has(msg.id)) continue;
      if (config.protectedMessageIds?.has(msg.id)) continue;
      if (estimateTokens(msg.content) <= IDLE_TOKEN_THRESHOLD) continue;

      msg.content = compactText(msg.content);
      compactedIds.push(msg.id);
    }
  }

  if (compactedIds.length === 0) return;

  state.applyCommit({
    layer: 'microcompact',
    operation: 'compact',
    targetMessageIds: compactedIds,
    timestamp: Date.now(),
    metadata: { count: compactedIds.length },
  });
}
