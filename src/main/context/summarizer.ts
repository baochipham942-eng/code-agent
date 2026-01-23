// ============================================================================
// AI Summarizer - Generate intelligent summaries of conversation context
// ============================================================================
// Provides AI-powered summarization with:
// - Key information extraction (decisions, action items, code references)
// - Configurable summary length and detail level
// - Structured output with preserved context
// - Fallback to extractive summarization when AI unavailable
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { estimateTokens, Message } from './tokenEstimator';
import { parseCodeBlocks, CodeBlock } from './codePreserver';

const logger = createLogger('AISummarizer');

/**
 * Summary detail level
 */
export type SummaryDetailLevel = 'brief' | 'standard' | 'detailed';

/**
 * Extracted key information from conversation
 */
export interface ExtractedInfo {
  /** Key decisions made */
  decisions: string[];
  /** Action items identified */
  actionItems: string[];
  /** Code files referenced */
  codeReferences: Array<{ file: string; description: string }>;
  /** Important topics discussed */
  topics: string[];
  /** Errors or issues mentioned */
  issues: string[];
  /** Questions asked or pending */
  questions: string[];
}

/**
 * Summary result
 */
export interface SummaryResult {
  /** The generated summary text */
  summary: string;
  /** Token count of the summary */
  tokens: number;
  /** Key information extracted */
  extractedInfo: ExtractedInfo;
  /** Code blocks preserved */
  preservedCodeBlocks: CodeBlock[];
  /** Whether AI summarization was used */
  usedAI: boolean;
  /** Original token count */
  originalTokens: number;
  /** Compression ratio achieved */
  compressionRatio: number;
}

/**
 * Summarizer options
 */
export interface SummarizerOptions {
  /** Target token count for summary */
  targetTokens: number;
  /** Detail level */
  detailLevel?: SummaryDetailLevel;
  /** Whether to preserve code blocks */
  preserveCodeBlocks?: boolean;
  /** Maximum code blocks to preserve */
  maxCodeBlocks?: number;
  /** AI summarization function (optional) */
  aiSummarize?: (prompt: string, maxTokens: number) => Promise<string>;
  /** Whether to extract structured info */
  extractInfo?: boolean;
}

/**
 * Default target tokens by detail level
 */
const DETAIL_LEVEL_TOKENS: Record<SummaryDetailLevel, number> = {
  brief: 200,
  standard: 500,
  detailed: 1000,
};

/**
 * Patterns for extracting key information
 */
const EXTRACTION_PATTERNS = {
  /** Decision indicators */
  decisions: [
    /(?:decided|decision|chose|will use|going with|selected|picked)\s*[:.]?\s*(.+?)(?:\.|$)/gi,
    /(?:let's|we'll|i'll|should)\s+(.+?)(?:\.|$)/gi,
  ],
  /** Action item indicators */
  actionItems: [
    /(?:TODO|FIXME|ACTION|TASK)[:.]?\s*(.+?)(?:\.|$)/gi,
    /(?:need to|must|should|have to|will)\s+(.+?)(?:\.|$)/gi,
    /(?:next step|next,|then)\s*[:.]?\s*(.+?)(?:\.|$)/gi,
  ],
  /** Question indicators */
  questions: [
    /(?:^|\s)(.+?\?)\s*$/gm,
    /(?:wondering|unsure|unclear|question)[:.]?\s*(.+?)(?:\.|$)/gi,
  ],
  /** Issue/error indicators */
  issues: [
    /(?:error|bug|issue|problem|failed|failing|broken)[:.]?\s*(.+?)(?:\.|$)/gi,
    /(?:doesn't work|not working|can't|cannot|unable to)\s*(.+?)(?:\.|$)/gi,
  ],
  /** File path patterns */
  filePaths: [
    /(?:^|[\s`])([a-zA-Z0-9_\-./]+\.(ts|js|tsx|jsx|py|rs|go|java|cpp|c|h|md|json|yaml|yml|toml|sh|bash|css|scss|html|xml|sql))(?:[\s`]|$)/g,
    /(?:file|path|in)\s+[`"]?([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)[`"]?/gi,
  ],
};

/**
 * Extract key information from text
 */
export function extractKeyInfo(text: string): ExtractedInfo {
  const info: ExtractedInfo = {
    decisions: [],
    actionItems: [],
    codeReferences: [],
    topics: [],
    issues: [],
    questions: [],
  };

  // Extract decisions
  for (const pattern of EXTRACTION_PATTERNS.decisions) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const decision = match[1].trim();
      if (decision.length > 10 && decision.length < 200 && !info.decisions.includes(decision)) {
        info.decisions.push(decision);
      }
    }
  }

  // Extract action items
  for (const pattern of EXTRACTION_PATTERNS.actionItems) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const item = match[1].trim();
      if (item.length > 5 && item.length < 150 && !info.actionItems.includes(item)) {
        info.actionItems.push(item);
      }
    }
  }

  // Extract questions
  for (const pattern of EXTRACTION_PATTERNS.questions) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const question = match[1].trim();
      if (question.length > 10 && question.length < 200 && !info.questions.includes(question)) {
        info.questions.push(question);
      }
    }
  }

  // Extract issues
  for (const pattern of EXTRACTION_PATTERNS.issues) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const issue = match[1].trim();
      if (issue.length > 10 && issue.length < 200 && !info.issues.includes(issue)) {
        info.issues.push(issue);
      }
    }
  }

  // Extract file references
  const seenFiles = new Set<string>();
  for (const pattern of EXTRACTION_PATTERNS.filePaths) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const file = match[1].trim();
      if (!seenFiles.has(file) && file.length > 3) {
        seenFiles.add(file);
        // Try to find context around the file reference
        const contextMatch = text.match(new RegExp(`(.{0,50}${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.{0,50})`, 'i'));
        info.codeReferences.push({
          file,
          description: contextMatch ? contextMatch[1].trim() : '',
        });
      }
    }
  }

  // Limit results
  info.decisions = info.decisions.slice(0, 5);
  info.actionItems = info.actionItems.slice(0, 10);
  info.questions = info.questions.slice(0, 5);
  info.issues = info.issues.slice(0, 5);
  info.codeReferences = info.codeReferences.slice(0, 10);

  return info;
}

