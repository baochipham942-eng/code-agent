// ============================================================================
// Token Estimator - Real BPE token counting for different content types
// ============================================================================
// Uses gpt-tokenizer (BPE) for accurate token counts.
// Accuracy: <1% error vs heuristic 10-30% error.
// ============================================================================

import { encode } from 'gpt-tokenizer';
import type { Message as SharedMessage, MessageAttachment } from '@shared/contract/message';

// LRU cache for token counts (avoids re-encoding identical content)
const TOKEN_CACHE_MAX = 200;
const EXACT_TOKENIZATION_MAX_CHARS = 50_000;
const tokenCache = new Map<number, number>();

/** Conservative fallback for providers/models whose visual detail mode is unknown. */
const IMAGE_TOKEN_ESTIMATE = 1600;

type ImageDimensions = { width: number; height: number };

function decodeImageHeader(data: string | undefined): Buffer | undefined {
  if (!data) return undefined;
  const base64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
  try {
    return Buffer.from(base64, 'base64');
  } catch {
    return undefined;
  }
}

/** Read dimensions from the common inline formats without decoding pixels. */
function readInlineImageDimensions(data: string | undefined): ImageDimensions | undefined {
  const buffer = decodeImageHeader(data);
  if (!buffer || buffer.length < 10) return undefined;
  // PNG signature + IHDR.
  if (buffer.length >= 24 && buffer.subarray(1, 4).toString('ascii') === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // GIF logical screen descriptor.
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  // JPEG SOF markers.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2) break;
      offset += 2 + segmentLength;
    }
  }
  return undefined;
}

export function estimateImageTokens(
  attachment: Pick<MessageAttachment, 'data'>,
  provider?: string,
  model?: string,
): number {
  const dimensions = readInlineImageDimensions(attachment.data);
  if (!dimensions) return IMAGE_TOKEN_ESTIMATE;
  const providerId = String(provider ?? '').toLowerCase();
  const modelId = String(model ?? '').toLowerCase();
  if (
    providerId === 'claude'
    || providerId === 'anthropic'
    || modelId.includes('anthropic/')
    || modelId.includes('claude')
  ) {
    return Math.ceil(dimensions.width / 28) * Math.ceil(dimensions.height / 28);
  }
  if (providerId === 'gemini' || modelId.includes('google/') || modelId.includes('gemini')) {
    // Gemini accounts large images as 258-token tiles. A 512px logical stride
    // is the conservative request-side approximation for 768px crops.
    const tiles = Math.ceil(dimensions.width / 512) * Math.ceil(dimensions.height / 512);
    return Math.max(258, tiles * 258);
  }
  // OpenAI varies by model family and implicit detail mode; use the
  // conservative fallback until the request carries an explicit detail value.
  return IMAGE_TOKEN_ESTIMATE;
}

function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Character-to-token ratios for different content types.
 * @deprecated Real BPE tokenization via `encode()` is now used in
 * `estimateTokens()`. These ratios are kept for backward compatibility
 * and are still used internally by `estimateTokensDetailed()`.
 */
export const TOKEN_RATIOS = {
  /** Chinese/Japanese/Korean characters */
  CJK: 2.0,
  /** Standard English text */
  ENGLISH: 3.5,
  /** Source code */
  CODE: 3.0,
  /** Markdown formatting */
  MARKDOWN: 3.2,
  /** JSON/structured data */
  JSON: 2.5,
  /** Whitespace-heavy content */
  WHITESPACE: 4.0,
} as const;

/**
 * Patterns for content type detection
 */
const PATTERNS = {
  /** CJK characters (Chinese, Japanese, Korean) */
  CJK: /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g,
  /** Code indicators */
  CODE: /^(import|export|const|let|var|function|class|interface|type|def|async|await|return|if|else|for|while|switch|case|try|catch|throw|new|this|self|public|private|protected|static|readonly|abstract|extends|implements|=>|===|!==|&&|\|\|)\b|[{}[\]();:,.<>]/gm,
  /** Markdown indicators */
  MARKDOWN: /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|```|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|!\[.*\]\(.*\)|\[.*\]\(.*\)/gm,
  /** JSON indicators */
  JSON: /^\s*[{["]|":\s*[{["0-9tfn]|^\s*}|^\s*]/gm,
  /** Special characters that often become single tokens */
  SPECIAL_CHARS: /[{}[\]().,;:!?<>@#$%^&*+=|\\/"'`~]/g,
};

/**
 * Content type analysis result
 */
export interface ContentAnalysis {
  /** Total character count */
  totalChars: number;
  /** CJK character count */
  cjkChars: number;
  /** Code-like character count */
  codeChars: number;
  /** Whitespace character count */
  whitespaceChars: number;
  /** Special character count */
  specialChars: number;
  /** Detected primary content type */
  primaryType: 'cjk' | 'code' | 'markdown' | 'json' | 'english';
  /** Confidence score (0-1) */
  confidence: number;
}

