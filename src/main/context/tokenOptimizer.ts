// ============================================================================
// Token Optimizer - Comprehensive token consumption optimization
// ============================================================================
// Provides:
// - Tool result compression using ContextCompressor
// - Hook message deduplication and buffering
// - Precise token estimation using tokenEstimator
// - RAG context caching
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { estimateTokens, analyzeContent } from './tokenEstimator';
import { ContextCompressor } from './compressor';
import type { CompressionResult } from './compressor';

const logger = createLogger('TokenOptimizer');

// ----------------------------------------------------------------------------
// Tool Result Compression
// ----------------------------------------------------------------------------

export interface ToolResultCompressionConfig {
  /** Token threshold to trigger compression (default: 500) */
  threshold?: number;
  /** Target token count after compression (default: 300) */
  targetTokens?: number;
  /** Whether to preserve code blocks (default: true) */
  preserveCode?: boolean;
}

const DEFAULT_COMPRESSION_CONFIG: Required<ToolResultCompressionConfig> = {
  threshold: 300,
  targetTokens: 200,
  preserveCode: true,
};

export interface ToolResultCompressionOutput {
  content: string;
  compressed: boolean;
  savedTokens: number;
  /** Compression metadata (separate from content to avoid breaking JSON) */
  compressionInfo?: {
    originalTokens: number;
    compressedTokens: number;
  };
}

/**
 * Compress tool result if it exceeds token threshold
 *
 * IMPORTANT: Does NOT modify content format (no headers prepended).
 * Compression info is returned separately to preserve JSON validity.
 */
export function compressToolResult(
  content: string,
  config: ToolResultCompressionConfig = {}
): ToolResultCompressionOutput {
  const cfg = { ...DEFAULT_COMPRESSION_CONFIG, ...config };
  const originalTokens = estimateTokens(content);

  if (originalTokens <= cfg.threshold) {
    return { content, compressed: false, savedTokens: 0 };
  }

  const compressor = new ContextCompressor({
    tokenLimit: cfg.targetTokens,
    strategies: cfg.preserveCode
      ? [
          { type: 'code_extract', threshold: 0.8, targetRatio: 0.6, priority: 3 },
          { type: 'truncate', threshold: 0.9, targetRatio: 0.5, priority: 2 },
        ]
      : [{ type: 'truncate', threshold: 0.8, targetRatio: 0.5, priority: 1 }],
  });

  const result = compressor.compressText(content);

  if (result.wasCompressed) {
    logger.debug(`Tool result compressed: ${originalTokens}→${result.compressedTokens} tokens (saved ${result.savedTokens})`);
    return {
      content: result.content, // Keep original format, no header prepended
      compressed: true,
      savedTokens: result.savedTokens,
      compressionInfo: {
        originalTokens,
        compressedTokens: result.compressedTokens,
      },
    };
  }

  return { content, compressed: false, savedTokens: 0 };
}

// ----------------------------------------------------------------------------
// Hook Message Buffer
// ----------------------------------------------------------------------------

export interface HookMessageEntry {
  content: string;
  category: string;
  timestamp: number;
  count: number;
}

/**
 * Buffer for hook messages with deduplication and folding
 */
export class HookMessageBuffer {
  private buffer: Map<string, HookMessageEntry> = new Map();
  private contentHashes: Set<string> = new Set();

  /**
   * Add a hook message to the buffer
   * Returns true if message was added, false if duplicate
   */
  add(content: string, category: string): boolean {
    // Generate content hash for deduplication
    const contentKey = this.hashContent(content);

    // Check for duplicate content
    if (this.contentHashes.has(contentKey)) {
      logger.debug(`Hook message deduplicated: ${category}`);
      // Update count for existing entry
      const existing = this.buffer.get(category);
      if (existing) {
        existing.count++;
      }
      return false;
    }

    this.contentHashes.add(contentKey);

    // Check if category already exists
    const existing = this.buffer.get(category);
    if (existing) {
      // Merge messages of same category
      existing.content += `\n---\n${content}`;
      existing.count++;
      existing.timestamp = Date.now();
    } else {
      this.buffer.set(category, {
        content,
        category,
        timestamp: Date.now(),
        count: 1,
      });
    }

    return true;
  }