/**
 * Extract topic keywords from text
 */
export function extractTopics(text: string): string[] {
  // Common technical terms to look for
  const technicalTerms = [
    'api', 'database', 'authentication', 'authorization', 'cache', 'config',
    'deploy', 'test', 'build', 'error', 'fix', 'bug', 'feature', 'refactor',
    'component', 'service', 'model', 'controller', 'route', 'middleware',
    'typescript', 'javascript', 'react', 'node', 'python', 'rust', 'go',
    'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'vercel', 'supabase',
    'git', 'github', 'ci', 'cd', 'pipeline', 'workflow', 'action',
    'security', 'performance', 'optimization', 'memory', 'cpu', 'latency',
  ];

  const lowerText = text.toLowerCase();
  const foundTopics: string[] = [];

  for (const term of technicalTerms) {
    if (lowerText.includes(term) && !foundTopics.includes(term)) {
      foundTopics.push(term);
    }
  }

  return foundTopics.slice(0, 10);
}

/**
 * Generate extractive summary (no AI)
 * Selects most important sentences based on keyword density
 */
export function generateExtractiveSummary(
  text: string,
  targetTokens: number
): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 20);

  if (sentences.length === 0) {
    return text.substring(0, targetTokens * 4); // Rough char estimate
  }

  // Score sentences by importance
  const importanceKeywords = [
    'important', 'key', 'main', 'critical', 'essential', 'note', 'remember',
    'decision', 'decided', 'conclusion', 'result', 'summary', 'finally',
    'error', 'fix', 'bug', 'issue', 'problem', 'solution', 'resolved',
    'created', 'added', 'updated', 'modified', 'deleted', 'removed',
    'implemented', 'completed', 'finished', 'done', 'working',
  ];

  const scoredSentences = sentences.map((sentence, index) => {
    let score = 0;
    const lowerSentence = sentence.toLowerCase();

    // Keyword scoring
    for (const keyword of importanceKeywords) {
      if (lowerSentence.includes(keyword)) {
        score += 2;
      }
    }

    // Position scoring (first and last sentences are often important)
    if (index < 3) score += 3 - index;
    if (index >= sentences.length - 2) score += 1;

    // Length scoring (prefer medium-length sentences)
    const words = sentence.split(/\s+/).length;
    if (words >= 10 && words <= 30) score += 1;

    // Code reference scoring
    if (/`[^`]+`/.test(sentence) || /\.[a-z]{2,4}\b/.test(sentence)) {
      score += 2;
    }

    return { sentence, score, index };
  });

  // Sort by score, then by original position
  scoredSentences.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  // Select sentences until we hit the token budget
  const selected: Array<{ sentence: string; index: number }> = [];
  let currentTokens = 0;

  for (const item of scoredSentences) {
    const sentenceTokens = estimateTokens(item.sentence);
    if (currentTokens + sentenceTokens <= targetTokens) {
      selected.push({ sentence: item.sentence, index: item.index });
      currentTokens += sentenceTokens;
    }
  }

  // Sort selected sentences by original order
  selected.sort((a, b) => a.index - b.index);

  return selected.map(s => s.sentence).join(' ');
}

/**
 * Build AI summarization prompt
 */
function buildSummarizationPrompt(
  text: string,
  options: SummarizerOptions,
  extractedInfo: ExtractedInfo
): string {
  const detailLevel = options.detailLevel || 'standard';

  let prompt = `Summarize the following conversation/text. `;

  switch (detailLevel) {
    case 'brief':
      prompt += `Be very concise (2-3 sentences). Focus only on the main outcome or decision.`;
      break;
    case 'standard':
      prompt += `Provide a balanced summary covering key points, decisions, and outcomes.`;
      break;
    case 'detailed':
      prompt += `Provide a comprehensive summary including context, decisions, action items, and technical details.`;
      break;
  }

  prompt += `\n\nKey information to preserve:\n`;

  if (extractedInfo.decisions.length > 0) {
    prompt += `- Decisions: ${extractedInfo.decisions.slice(0, 3).join('; ')}\n`;
  }
  if (extractedInfo.actionItems.length > 0) {
    prompt += `- Action items: ${extractedInfo.actionItems.slice(0, 3).join('; ')}\n`;
  }
  if (extractedInfo.issues.length > 0) {
    prompt += `- Issues: ${extractedInfo.issues.slice(0, 2).join('; ')}\n`;
  }

  prompt += `\nText to summarize:\n${text}`;

  return prompt;
}

/**
 * Format summary with structured sections
 */
function formatStructuredSummary(
  baseSummary: string,
  extractedInfo: ExtractedInfo,
  preservedCodeBlocks: CodeBlock[],
  options: SummarizerOptions
): string {
  const parts: string[] = [];

  // Main summary
  parts.push(baseSummary);

  // Add structured sections for detailed summaries
  if (options.detailLevel === 'detailed') {
    if (extractedInfo.decisions.length > 0) {
      parts.push('\n\n**Decisions:**');
      extractedInfo.decisions.forEach(d => parts.push(`- ${d}`));
    }

    if (extractedInfo.actionItems.length > 0) {
      parts.push('\n\n**Action Items:**');
      extractedInfo.actionItems.forEach(a => parts.push(`- ${a}`));
    }

    if (extractedInfo.issues.length > 0) {
      parts.push('\n\n**Issues:**');
      extractedInfo.issues.forEach(i => parts.push(`- ${i}`));
    }

    if (extractedInfo.codeReferences.length > 0) {
      parts.push('\n\n**Files Referenced:**');
      extractedInfo.codeReferences.slice(0, 5).forEach(r => {
        parts.push(`- \`${r.file}\``);
      });
    }
  }

  // Add preserved code blocks
  if (options.preserveCodeBlocks && preservedCodeBlocks.length > 0) {
    parts.push('\n\n**Key Code:**');
    preservedCodeBlocks.slice(0, options.maxCodeBlocks || 2).forEach(block => {
      parts.push(`\n\`\`\`${block.language}\n${block.content}\n\`\`\``);
    });
  }

  return parts.join('\n');
}