/**
 * Analyze content to determine its type and characteristics
 */
export function analyzeContent(text: string): ContentAnalysis {
  const totalChars = text.length;

  if (totalChars === 0) {
    return {
      totalChars: 0,
      cjkChars: 0,
      codeChars: 0,
      whitespaceChars: 0,
      specialChars: 0,
      primaryType: 'english',
      confidence: 1,
    };
  }

  // Count CJK characters
  const cjkMatches = text.match(PATTERNS.CJK) || [];
  const cjkChars = cjkMatches.length;

  // Count code indicators
  const codeMatches = text.match(PATTERNS.CODE) || [];
  const codeChars = codeMatches.join('').length;

  // Count whitespace
  const whitespaceChars = (text.match(/\s/g) || []).length;

  // Count special characters
  const specialChars = (text.match(PATTERNS.SPECIAL_CHARS) || []).length;

  // Determine primary type
  const cjkRatio = cjkChars / totalChars;
  const codeRatio = codeChars / totalChars;
  const markdownMatches = text.match(PATTERNS.MARKDOWN) || [];
  const jsonMatches = text.match(PATTERNS.JSON) || [];

  let primaryType: ContentAnalysis['primaryType'];
  let confidence: number;

  if (cjkRatio > 0.3) {
    primaryType = 'cjk';
    confidence = Math.min(cjkRatio * 2, 1);
  } else if (codeRatio > 0.15 || (specialChars / totalChars > 0.1 && codeMatches.length > 5)) {
    primaryType = 'code';
    confidence = Math.min(codeRatio * 3, 1);
  } else if (jsonMatches.length > 3 && text.trim().startsWith('{') || text.trim().startsWith('[')) {
    primaryType = 'json';
    confidence = 0.8;
  } else if (markdownMatches.length > 2) {
    primaryType = 'markdown';
    confidence = 0.7;
  } else {
    primaryType = 'english';
    confidence = 0.6;
  }

  return {
    totalChars,
    cjkChars,
    codeChars,
    whitespaceChars,
    specialChars,
    primaryType,
    confidence,
  };
}

/**
 * Count tokens for a text string.
 * Uses gpt-tokenizer (cl100k_base) for normal inputs with LRU cache.
 * Very large strings use the fast analyzer to avoid pathological BPE costs.
 *
 * @param text - Text to count tokens for
 * @returns Token count estimate
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Prompt registry values can be live string-like proxies. Materialize once so
  // hashing/tokenization does not rebuild the full prompt for every character.
  const normalizedText = typeof text === 'string' ? text : String(text);
  if (!normalizedText) return 0;

  // LRU cache lookup
  const hash = simpleHash(normalizedText);
  const cached = tokenCache.get(hash);
  if (cached !== undefined) {
    // Move to end (most recent) for LRU ordering
    tokenCache.delete(hash);
    tokenCache.set(hash, cached);
    return cached;
  }

  const tokens = normalizedText.length > EXACT_TOKENIZATION_MAX_CHARS
    ? estimateTokensDetailed(normalizedText).total
    : encode(normalizedText).length;

  // Store in LRU cache, evict oldest entry if at capacity
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const firstKey = tokenCache.keys().next().value;
    if (firstKey !== undefined) tokenCache.delete(firstKey);
  }
  tokenCache.set(hash, tokens);

  return tokens;
}

/**
 * Message structure for estimation.
 *
 * Narrow projection of the shared contract Message — token estimation only
 * needs `role` + `content`. Defined as a Pick of the canonical type so that
 * any drift in the shared contract surfaces here at the type level.
 */
export type Message = Pick<SharedMessage, 'role' | 'content' | 'attachments'>;

/**
 * Estimate tokens for a single message including role overhead
 *
 * @param message - Message to estimate
 * @returns Token estimate including role overhead
 */
export function estimateMessageTokens(message: Message, provider?: string, model?: string): number {
  // Role token overhead (role name, formatting). All roles use 4 tokens
  // (matches the OpenAI cookbook overhead model).
  const roleOverhead: Record<SharedMessage['role'], number> = {
    user: 4,
    assistant: 4,
    system: 4,
    tool: 4,
  };

  const contentTokens = estimateTokens(message.content);
  const imageTokens = (message.attachments ?? [])
    .filter((attachment) => attachment.type === 'image' || attachment.category === 'image')
    .reduce((sum, attachment) => sum + estimateImageTokens(attachment, provider, model), 0);
  return contentTokens + imageTokens + roleOverhead[message.role];
}