  /**
   * Flush buffer and return merged message
   * Returns null if buffer is empty
   */
  flush(): string | null {
    if (this.buffer.size === 0) {
      return null;
    }

    const entries = Array.from(this.buffer.values());

    // Sort by timestamp
    entries.sort((a, b) => a.timestamp - b.timestamp);

    // Merge all entries
    const merged = entries
      .map((entry) => {
        const header =
          entry.count > 1 ? `<${entry.category} count="${entry.count}">` : `<${entry.category}>`;
        const footer = `</${entry.category}>`;
        return `${header}\n${entry.content}\n${footer}`;
      })
      .join('\n\n');

    // Clear buffer
    this.buffer.clear();
    this.contentHashes.clear();

    const tokens = estimateTokens(merged);
    logger.debug(`Hook buffer flushed: ${entries.length} categories, ${tokens} tokens`);

    return merged;
  }

  /**
   * Get current buffer size
   */
  get size(): number {
    return this.buffer.size;
  }

  /**
   * Clear buffer without returning content
   */
  clear(): void {
    this.buffer.clear();
    this.contentHashes.clear();
  }

  /**
   * Hash content for deduplication (first 100 chars + length)
   */
  private hashContent(content: string): string {
    const preview = content.substring(0, 100).trim();
    return `${preview.length}:${preview}`;
  }
}

// ----------------------------------------------------------------------------
// RAG Context Cache
// ----------------------------------------------------------------------------

export interface RAGCacheEntry {
  query: string;
  context: string;
  tokens: number;
  timestamp: number;
}

export interface RAGCacheConfig {
  /** Time-to-live in milliseconds (default: 5 minutes) */
  ttl?: number;
  /** Maximum cache entries (default: 10) */
  maxEntries?: number;
}

const DEFAULT_RAG_CACHE_CONFIG: Required<RAGCacheConfig> = {
  ttl: 5 * 60 * 1000, // 5 minutes
  maxEntries: 10,
};

/**
 * Session-level cache for RAG context
 */
export class RAGContextCache {
  private cache: Map<string, RAGCacheEntry> = new Map();
  private config: Required<RAGCacheConfig>;

  constructor(config: RAGCacheConfig = {}) {
    this.config = { ...DEFAULT_RAG_CACHE_CONFIG, ...config };
  }

  /**
   * Get cached RAG context for query
   * Returns null if not found or expired
   */
  get(query: string): RAGCacheEntry | null {
    const key = this.normalizeQuery(query);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > this.config.ttl) {
      this.cache.delete(key);
      logger.debug(`RAG cache expired: ${key.substring(0, 30)}...`);
      return null;
    }

    logger.debug(`RAG cache hit: ${entry.tokens} tokens saved`);
    return entry;
  }

  /**
   * Store RAG context for query
   */
  set(query: string, context: string): void {
    const key = this.normalizeQuery(query);
    const tokens = estimateTokens(context);

    // Evict oldest entries if at capacity
    if (this.cache.size >= this.config.maxEntries) {
      const oldestKey = this.findOldestEntry();
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      query,
      context,
      tokens,
      timestamp: Date.now(),
    });

    logger.debug(`RAG cache set: ${tokens} tokens, key=${key.substring(0, 30)}...`);
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { entries: number; totalTokens: number } {
    let totalTokens = 0;
    for (const entry of this.cache.values()) {
      totalTokens += entry.tokens;
    }
    return { entries: this.cache.size, totalTokens };
  }

  private normalizeQuery(query: string): string {
    // Use first 100 chars, lowercase, trimmed as key
    return query.substring(0, 100).toLowerCase().trim();
  }

  private findOldestEntry(): string | null {
    let oldest: { key: string; timestamp: number } | null = null;

    for (const [key, entry] of this.cache.entries()) {
      if (!oldest || entry.timestamp < oldest.timestamp) {
        oldest = { key, timestamp: entry.timestamp };
      }
    }

    return oldest?.key || null;
  }
}

// ----------------------------------------------------------------------------
// Token Usage Tracker
// ----------------------------------------------------------------------------

export interface TokenBreakdown {
  systemPrompt: number;
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  hookMessages: number;
  ragContext: number;
  total: number;
}

/**
 * Precise token usage calculation using tokenEstimator
 */