/**
 * Summarize a single text string
 */
export async function summarizeText(
  text: string,
  options: SummarizerOptions
): Promise<SummaryResult> {
  const originalTokens = estimateTokens(text);
  const targetTokens = options.targetTokens ||
    DETAIL_LEVEL_TOKENS[options.detailLevel || 'standard'];

  // If already within budget, return as-is
  if (originalTokens <= targetTokens) {
    return {
      summary: text,
      tokens: originalTokens,
      extractedInfo: options.extractInfo !== false ? extractKeyInfo(text) : emptyExtractedInfo(),
      preservedCodeBlocks: [],
      usedAI: false,
      originalTokens,
      compressionRatio: 1,
    };
  }

  // Extract key information
  const extractedInfo = options.extractInfo !== false
    ? extractKeyInfo(text)
    : emptyExtractedInfo();

  // Extract and preserve important code blocks
  const codeBlocks = options.preserveCodeBlocks !== false
    ? parseCodeBlocks(text)
    : [];

  // Sort code blocks by importance and select top ones
  const sortedCodeBlocks = [...codeBlocks]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, options.maxCodeBlocks || 3);

  // Calculate token budget for text (accounting for code blocks)
  const codeTokens = sortedCodeBlocks.reduce((sum, b) => sum + b.tokens + 10, 0);
  const textBudget = Math.max(targetTokens - codeTokens, targetTokens * 0.5);

  let summary: string;
  let usedAI = false;

  // Try AI summarization if available
  if (options.aiSummarize) {
    try {
      const prompt = buildSummarizationPrompt(text, options, extractedInfo);
      summary = await options.aiSummarize(prompt, Math.floor(textBudget));
      usedAI = true;
      logger.debug('AI summarization successful', { originalTokens, targetTokens });
    } catch (error) {
      logger.warn('AI summarization failed, falling back to extractive', { error });
      summary = generateExtractiveSummary(text, Math.floor(textBudget));
    }
  } else {
    // Use extractive summarization
    summary = generateExtractiveSummary(text, Math.floor(textBudget));
  }

  // Add extracted info topics
  extractedInfo.topics = extractTopics(text);

  // Format final summary
  const formattedSummary = formatStructuredSummary(
    summary,
    extractedInfo,
    sortedCodeBlocks,
    options
  );

  const finalTokens = estimateTokens(formattedSummary);

  return {
    summary: formattedSummary,
    tokens: finalTokens,
    extractedInfo,
    preservedCodeBlocks: sortedCodeBlocks,
    usedAI,
    originalTokens,
    compressionRatio: finalTokens / originalTokens,
  };
}

