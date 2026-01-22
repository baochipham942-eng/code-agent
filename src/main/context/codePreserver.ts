// ============================================================================
// Code Preserver - Intelligent code block preservation during compression
// ============================================================================
// Identifies code block boundaries, protects complete code blocks during
// compression, and preserves recent code modifications.
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { estimateTokens } from './tokenEstimator';

const logger = createLogger('CodePreserver');

/**
 * Code block with metadata
 */
export interface CodeBlock {
  /** Unique identifier */
  id: string;
  /** Programming language */
  language: string;
  /** Code content (without fences) */
  content: string;
  /** Start position in original text */
  startPos: number;
  /** End position in original text */
  endPos: number;
  /** Estimated token count */
  tokens: number;
  /** Whether this block was recently modified */
  isRecent: boolean;
  /** Importance score (higher = more important to preserve) */
  importance: number;
  /** File path if associated with a file */
  filePath?: string;
}

/**
 * Code preservation options
 */
export interface PreservationOptions {
  /** Maximum tokens to allocate for code */
  maxCodeTokens: number;
  /** Minimum importance score to preserve (0-1) */
  minImportance?: number;
  /** Number of recent blocks to always preserve */
  preserveRecentCount?: number;
  /** File paths that are high priority */
  priorityFiles?: string[];
}

/**
 * Preservation result
 */
export interface PreservationResult {
  /** Preserved code blocks */
  preserved: CodeBlock[];
  /** Removed code blocks */
  removed: CodeBlock[];
  /** Total tokens in preserved blocks */
  preservedTokens: number;
  /** Total tokens in removed blocks */
  removedTokens: number;
}

/**
 * Parse code blocks from text
 */
export function parseCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;

  let match;
  let index = 0;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const content = match[2].trim();
    const tokens = estimateTokens(content);

    blocks.push({
      id: `block_${index}`,
      language: match[1] || detectLanguage(content),
      content,
      startPos: match.index,
      endPos: match.index + match[0].length,
      tokens,
      isRecent: false,
      importance: calculateImportance(content, match[1]),
    });

    index++;
  }

  return blocks;
}

/**
 * Detect programming language from code content
 */