export function calculateTokenBreakdown(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  ragContext?: string
): TokenBreakdown {
  const breakdown: TokenBreakdown = {
    systemPrompt: estimateTokens(systemPrompt),
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    hookMessages: 0,
    ragContext: ragContext ? estimateTokens(ragContext) : 0,
    total: 0,
  };

  for (const msg of messages) {
    const tokens = estimateTokens(msg.content);

    switch (msg.role) {
      case 'user':
        breakdown.userMessages += tokens;
        break;
      case 'assistant':
        breakdown.assistantMessages += tokens;
        break;
      case 'tool':
        breakdown.toolResults += tokens;
        break;
      case 'system':
        // System messages after the first are hook messages
        breakdown.hookMessages += tokens;
        break;
    }
  }

  breakdown.total =
    breakdown.systemPrompt +
    breakdown.userMessages +
    breakdown.assistantMessages +
    breakdown.toolResults +
    breakdown.hookMessages +
    breakdown.ragContext;

  return breakdown;
}

/**
 * Calculate precise token count for model messages
 * Replaces the rough chars/4 estimation
 */
export function estimateModelMessageTokens(
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
): number {
  let total = 0;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.text) {
          total += estimateTokens(part.text);
        }
      }
    }
  }

  // Add overhead for message structure (~4 tokens per message)
  total += messages.length * 4;

  return total;
}

// ----------------------------------------------------------------------------
// Message History Compression
// ----------------------------------------------------------------------------

export interface CompressedMessage {
  role: string;
  content: string;
  timestamp?: number;
  compressed?: boolean;
  /** Original message ID for index-safe compression */
  id?: string;
}

export interface MessageHistoryCompressionConfig {
  /** Token threshold to trigger compression (default: 8000) */
  threshold?: number;
  /** Target token count after compression (default: 4000) */
  targetTokens?: number;
  /** Number of recent messages to preserve uncompressed (default: 6) */
  preserveRecentCount?: number;
  /** Whether to always preserve user messages (default: true) */
  preserveUserMessages?: boolean;
}

const DEFAULT_HISTORY_COMPRESSION_CONFIG: Required<MessageHistoryCompressionConfig> = {
  threshold: 8000,
  targetTokens: 4000,
  preserveRecentCount: 6,
  preserveUserMessages: true,
};

/**
 * Compress message history when it exceeds token threshold.
 * Preserves recent messages and compresses older ones.
 *
 * Strategy:
 * 1. Keep recent N messages intact (preserveRecentCount)
 * 2. Summarize tool results in older messages
 * 3. Truncate long assistant messages
 * 4. Optionally preserve all user messages
 */
export function compressMessageHistory(
  messages: CompressedMessage[],
  config: MessageHistoryCompressionConfig = {}
): { messages: CompressedMessage[]; compressed: boolean; savedTokens: number } {
  const cfg = { ...DEFAULT_HISTORY_COMPRESSION_CONFIG, ...config };

  // Calculate current token usage
  const totalTokens = messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);

  if (totalTokens <= cfg.threshold) {
    return { messages, compressed: false, savedTokens: 0 };
  }

  logger.debug(`Message history compression triggered: ${totalTokens} tokens > ${cfg.threshold} threshold`);

  // Split into recent (preserved) and older (compressible) messages
  const recentMessages = messages.slice(-cfg.preserveRecentCount);
  const olderMessages = messages.slice(0, -cfg.preserveRecentCount);

  if (olderMessages.length === 0) {
    // Not enough messages to compress
    return { messages, compressed: false, savedTokens: 0 };
  }

  const compressedOlder: CompressedMessage[] = [];

  for (const msg of olderMessages) {
    const msgTokens = estimateTokens(msg.content);

    // Preserve user messages if configured
    if (cfg.preserveUserMessages && msg.role === 'user') {
      compressedOlder.push(msg);
      continue;
    }

    // Compress tool messages (usually large outputs)
    if (msg.role === 'tool') {
      const compressed = compressToolMessage(msg.content);
      compressedOlder.push({
        ...msg,
        id: msg.id, // Preserve original ID for index-safe mapping
        content: compressed,
        compressed: true,
      });
      continue;
    }

    // Compress long assistant messages
    if (msg.role === 'assistant' && msgTokens > 500) {
      const compressed = compressAssistantMessage(msg.content);
      compressedOlder.push({
        ...msg,
        id: msg.id, // Preserve original ID for index-safe mapping
        content: compressed,
        compressed: true,
      });
      continue;
    }

    // Keep short messages intact
    compressedOlder.push(msg);
  }

  const result = [...compressedOlder, ...recentMessages];
  const newTotalTokens = result.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
  const savedTokens = totalTokens - newTotalTokens;

  logger.info(`Message history compressed: ${totalTokens}→${newTotalTokens} tokens (saved ${savedTokens})`);

  return {
    messages: result,
    compressed: true,
    savedTokens,
  };
}

