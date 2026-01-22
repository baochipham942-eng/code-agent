// ============================================================================
// Token Estimator - Estimate token counts for different content types
// ============================================================================
// Provides multi-dimensional token estimation optimized for:
// - Chinese text (~2.0 chars/token)
// - English text (~3.5 chars/token)
// - Code (~3.0 chars/token)
// - Mixed content (weighted average)
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('TokenEstimator');

/**
 * Character-to-token ratios for different content types
 * Based on empirical analysis of Claude tokenization
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
  CODE: /^(import|export|const|let|var|function|class|interface|type|def|async|await|return|if|else|for|while|switch|case|try|catch|throw|new|this|self|public|private|protected|static|readonly|abstract|extends|implements|=>|===|!==|&&|\|\|)\b|[{}\[\]();:,.<>]/gm,
  /** Markdown indicators */
  MARKDOWN: /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|```|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|!\[.*\]\(.*\)|\[.*\]\(.*\)/gm,
  /** JSON indicators */
  JSON: /^\s*[{\["]|":\s*[{\["0-9tfn]|^\s*}|^\s*]/gm,
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

  let primaryType: ContentAnalysis['primaryType'] = 'english';
  let confidence = 0.5;

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
 * Estimate token count for a text string
 *
 * @param text - Text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  const analysis = analyzeContent(text);
  const { totalChars, cjkChars, codeChars, whitespaceChars, specialChars, primaryType } = analysis;

  // Calculate weighted token estimate based on content composition
  let tokens = 0;

  // CJK characters: ~2 chars per token
  tokens += cjkChars / TOKEN_RATIOS.CJK;

  // Remaining characters based on primary type
  const nonCjkChars = totalChars - cjkChars;

  if (nonCjkChars > 0) {
    let ratio: number;

    switch (primaryType) {
      case 'code':
        ratio = TOKEN_RATIOS.CODE;
        break;
      case 'json':
        ratio = TOKEN_RATIOS.JSON;
        break;
      case 'markdown':
        ratio = TOKEN_RATIOS.MARKDOWN;
        break;
      default:
        ratio = TOKEN_RATIOS.ENGLISH;
    }

    // Adjust for whitespace (whitespace-heavy content has higher ratio)
    const whitespaceRatio = whitespaceChars / nonCjkChars;
    if (whitespaceRatio > 0.2) {
      ratio = ratio * (1 + whitespaceRatio * 0.3);
    }

    // Special characters often become individual tokens
    tokens += nonCjkChars / ratio;
    tokens += specialChars * 0.1; // Small adjustment for special chars
  }

  return Math.ceil(tokens);
}

/**
 * Message structure for estimation
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Estimate tokens for a single message including role overhead
 *
 * @param message - Message to estimate
 * @returns Token estimate including role overhead
 */
export function estimateMessageTokens(message: Message): number {
  // Role token overhead (role name, formatting)
  const roleOverhead = {
    user: 4,
    assistant: 4,
    system: 4,
  };

  const contentTokens = estimateTokens(message.content);
  return contentTokens + roleOverhead[message.role];
}

/**
 * Estimate tokens for a conversation
 *
 * @param messages - Array of messages
 * @returns Total token estimate
 */
export function estimateConversationTokens(messages: Message[]): number {
  // Base overhead for conversation structure
  const baseOverhead = 3;

  const messageTokens = messages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg),
    0
  );

  return baseOverhead + messageTokens;
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

  let ratio = TOKEN_RATIOS.ENGLISH;
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
