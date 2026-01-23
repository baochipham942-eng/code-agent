// ============================================================================
// Context Compressor - Compress conversation context to fit token limits
// ============================================================================
// Provides multiple compression strategies:
// - truncate: Simple truncation from the middle/start
// - ai_summary: AI-generated summary of content
// - code_extract: Preserve code blocks, compress narrative
// - hybrid: Combine strategies for optimal compression
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { estimateTokens, estimateMessageTokens, Message } from './tokenEstimator';

const logger = createLogger('ContextCompressor');

/**
 * Compression strategy types
 */
export type CompressionStrategyType =
  | 'truncate'
  | 'ai_summary'
  | 'code_extract'
  | 'hybrid';

/**
 * Compression strategy configuration
 */
export interface CompressionStrategy {
  /** Strategy type */
  type: CompressionStrategyType;
  /** Token threshold to trigger compression */
  threshold: number;
  /** Target compression ratio (0-1, e.g., 0.5 = reduce to 50%) */
  targetRatio: number;
  /** Priority (higher = try first) */
  priority: number;
}

/**
 * Compression result
 */
export interface CompressionResult {
  /** Compressed content */
  content: string;
  /** Original token count */
  originalTokens: number;
  /** Compressed token count */
  compressedTokens: number;
  /** Tokens saved */
  savedTokens: number;
  /** Compression ratio achieved */
  ratio: number;
  /** Strategy used */
  strategy: CompressionStrategyType;
  /** Whether compression was applied */
  wasCompressed: boolean;
  /** Metadata about what was preserved/removed */
  metadata?: {
    preservedCodeBlocks?: number;
    removedMessages?: number;
    summaryGenerated?: boolean;
  };
}

/**
 * Default compression strategies
 */
export const DEFAULT_STRATEGIES: CompressionStrategy[] = [
  { type: 'code_extract', threshold: 0.8, targetRatio: 0.6, priority: 3 },
  { type: 'truncate', threshold: 0.9, targetRatio: 0.5, priority: 2 },
  { type: 'ai_summary', threshold: 0.95, targetRatio: 0.3, priority: 1 },
];

/**
 * Compressor options
 */
export interface CompressorOptions {
  /** Token limit for the context */
  tokenLimit: number;
  /** Strategies to use (in priority order) */
  strategies?: CompressionStrategy[];
  /** Function to generate AI summaries (optional) */
  summarizer?: (text: string, maxTokens: number) => Promise<string>;
  /** Whether to preserve system messages */
  preserveSystemMessages?: boolean;
  /** Whether to preserve recent messages */
  preserveRecentMessages?: number;
}

/**
 * Extract code blocks from text
 */
