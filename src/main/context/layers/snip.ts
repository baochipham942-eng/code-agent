// ============================================================================
// L2: Snip — replace eligible old messages with placeholder
// ============================================================================
// Skips: recent N turns, user messages, system messages, messages with code
// blocks, messages already snipped.
// Writes a single commit with all snipped IDs.
// ============================================================================

import { CompressionState } from '../compressionState';

export interface SnipConfig {
  currentTurnIndex: number;
  preserveRecentTurns: number; // default: 5
}

const DEFAULT_PRESERVE_RECENT_TURNS = 5;

/**
 * Returns true if the content contains a fenced code block.
 */
function hasCodeBlock(content: string): boolean {
  return /```[\s\S]*?```/.test(content);
}

/**
 * Apply snip: mark old non-critical messages as snipped in the state.
 * Does NOT mutate messages — writes a commit that ProjectionEngine will
 * render as '[snipped: message compressed]'.
 */
export function applySnip(
  messages: Array<{ id: string; role: string; content: string; turnIndex: number }>,
  state: CompressionState,
  config: SnipConfig,
): void {
  const preserveRecentTurns = config.preserveRecentTurns ?? DEFAULT_PRESERVE_RECENT_TURNS;
  const cutoffTurnIndex = config.currentTurnIndex - preserveRecentTurns;

  const snapshot = state.getSnapshot();
  const alreadySnipped = snapshot.snippedIds;

  const toSnip: string[] = [];

  for (const msg of messages) {
    // Skip messages in recent turns
    if (msg.turnIndex >= cutoffTurnIndex) continue;

    // Skip user messages (preserve intent)
    if (msg.role === 'user') continue;

    // Skip system messages
    if (msg.role === 'system') continue;

    // Skip messages with code blocks
    if (hasCodeBlock(msg.content)) continue;

    // Skip already-snipped messages
    if (alreadySnipped.has(msg.id)) continue;

    toSnip.push(msg.id);
  }

  if (toSnip.length === 0) return;

  state.applyCommit({
    layer: 'snip',
    operation: 'snip',
    targetMessageIds: toSnip,
    timestamp: Date.now(),
    metadata: { count: toSnip.length },
  });
}