function detectLanguage(code: string): string {
  const indicators: Record<string, RegExp[]> = {
    typescript: [/^import\s+.*from\s+['"]/, /:\s*(string|number|boolean|void)/, /interface\s+\w+/],
    javascript: [/^const\s+\w+\s*=/, /function\s*\w*\s*\(/, /=>\s*{/],
    python: [/^def\s+\w+\s*\(/, /^import\s+\w+$/, /^from\s+\w+\s+import/],
    rust: [/^fn\s+\w+/, /^use\s+\w+/, /let\s+mut\s+/],
    go: [/^func\s+\w+/, /^package\s+\w+/, /^import\s+\(/],
    java: [/^public\s+class/, /^private\s+\w+/, /System\.out\.println/],
    cpp: [/^#include\s+</, /std::/, /int\s+main\s*\(/],
    html: [/^<(!DOCTYPE|html|head|body)/, /<\/\w+>$/],
    css: [/^\.\w+\s*{/, /^#\w+\s*{/, /:\s*\d+px/],
    sql: [/^SELECT\s+/i, /^INSERT\s+INTO/i, /^CREATE\s+TABLE/i],
    bash: [/^#!/, /^\$\s+/, /^echo\s+/],
    json: [/^\s*{/, /^\s*\[/, /"\w+":\s*/],
  };

  for (const [lang, patterns] of Object.entries(indicators)) {
    const matches = patterns.filter(p => p.test(code)).length;
    if (matches >= 2) return lang;
  }

  return 'text';
}

/**
 * Calculate importance score for a code block
 */
function calculateImportance(content: string, language: string): number {
  let score = 0.5; // Base score

  // Length factor (longer code is often more important)
  const lines = content.split('\n').length;
  if (lines > 20) score += 0.1;
  if (lines > 50) score += 0.1;

  // Language factor (some languages are typically more critical)
  const highPriorityLangs = ['typescript', 'javascript', 'python', 'rust', 'go'];
  if (highPriorityLangs.includes(language)) score += 0.1;

  // Content indicators
  if (/^(import|export|from)\s/m.test(content)) score += 0.05; // Has imports
  if (/^(class|interface|type|struct)\s/m.test(content)) score += 0.1; // Definitions
  if (/^(function|async function|const \w+ = )/m.test(content)) score += 0.1; // Functions
  if (/^(describe|it|test|expect)\(/m.test(content)) score += 0.1; // Tests
  if (/TODO|FIXME|HACK|BUG/i.test(content)) score += 0.05; // Has todos

  // Penalize very short snippets
  if (lines < 3) score -= 0.2;

  return Math.max(0, Math.min(1, score));
}

/**
 * Mark recent code blocks based on modification timestamps
 */
export function markRecentBlocks(
  blocks: CodeBlock[],
  recentContent: string[],
  recentCount: number = 3
): CodeBlock[] {
  // Simple approach: check if block content appears in recent content
  const recentSet = new Set(recentContent.map(c => c.trim()));

  return blocks.map((block, index) => ({
    ...block,
    isRecent: recentSet.has(block.content.trim()) || index >= blocks.length - recentCount,
  }));
}

/**
 * Associate code blocks with file paths
 */
export function associateWithFiles(
  blocks: CodeBlock[],
  fileContext: Array<{ path: string; content: string }>
): CodeBlock[] {
  return blocks.map(block => {
    // Find matching file
    const matchingFile = fileContext.find(f =>
      f.content.includes(block.content.substring(0, 100))
    );

    return {
      ...block,
      filePath: matchingFile?.path,
      importance: matchingFile
        ? block.importance + 0.1 // Boost importance if associated with a file
        : block.importance,
    };
  });
}

/**
 * Select code blocks to preserve within token budget
 */
export function selectBlocksToPreserve(
  blocks: CodeBlock[],
  options: PreservationOptions
): PreservationResult {
  const {
    maxCodeTokens,
    minImportance = 0.3,
    preserveRecentCount = 2,
    priorityFiles = [],
  } = options;

  // Sort blocks by priority
  const sortedBlocks = [...blocks].sort((a, b) => {
    // Recent blocks first
    if (a.isRecent !== b.isRecent) return a.isRecent ? -1 : 1;

    // Priority files next
    const aPriority = priorityFiles.some(f => a.filePath?.includes(f));
    const bPriority = priorityFiles.some(f => b.filePath?.includes(f));
    if (aPriority !== bPriority) return aPriority ? -1 : 1;

    // Then by importance
    return b.importance - a.importance;
  });

  const preserved: CodeBlock[] = [];
  const removed: CodeBlock[] = [];
  let usedTokens = 0;
  let recentPreserved = 0;

  for (const block of sortedBlocks) {
    // Always preserve recent blocks up to limit
    if (block.isRecent && recentPreserved < preserveRecentCount) {
      if (usedTokens + block.tokens <= maxCodeTokens) {
        preserved.push(block);
        usedTokens += block.tokens;
        recentPreserved++;
        continue;
      }
    }

    // Check importance threshold
    if (block.importance < minImportance) {
      removed.push(block);
      continue;
    }

    // Check token budget
    if (usedTokens + block.tokens <= maxCodeTokens) {
      preserved.push(block);
      usedTokens += block.tokens;
    } else {
      removed.push(block);
    }
  }

  return {
    preserved,
    removed,
    preservedTokens: usedTokens,
    removedTokens: removed.reduce((sum, b) => sum + b.tokens, 0),
  };
}

/**
 * Reconstruct text with preserved code blocks
 */
export function reconstructWithPreservedCode(
  originalText: string,
  preservationResult: PreservationResult
): string {
  const { preserved, removed } = preservationResult;

  if (removed.length === 0) {
    return originalText;
  }

  let result = originalText;

  // Sort removed blocks by position (descending) to replace from end
  const sortedRemoved = [...removed].sort((a, b) => b.startPos - a.startPos);

  for (const block of sortedRemoved) {
    const placeholder = `\n[Code block removed: ${block.language}, ${block.tokens} tokens]\n`;
    result =
      result.substring(0, block.startPos) +
      placeholder +
      result.substring(block.endPos);
  }

  return result;
}

/**
 * Code Preserver class for stateful preservation
 */
export class CodePreserver {
  private recentBlocks: string[] = [];
  private maxRecentHistory: number;

  constructor(maxRecentHistory: number = 10) {
    this.maxRecentHistory = maxRecentHistory;
  }

  /**
   * Record a code block as recently used/modified
   */
  recordRecentBlock(content: string): void {
    this.recentBlocks.unshift(content.trim());
    if (this.recentBlocks.length > this.maxRecentHistory) {
      this.recentBlocks.pop();
    }
  }

  /**
   * Process text and preserve important code blocks
   */
  preserveCode(text: string, options: PreservationOptions): {
    text: string;
    result: PreservationResult;
  } {
    // Parse code blocks
    let blocks = parseCodeBlocks(text);

    // Mark recent blocks
    blocks = markRecentBlocks(blocks, this.recentBlocks, options.preserveRecentCount);

    // Select blocks to preserve
    const result = selectBlocksToPreserve(blocks, options);

    // Reconstruct text
    const processedText = reconstructWithPreservedCode(text, result);

    return {
      text: processedText,
      result,
    };
  }

  /**
   * Get statistics about code blocks in text
   */
  analyzeCodeContent(text: string): {
    totalBlocks: number;
    totalCodeTokens: number;
    languages: Record<string, number>;
    averageImportance: number;
  } {
    const blocks = parseCodeBlocks(text);

    const languages: Record<string, number> = {};
    for (const block of blocks) {
      languages[block.language] = (languages[block.language] || 0) + 1;
    }

    return {
      totalBlocks: blocks.length,
      totalCodeTokens: blocks.reduce((sum, b) => sum + b.tokens, 0),
      languages,
      averageImportance: blocks.length > 0
        ? blocks.reduce((sum, b) => sum + b.importance, 0) / blocks.length
        : 0,
    };
  }

  /**
   * Clear recent block history
   */
  clearHistory(): void {
    this.recentBlocks = [];
  }
}
