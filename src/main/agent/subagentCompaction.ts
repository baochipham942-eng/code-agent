// ============================================================================
// Subagent Compaction - Lightweight message truncation for long-running subagents
// ============================================================================
// Prevents subagent conversations from hitting model context window limits.
// Strategy: preserve head (system + initial user) and tail (recent N pairs),
// truncate middle messages to reduce token count.
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { estimateTokens } from '../context/tokenEstimator';
import {
  CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  SUBAGENT_COMPACTION,
} from '../../shared/constants';

const logger = createLogger('SubagentCompaction');

/** Message type matching subagentExecutor.ts */
type MessageContent = {
  type: 'text' | 'image';
  text?: string;
  source?: { type: 'base64'; media_type: string; data: string };
};

export type SubagentMessage = {
  role: string;
  content: string | MessageContent[];
};

/**
 * Extract text from a message for token estimation.
 */
function messageText(msg: SubagentMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  // Multimodal: concatenate text parts, ignore images
  return msg.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
}

/**
 * Truncate a string to maxChars, appending '... [truncated]' if shortened.
 */
function truncateStr(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '... [truncated]';
}

/**
 * Estimate total tokens for the message array.
 */
function estimateTotalTokens(messages: SubagentMessage[]): number {
  let total = 3; // conversation overhead
  for (const msg of messages) {
    total += 4 + estimateTokens(messageText(msg)); // 4 = role overhead
  }
  return total;
}

/**
 * Compact subagent messages in-place when approaching context window limit.
 *
 * Preserves:
 *   - messages[0] (system prompt)
 *   - messages[1] (initial user message, potentially multimodal)
 *   - last `PRESERVE_RECENT_PAIRS * 2` messages (recent assistant+user pairs)
 *
 * Middle messages are truncated:
 *   - user (tool results) → TOOL_RESULT_MAX_CHARS
 *   - assistant (tool call descriptions) → ASSISTANT_MAX_CHARS
 *
 * @returns true if compaction was performed
 */
export function compactSubagentMessages(
  messages: SubagentMessage[],
  model: string
): boolean {
  const contextWindow = CONTEXT_WINDOWS[model] || DEFAULT_CONTEXT_WINDOW;
  const threshold = contextWindow * SUBAGENT_COMPACTION.THRESHOLD;
  const currentTokens = estimateTotalTokens(messages);

  if (currentTokens <= threshold) {
    return false;
  }

  // Head: system (0) + initial user (1)
  const headCount = 2;
  // Tail: recent N pairs (each pair = assistant + user)
  const tailCount = SUBAGENT_COMPACTION.PRESERVE_RECENT_PAIRS * 2;

  // If not enough messages to truncate middle section, skip
  if (messages.length <= headCount + tailCount) {
    return false;
  }

  const middleStart = headCount;
  const middleEnd = messages.length - tailCount;
  let truncatedCount = 0;

  for (let i = middleStart; i < middleEnd; i++) {
    const msg = messages[i];
    if (typeof msg.content !== 'string') continue; // skip multimodal

    const maxChars =
      msg.role === 'assistant'
        ? SUBAGENT_COMPACTION.ASSISTANT_MAX_CHARS
        : SUBAGENT_COMPACTION.TOOL_RESULT_MAX_CHARS;

    if (msg.content.length > maxChars) {
      msg.content = truncateStr(msg.content, maxChars);
      truncatedCount++;
    }
  }

  const newTokens = estimateTotalTokens(messages);
  logger.info(
    `[SubagentCompaction] Compacted ${truncatedCount} messages: ${currentTokens} → ${newTokens} tokens ` +
      `(model=${model}, window=${contextWindow}, threshold=${Math.round(threshold)})`
  );

  return truncatedCount > 0;
}