/**
 * Compress tool result message content
 */
function compressToolMessage(content: string): string {
  try {
    // Try to parse as JSON (tool results are often JSON)
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed)) {
      // Compress array of tool results
      const summaries = parsed.map((result: { toolCallId?: string; success?: boolean; error?: string; output?: string }) => {
        if (result.success === false) {
          return `[Error: ${result.error || 'Unknown error'}]`;
        }
        if (result.output) {
          // Truncate long outputs
          const outputPreview = result.output.substring(0, 200);
          return `[Success: ${outputPreview}${result.output.length > 200 ? '...' : ''}]`;
        }
        return '[Success]';
      });
      return `[Compressed tool results: ${summaries.join(', ')}]`;
    }

    // Single result
    if (parsed.output) {
      const preview = parsed.output.substring(0, 200);
      return `[Tool result: ${preview}${parsed.output.length > 200 ? '...' : ''}]`;
    }

    return `[Tool result: ${content.substring(0, 100)}...]`;
  } catch {
    // Not JSON, just truncate
    return `[Tool output: ${content.substring(0, 200)}...]`;
  }
}

/**
 * Compress long assistant message content
 */
function compressAssistantMessage(content: string): string {
  // Extract key parts: first paragraph + any code blocks (truncated)
  const lines = content.split('\n');
  const result: string[] = [];
  let tokenCount = 0;
  const maxTokens = 300;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (tokenCount + lineTokens > maxTokens) {
      result.push('...[truncated]');
      break;
    }
    result.push(line);
    tokenCount += lineTokens;
  }

  return result.join('\n');
}

/**
 * Message History Compressor class for stateful compression
 * Tracks compression state across multiple calls
 */
export class MessageHistoryCompressor {
  private config: Required<MessageHistoryCompressionConfig>;
  private lastCompressionTime: number = 0;
  private compressionCount: number = 0;
  private totalSavedTokens: number = 0;

  /** Threshold ratio for proactive compression (default: 75%) */
  private proactiveCompressionThreshold = 0.75;

  constructor(config: MessageHistoryCompressionConfig = {}) {
    this.config = { ...DEFAULT_HISTORY_COMPRESSION_CONFIG, ...config };
  }

  /**
   * Check if proactive compression should be triggered
   * Triggers at 75% capacity to prevent hitting hard limits
   *
   * @param currentTokens - Current token usage
   * @param maxTokens - Maximum allowed tokens (context length)
   * @returns Whether proactive compression should be triggered
   */
  shouldProactivelyCompress(currentTokens: number, maxTokens: number): boolean {
    const usageRatio = currentTokens / maxTokens;
    return usageRatio > this.proactiveCompressionThreshold;
  }

  /**
   * Set proactive compression threshold
   * @param threshold - Value between 0 and 1 (default: 0.75)
   */
  setProactiveThreshold(threshold: number): void {
    this.proactiveCompressionThreshold = Math.max(0.5, Math.min(0.95, threshold));
  }

  /**
   * Compress messages if needed
   * Returns compressed messages and stats
   */
  compress(messages: CompressedMessage[]): {
    messages: CompressedMessage[];
    wasCompressed: boolean;
    stats: { savedTokens: number; compressionCount: number; totalSavedTokens: number };
  } {
    const result = compressMessageHistory(messages, this.config);

    if (result.compressed) {
      this.compressionCount++;
      this.totalSavedTokens += result.savedTokens;
      this.lastCompressionTime = Date.now();
    }

    return {
      messages: result.messages,
      wasCompressed: result.compressed,
      stats: {
        savedTokens: result.savedTokens,
        compressionCount: this.compressionCount,
        totalSavedTokens: this.totalSavedTokens,
      },
    };
  }

  /**
   * Get compression statistics
   */
  getStats(): {
    compressionCount: number;
    totalSavedTokens: number;
    lastCompressionTime: number;
  } {
    return {
      compressionCount: this.compressionCount,
      totalSavedTokens: this.totalSavedTokens,
      lastCompressionTime: this.lastCompressionTime,
    };
  }

  /**
   * Reset statistics
   */
  reset(): void {
    this.compressionCount = 0;
    this.totalSavedTokens = 0;
    this.lastCompressionTime = 0;
  }
}

// ----------------------------------------------------------------------------
// Re-exports for convenience
// ----------------------------------------------------------------------------

export { estimateTokens, analyzeContent } from './tokenEstimator';
export { ContextCompressor } from './compressor';