export function extractCodeBlocks(text: string): {
  blocks: Array<{ content: string; language: string; start: number; end: number }>;
  textWithoutCode: string;
} {
  const blocks: Array<{ content: string; language: string; start: number; end: number }> = [];
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;

  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    blocks.push({
      language: match[1] || 'text',
      content: match[2],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  // Replace code blocks with placeholders
  const textWithoutCode = text.replace(codeBlockRegex, '[CODE_BLOCK]');

  return { blocks, textWithoutCode };
}

/**
 * Truncate text from the middle, preserving start and end
 */
export function truncateMiddle(
  text: string,
  maxTokens: number,
  preserveRatio: number = 0.3
): string {
  const currentTokens = estimateTokens(text);
  if (currentTokens <= maxTokens) {
    return text;
  }

  // Calculate how much to keep from start and end
  const preserveTokens = Math.floor(maxTokens * preserveRatio);
  const lines = text.split('\n');

  // Keep lines from start
  let startLines: string[] = [];
  let startTokens = 0;
  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (startTokens + lineTokens > preserveTokens) break;
    startLines.push(line);
    startTokens += lineTokens;
  }

  // Keep lines from end
  let endLines: string[] = [];
  let endTokens = 0;
  for (let i = lines.length - 1; i >= startLines.length; i--) {
    const lineTokens = estimateTokens(lines[i]);
    if (endTokens + lineTokens > preserveTokens) break;
    endLines.unshift(lines[i]);
    endTokens += lineTokens;
  }

  const truncatedCount = lines.length - startLines.length - endLines.length;
  const separator = `\n\n... [${truncatedCount} lines truncated] ...\n\n`;

  return startLines.join('\n') + separator + endLines.join('\n');
}

/**
 * Compress using code extraction strategy
 * Preserves code blocks, compresses surrounding text
 */
export function compressWithCodeExtract(
  text: string,
  targetTokens: number
): CompressionResult {
  const originalTokens = estimateTokens(text);

  if (originalTokens <= targetTokens) {
    return {
      content: text,
      originalTokens,
      compressedTokens: originalTokens,
      savedTokens: 0,
      ratio: 1,
      strategy: 'code_extract',
      wasCompressed: false,
    };
  }

  const { blocks, textWithoutCode } = extractCodeBlocks(text);

  // Calculate token budget for non-code content
  const codeTokens = blocks.reduce(
    (sum, b) => sum + estimateTokens(b.content) + 10, // +10 for markdown fence
    0
  );
  const textBudget = Math.max(targetTokens - codeTokens, targetTokens * 0.2);

  // Compress the non-code text
  const compressedText = truncateMiddle(textWithoutCode, textBudget);

  // Reconstruct with code blocks
  let result = compressedText;
  for (const block of blocks) {
    result = result.replace(
      '[CODE_BLOCK]',
      `\n\`\`\`${block.language}\n${block.content}\`\`\`\n`
    );
  }

  const compressedTokens = estimateTokens(result);

  return {
    content: result,
    originalTokens,
    compressedTokens,
    savedTokens: originalTokens - compressedTokens,
    ratio: compressedTokens / originalTokens,
    strategy: 'code_extract',
    wasCompressed: true,
    metadata: {
      preservedCodeBlocks: blocks.length,
    },
  };
}

/**
 * Simple truncation compression
 */
export function compressWithTruncate(
  text: string,
  targetTokens: number
): CompressionResult {
  const originalTokens = estimateTokens(text);

  if (originalTokens <= targetTokens) {
    return {
      content: text,
      originalTokens,
      compressedTokens: originalTokens,
      savedTokens: 0,
      ratio: 1,
      strategy: 'truncate',
      wasCompressed: false,
    };
  }

  const compressed = truncateMiddle(text, targetTokens);
  const compressedTokens = estimateTokens(compressed);

  return {
    content: compressed,
    originalTokens,
    compressedTokens,
    savedTokens: originalTokens - compressedTokens,
    ratio: compressedTokens / originalTokens,
    strategy: 'truncate',
    wasCompressed: true,
  };
}

/**
 * Compress messages array
 */
export function compressMessages(
  messages: Message[],
  options: CompressorOptions
): {
  messages: Message[];
  result: CompressionResult;
} {
  const { tokenLimit, preserveSystemMessages = true, preserveRecentMessages = 2 } = options;

  // Calculate current tokens
  let totalTokens = 0;
  const messageTokens: number[] = [];

  for (const msg of messages) {
    const tokens = estimateMessageTokens(msg);
    messageTokens.push(tokens);
    totalTokens += tokens;
  }

  // If within limit, no compression needed
  if (totalTokens <= tokenLimit) {
    return {
      messages,
      result: {
        content: '',
        originalTokens: totalTokens,
        compressedTokens: totalTokens,
        savedTokens: 0,
        ratio: 1,
        strategy: 'truncate',
        wasCompressed: false,
      },
    };
  }

  // Identify messages to preserve
  const preserveIndices = new Set<number>();

  // Preserve system messages
  if (preserveSystemMessages) {
    messages.forEach((msg, i) => {
      if (msg.role === 'system') preserveIndices.add(i);
    });
  }

  // Preserve recent messages
  for (let i = messages.length - preserveRecentMessages; i < messages.length; i++) {
    if (i >= 0) preserveIndices.add(i);
  }

  // Remove messages from the middle until within budget
  const targetTokens = tokenLimit * 0.85; // Leave some buffer
  const resultMessages: Message[] = [];
  let removedCount = 0;
  let resultTokens = 0;

  // Always keep preserved messages
  const preservedTokens = Array.from(preserveIndices).reduce(
    (sum, i) => sum + messageTokens[i],
    0
  );

  // Calculate how many middle messages we can keep
  const availableForMiddle = targetTokens - preservedTokens;
  let middleTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    if (preserveIndices.has(i)) {
      resultMessages.push(messages[i]);
      resultTokens += messageTokens[i];
    } else if (middleTokens + messageTokens[i] <= availableForMiddle) {
      resultMessages.push(messages[i]);
      resultTokens += messageTokens[i];
      middleTokens += messageTokens[i];
    } else {
      removedCount++;
    }
  }

  return {
    messages: resultMessages,
    result: {
      content: '',
      originalTokens: totalTokens,
      compressedTokens: resultTokens,
      savedTokens: totalTokens - resultTokens,
      ratio: resultTokens / totalTokens,
      strategy: 'truncate',
      wasCompressed: true,
      metadata: {
        removedMessages: removedCount,
      },
    },
  };
}