/**
 * Estimate tokens for a conversation
 *
 * @param messages - Array of messages
 * @returns Total token estimate
 */
export function estimateConversationTokens(messages: Message[], provider?: string, model?: string): number {
  // Base overhead for conversation structure
  const baseOverhead = 3;

  const messageTokens = messages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg, provider, model),
    0
  );

  return baseOverhead + messageTokens;
}

/**
 * Count tokens for an array of messages with per-message overhead.
 * More accurate than `estimateConversationTokens` — uses real BPE counts.
 *
 * Overhead model (matches OpenAI cookbook):
 *   - 3 base tokens for the conversation envelope
 *   - 4 tokens per message for role + formatting
 *
 * @param messages - Array of messages
 * @returns Total BPE token count including overhead
 */
export function countTokensExact(messages: Message[]): number {
  let total = 3; // base overhead for conversation envelope
  for (const msg of messages) {
    total += 4; // role overhead per message
    total += estimateTokens(msg.content);
  }
  return total;
}

/**
 * Token budget tracking
 */
export interface TokenBudget {
  /** Maximum allowed tokens */
  limit: number;
  /** Currently used tokens */
  used: number;
  /** Available tokens */
  available: number;
  /** Usage percentage (0-100) */
  usagePercent: number;
  /** Whether budget is exceeded */
  exceeded: boolean;
}

/**
 * Calculate token budget status
 *
 * @param used - Tokens used
 * @param limit - Token limit
 * @returns Budget status
 */
export function calculateBudget(used: number, limit: number): TokenBudget {
  const available = Math.max(0, limit - used);
  const usagePercent = (used / limit) * 100;

  return {
    limit,
    used,
    available,
    usagePercent: Math.round(usagePercent * 10) / 10,
    exceeded: used > limit,
  };
}

/**
 * Estimate tokens and provide detailed breakdown
 */
export interface TokenEstimateResult {
  /** Total estimated tokens */
  total: number;
  /** Content analysis */
  analysis: ContentAnalysis;
  /** Tokens by component */
  breakdown: {
    cjk: number;
    nonCjk: number;
    overhead: number;
  };
}

/**
 * Get detailed token estimate with breakdown
 *
 * @param text - Text to estimate
 * @returns Detailed estimation result
 */
export function estimateTokensDetailed(text: string): TokenEstimateResult {
  const analysis = analyzeContent(text);
  const { cjkChars, totalChars, primaryType } = analysis;

  const cjkTokens = Math.ceil(cjkChars / TOKEN_RATIOS.CJK);
  const nonCjkChars = totalChars - cjkChars;

  let ratio: number = TOKEN_RATIOS.ENGLISH;
  switch (primaryType) {
    case 'code': ratio = TOKEN_RATIOS.CODE; break;
    case 'json': ratio = TOKEN_RATIOS.JSON; break;
    case 'markdown': ratio = TOKEN_RATIOS.MARKDOWN; break;
  }

  const nonCjkTokens = Math.ceil(nonCjkChars / ratio);
  const overhead = Math.ceil(analysis.specialChars * 0.1);

  return {
    total: cjkTokens + nonCjkTokens + overhead,
    analysis,
    breakdown: {
      cjk: cjkTokens,
      nonCjk: nonCjkTokens,
      overhead,
    },
  };
}

/**
 * Check if content fits within a token budget
 *
 * @param text - Text to check
 * @param budget - Token budget
 * @returns Whether content fits and how much room remains
 */
export function fitsInBudget(
  text: string,
  budget: number
): { fits: boolean; tokens: number; remaining: number } {
  const tokens = estimateTokens(text);
  return {
    fits: tokens <= budget,
    tokens,
    remaining: budget - tokens,
  };
}

/**
 * Truncate text to fit within a token budget
 *
 * @param text - Text to truncate
 * @param maxTokens - Maximum tokens allowed
 * @returns Truncated text
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const currentTokens = estimateTokens(text);

  if (currentTokens <= maxTokens) {
    return text;
  }

  // Binary search for the right length
  let low = 0;
  let high = text.length;
  let result = '';

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const truncated = text.substring(0, mid);
    const tokens = estimateTokens(truncated);

    if (tokens <= maxTokens) {
      result = truncated;
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  // Add ellipsis if truncated
  if (result.length < text.length) {
    // Find a good break point (word boundary or newline)
    const breakPoints = [
      result.lastIndexOf('\n'),
      result.lastIndexOf('. '),
      result.lastIndexOf(' '),
    ];

    for (const bp of breakPoints) {
      if (bp > result.length * 0.8) {
        result = result.substring(0, bp);
        break;
      }
    }

    result = result.trimEnd() + '...';
  }

  return result;
}