/**
 * Summarize an array of messages
 */
export async function summarizeConversation(
  messages: Message[],
  options: SummarizerOptions
): Promise<SummaryResult> {
  // Convert messages to text
  const conversationText = messages
    .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');

  return summarizeText(conversationText, options);
}

/**
 * Create empty extracted info object
 */
function emptyExtractedInfo(): ExtractedInfo {
  return {
    decisions: [],
    actionItems: [],
    codeReferences: [],
    topics: [],
    issues: [],
    questions: [],
  };
}

/**
 * AI Summarizer class for stateful summarization
 */
export class AISummarizer {
  private aiSummarize?: (prompt: string, maxTokens: number) => Promise<string>;
  private defaultOptions: Partial<SummarizerOptions>;

  constructor(options: {
    aiSummarize?: (prompt: string, maxTokens: number) => Promise<string>;
    defaultDetailLevel?: SummaryDetailLevel;
    defaultPreserveCodeBlocks?: boolean;
  } = {}) {
    this.aiSummarize = options.aiSummarize;
    this.defaultOptions = {
      detailLevel: options.defaultDetailLevel || 'standard',
      preserveCodeBlocks: options.defaultPreserveCodeBlocks ?? true,
      extractInfo: true,
    };
  }

  /**
   * Set AI summarization function
   */
  setAISummarizer(fn: (prompt: string, maxTokens: number) => Promise<string>): void {
    this.aiSummarize = fn;
  }

  /**
   * Summarize text
   */
  async summarize(
    text: string,
    options: Partial<SummarizerOptions> = {}
  ): Promise<SummaryResult> {
    return summarizeText(text, {
      targetTokens: options.targetTokens || DETAIL_LEVEL_TOKENS[options.detailLevel || 'standard'],
      ...this.defaultOptions,
      ...options,
      aiSummarize: options.aiSummarize || this.aiSummarize,
    });
  }

  /**
   * Summarize conversation
   */
  async summarizeMessages(
    messages: Message[],
    options: Partial<SummarizerOptions> = {}
  ): Promise<SummaryResult> {
    return summarizeConversation(messages, {
      targetTokens: options.targetTokens || DETAIL_LEVEL_TOKENS[options.detailLevel || 'standard'],
      ...this.defaultOptions,
      ...options,
      aiSummarize: options.aiSummarize || this.aiSummarize,
    });
  }

  /**
   * Quick summary (brief, no code blocks)
   */
  async quickSummary(text: string, targetTokens: number = 150): Promise<string> {
    const result = await this.summarize(text, {
      targetTokens,
      detailLevel: 'brief',
      preserveCodeBlocks: false,
      extractInfo: false,
    });
    return result.summary;
  }

  /**
   * Extract key information only (no summarization)
   */
  extractInfo(text: string): ExtractedInfo {
    return extractKeyInfo(text);
  }
}

/**
 * Default summarizer instance
 */
let defaultSummarizer: AISummarizer | null = null;

export function getDefaultSummarizer(): AISummarizer {
  if (!defaultSummarizer) {
    defaultSummarizer = new AISummarizer();
  }
  return defaultSummarizer;
}

/**
 * Initialize default summarizer with AI function
 */
export function initializeSummarizer(
  aiSummarize: (prompt: string, maxTokens: number) => Promise<string>
): AISummarizer {
  const summarizer = getDefaultSummarizer();
  summarizer.setAISummarizer(aiSummarize);
  return summarizer;
}