/**
 * Context Compressor class for stateful compression
 */
export class ContextCompressor {
  private options: CompressorOptions;
  private strategies: CompressionStrategy[];

  constructor(options: CompressorOptions) {
    this.options = options;
    this.strategies = (options.strategies || DEFAULT_STRATEGIES)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Compress text content
   */
  compressText(text: string): CompressionResult {
    const originalTokens = estimateTokens(text);
    const usageRatio = originalTokens / this.options.tokenLimit;

    // Find appropriate strategy
    for (const strategy of this.strategies) {
      if (usageRatio >= strategy.threshold) {
        const targetTokens = Math.floor(this.options.tokenLimit * strategy.targetRatio);

        switch (strategy.type) {
          case 'code_extract':
            return compressWithCodeExtract(text, targetTokens);
          case 'truncate':
            return compressWithTruncate(text, targetTokens);
          case 'ai_summary':
            // AI summary requires async, return truncate as fallback
            return compressWithTruncate(text, targetTokens);
          case 'hybrid':
            // Try code_extract first, then truncate if needed
            const codeResult = compressWithCodeExtract(text, targetTokens);
            if (codeResult.compressedTokens <= targetTokens) {
              return codeResult;
            }
            return compressWithTruncate(codeResult.content, targetTokens);
        }
      }
    }

    // No compression needed
    return {
      content: text,
      originalTokens,
      compressedTokens: originalTokens,
      savedTokens: 0,
      ratio: 1,
      strategy: 'truncate',
      wasCompressed: false,
    };
  }

  /**
   * Compress messages array
   */
  compressConversation(messages: Message[]): {
    messages: Message[];
    result: CompressionResult;
  } {
    return compressMessages(messages, this.options);
  }

  /**
   * Async compression with AI summary support
   */
  async compressTextAsync(text: string): Promise<CompressionResult> {
    const originalTokens = estimateTokens(text);
    const usageRatio = originalTokens / this.options.tokenLimit;

    for (const strategy of this.strategies) {
      if (usageRatio >= strategy.threshold && strategy.type === 'ai_summary') {
        if (this.options.summarizer) {
          const targetTokens = Math.floor(this.options.tokenLimit * strategy.targetRatio);

          try {
            const summary = await this.options.summarizer(text, targetTokens);
            const compressedTokens = estimateTokens(summary);

            return {
              content: summary,
              originalTokens,
              compressedTokens,
              savedTokens: originalTokens - compressedTokens,
              ratio: compressedTokens / originalTokens,
              strategy: 'ai_summary',
              wasCompressed: true,
              metadata: {
                summaryGenerated: true,
              },
            };
          } catch (error) {
            logger.warn('AI summary failed, falling back to truncate', { error });
          }
        }
      }
    }

    // Fall back to sync compression
    return this.compressText(text);
  }
}
