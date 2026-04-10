// ============================================================================
// L1: Tool Result Budget — per-result token cap with head+tail truncation
// ============================================================================
// Runs on every message before it enters the transcript.
// Tool results (role='tool' or has toolCallId) are truncated to maxTokensPerResult.
// Preserves the first code block if present.
// Mutates message.content directly (pre-transcript, not API-view mutation).
// ============================================================================

import { CompressionState } from '../compressionState';
import { estimateTokens } from '../tokenEstimator';

export interface ToolResultBudgetConfig {
  maxTokensPerResult: number; // default: 2000
  protectedMessageIds?: Set<string>;
}

const DEFAULT_CONFIG: Pick<ToolResultBudgetConfig, 'maxTokensPerResult'> = {
  maxTokensPerResult: 2000,
};

/**
 * Extract the first code block from text if present.
 * Returns { pre, block, post } or null if no code block found.
 */
function extractFirstCodeBlock(
  text: string,
): { pre: string; block: string; post: string } | null {
  const match = text.match(/^([\s\S]*?)(```[\s\S]*?```)([\s\S]*)$/);
  if (!match) return null;
  return { pre: match[1], block: match[2], post: match[3] };
}

/**
 * Truncate text to fit within maxTokens using head+tail strategy.
 * If a code block is found, it is preserved at the head.
 */
function truncateHeadTail(text: string, maxTokens: number): string {
  const codeBlockResult = extractFirstCodeBlock(text);

  if (codeBlockResult) {
    // Keep code block, distribute remaining budget between head and tail
    const { pre, block, post } = codeBlockResult;
    const blockTokens = estimateTokens(block);
    const preTokens = estimateTokens(pre);

    // If code block alone exceeds budget, truncate the code block itself
    if (blockTokens >= maxTokens) {
      return truncatePlain(block, maxTokens);
    }

    // Budget remaining after the code block and separator
    const separatorTokens = 10; // for "...[truncated]..." markers
    const remainingBudget = maxTokens - blockTokens - separatorTokens;

    if (remainingBudget <= 0) {
      return block;
    }

    // Allocate evenly between pre and post
    const halfBudget = Math.floor(remainingBudget / 2);
    const preKept = preTokens <= halfBudget ? pre : truncatePlain(pre, halfBudget);
    const postBudget = remainingBudget - estimateTokens(preKept);
    const postKept = post.length > 0 ? truncateTail(post, postBudget) : '';

    return [preKept, block, postKept].filter(Boolean).join('');
  }

  return truncatePlain(text, maxTokens);
}

/**
 * Truncate from the start: keep first half + last half of budget.
 */
function truncatePlain(text: string, maxTokens: number): string {
  const currentTokens = estimateTokens(text);
  if (currentTokens <= maxTokens) return text;

  const lines = text.split('\n');
  const half = Math.floor(maxTokens / 2);

  // Take lines from head
  let headLines: string[] = [];
  let headTokens = 0;
  for (const line of lines) {
    const lt = estimateTokens(line) + 1; // +1 for newline
    if (headTokens + lt > half) break;
    headLines.push(line);
    headTokens += lt;
  }

  // Take lines from tail
  let tailLines: string[] = [];
  let tailTokens = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lt = estimateTokens(lines[i]) + 1;
    if (tailTokens + lt > half) break;
    tailLines.unshift(lines[i]);
    tailTokens += lt;
  }

  const marker = '\n...[truncated]...\n';
  return headLines.join('\n') + marker + tailLines.join('\n');
}

/**
 * Truncate keeping the tail (for post-code-block content).
 */
function truncateTail(text: string, maxTokens: number): string {
  const currentTokens = estimateTokens(text);
  if (currentTokens <= maxTokens) return text;

  const lines = text.split('\n');
  let tailLines: string[] = [];
  let tailTokens = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lt = estimateTokens(lines[i]) + 1;
    if (tailTokens + lt > maxTokens) break;
    tailLines.unshift(lines[i]);
    tailTokens += lt;
  }
  return '...\n' + tailLines.join('\n');
}

/**
 * Apply token budget to tool result messages.
 * Mutates message.content directly.
 * Writes a commit per truncated message.
 */
export function applyToolResultBudget(
  messages: Array<{ id: string; role: string; content: string; toolCallId?: string }>,
  state: CompressionState,
  config?: Partial<ToolResultBudgetConfig>,
): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const alreadyBudgeted = state.getSnapshot().budgetedResults;

  for (const msg of messages) {
    const isToolResult = msg.role === 'tool' || msg.toolCallId !== undefined;
    if (!isToolResult) continue;
    if (cfg.protectedMessageIds?.has(msg.id)) continue;
    if (alreadyBudgeted.has(msg.id)) continue;

    const originalTokens = estimateTokens(msg.content);
    if (originalTokens <= cfg.maxTokensPerResult) continue;

    const truncated = truncateHeadTail(msg.content, cfg.maxTokensPerResult);
    const truncatedTokens = estimateTokens(truncated);

    // Mutate the message content
    msg.content = truncated;

    // Record the commit
    state.applyCommit({
      layer: 'tool-result-budget',
      operation: 'truncate',
      targetMessageIds: [msg.id],
      timestamp: Date.now(),
      metadata: { originalTokens, truncatedTokens },
    });
  }
}
