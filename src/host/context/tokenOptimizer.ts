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
import { estimateTokens, IMAGE_TOKEN_ESTIMATE } from './tokenEstimator';
import { TOOL_RESULT_SPILL } from '../../shared/constants';
import { ContextCompressor } from './compressor';

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
 * Detect and compress read_xlsx output preserving schema + sample rows + hint.
 * Returns null if content is not xlsx output.
 */
function compressXlsxResult(content: string, _targetTokens: number): string | null {
  // Detect xlsx output by its signature header
  if (!content.startsWith('📊 Excel 内容')) return null;

  const lines = content.split('\n');
  const preserved: string[] = [];
  let dataStartIdx = -1;

  // Preserve metadata header (first 4 lines: title, sheet info, available sheets, separator)
  for (let i = 0; i < lines.length && i < 6; i++) {
    preserved.push(lines[i]);
    if (lines[i].startsWith('─')) {
      dataStartIdx = i + 1;
      break;
    }
  }

  if (dataStartIdx === -1) return null;

  // Skip empty line after separator
  if (dataStartIdx < lines.length && lines[dataStartIdx].trim() === '') {
    preserved.push('');
    dataStartIdx++;
  }

  // Preserve column headers + separator (for markdown table) or first header line (json/csv)
  const sampleRows: string[] = [];
  let headerLines = 0;

  // Detect format: markdown table starts with "| "
  if (dataStartIdx < lines.length && lines[dataStartIdx].startsWith('|')) {
    // Markdown: header row + separator row
    sampleRows.push(lines[dataStartIdx]); // header
    if (dataStartIdx + 1 < lines.length && lines[dataStartIdx + 1].startsWith('|')) {
      sampleRows.push(lines[dataStartIdx + 1]); // separator
      headerLines = 2;
    }
  } else if (dataStartIdx < lines.length && lines[dataStartIdx].startsWith('[')) {
    // JSON array: just take first few entries
    headerLines = 0;
  } else {
    // CSV: first line is header
    sampleRows.push(lines[dataStartIdx]);
    headerLines = 1;
  }

  // Add 3 sample data rows after headers
  const dataRowStart = dataStartIdx + headerLines;
  for (let i = dataRowStart; i < Math.min(dataRowStart + 3, lines.length); i++) {
    if (lines[i].trim() === '') continue;
    sampleRows.push(lines[i]);
  }

  preserved.push(...sampleRows);
  preserved.push('');
  preserved.push('... [数据已省略，请用 bash + Python 从源文件读取完整数据]');

  // Preserve the hint line at the end if present
  for (let i = lines.length - 1; i >= Math.max(lines.length - 3, 0); i--) {
    if (lines[i].startsWith('💡 提示')) {
      preserved.push(lines[i]);
      break;
    }
  }

  return preserved.join('\n');
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

  // 反爬 hint 是模型识别"该换工具"的关键信号——压缩成 "... truncated ..."
  // placeholder 后模型永远看不到，会继续撞同一堵墙（27-turn xiaohongshu 实测）。
  // 保留含 hint 的内容不压缩，是给 agent 自我纠正的唯一通道。
  if (content.includes('[SYSTEM HINT: this response looks like an anti-scraping wall')) {
    return { content, compressed: false, savedTokens: 0 };
  }

  // GAP-009: 落盘提示是模型回查完整输出的唯一通道，和反爬 hint 同理必须存活。
  // truncate 策略的尾部预算极小（~30 token），带长路径的提示行会被整体丢弃
  // （webFetch 反爬 hint 踩过同一坑）。解法：压缩前抽出提示行，压缩后拼回尾部。
  let spillNotice = '';
  let compressibleContent = content;
  if (content.includes(TOOL_RESULT_SPILL.NOTICE_MARKER)) {
    const lines = content.split('\n');
    spillNotice = lines.filter((line) => line.includes(TOOL_RESULT_SPILL.NOTICE_MARKER)).join('\n');
    compressibleContent = lines.filter((line) => !line.includes(TOOL_RESULT_SPILL.NOTICE_MARKER)).join('\n');
  }
  const withSpillNotice = (compressed: string): string =>
    spillNotice ? `${compressed}\n${spillNotice}` : compressed;

  // Special handling for read_xlsx results: preserve schema + sample rows + hint
  const xlsxCompressed = compressXlsxResult(compressibleContent, cfg.targetTokens);
  if (xlsxCompressed) {
    const finalContent = withSpillNotice(xlsxCompressed);
    const compressedTokens = estimateTokens(finalContent);
    const savedTokens = originalTokens - compressedTokens;
    logger.debug(`XLSX result compressed (schema-aware): ${originalTokens}→${compressedTokens} tokens (saved ${savedTokens})`);
    return {
      content: finalContent,
      compressed: true,
      savedTokens,
      compressionInfo: { originalTokens, compressedTokens },
    };
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

  const result = compressor.compressText(compressibleContent);

  if (result.wasCompressed) {
    const finalContent = withSpillNotice(result.content);
    const compressedTokens = estimateTokens(finalContent);
    logger.debug(`Tool result compressed: ${originalTokens}→${compressedTokens} tokens (saved ${originalTokens - compressedTokens})`);
    return {
      content: finalContent, // Keep original format, no header prepended
      compressed: true,
      savedTokens: originalTokens - compressedTokens,
      compressionInfo: {
        originalTokens,
        compressedTokens,
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
        if (part.type === 'image') {
          total += IMAGE_TOKEN_ESTIMATE;
        } else if (part.text) {
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
// Message History Shape and Pressure
// ----------------------------------------------------------------------------

export interface CompressedMessage {
  role: string;
  content: string;
  timestamp?: number;
  compressed?: boolean;
  /** Original message ID for index-safe compression */
  id?: string;
  /** tool 消息关联的 tool_call_id（保留配对关系，防止压缩后孤立） */
  toolCallId?: string;
  /** assistant 消息的 tool_call IDs（保留配对关系，防止压缩后孤立） */
  toolCallIds?: string[];
}

/**
 * Tracks the proactive context-pressure threshold used by message assembly.
 * Compression execution belongs to the unified compression architecture.
 */
export class MessageHistoryCompressor {
  /** Threshold ratio for proactive compression (default: 75%) */
  private proactiveCompressionThreshold = 0.75;

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
}

// ----------------------------------------------------------------------------
// Re-exports for convenience
// ----------------------------------------------------------------------------

export { estimateTokens, analyzeContent } from './tokenEstimator';
export { ContextCompressor } from './compressor';
