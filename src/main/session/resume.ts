// ============================================================================
// Session Resume - Restore and continue previous sessions
// ============================================================================
// Enables resuming interrupted or archived sessions:
// - Restore full conversation context
// - Reconstruct tool execution state
// - Handle context window limits (summarization)
// - Support partial resume (from specific point)
// ============================================================================

import { createLogger } from '../services/infra/logger';
import {
  SessionLocalCache,
  CachedSession,
  CachedMessage,
  getDefaultCache,
} from './localCache';
import { estimateTokens, estimateConversationTokens, Message } from '../context/tokenEstimator';
import { summarizeConversation, SummaryResult, initializeSummarizerWithCompactModel } from '../context/summarizer';
import { compactModelSummarize, isCompactModelAvailable } from '../context/compactModel';

const logger = createLogger('SessionResume');

/**
 * Resume options
 */
export interface ResumeOptions {
  /** Maximum tokens for resumed context */
  maxContextTokens?: number;
  /** Number of recent messages to always include */
  preserveRecentMessages?: number;
  /** Whether to include system messages */
  includeSystemMessages?: boolean;
  /** Whether to summarize old messages if context is too large */
  allowSummarization?: boolean;
  /** Custom summarizer function */
  summarizer?: (text: string, maxTokens: number) => Promise<string>;
  /** Message index to resume from (default: continue from end) */
  fromMessageIndex?: number;
  /** Whether to include tool execution metadata */
  includeToolMetadata?: boolean;
  /** Filter messages by role */
  filterRoles?: Array<'user' | 'assistant' | 'system'>;
}

/**
 * Resumed session context
 */
export interface ResumedContext {
  /** Session ID */
  sessionId: string;
  /** Messages for the resumed session */
  messages: Message[];
  /** Summary of older messages (if summarization was applied) */
  summary?: string;
  /** Original session metadata */
  metadata: {
    /** Original session start time */
    originalStartTime: number;
    /** Total messages in original session */
    totalOriginalMessages: number;
    /** Messages included in resumed context */
    includedMessages: number;
    /** Messages summarized */
    summarizedMessages: number;
    /** Token count of resumed context */
    contextTokens: number;
    /** Whether summarization was applied */
    wasSummarized: boolean;
    /** Last activity time of original session */
    lastActivityTime: number;
  };
  /** Tool execution history (if requested) */
  toolHistory?: Array<{
    tool: string;
    input: unknown;
    output: unknown;
    timestamp: number;
    success: boolean;
  }>;
}

/**
 * Resume result
 */
export interface ResumeResult {
  /** Whether resume was successful */
  success: boolean;
  /** The resumed context */
  context?: ResumedContext;
  /** Error message if failed */
  error?: string;
  /** Warnings (non-fatal issues) */
  warnings?: string[];
}

/**
 * Convert cached messages to Message format
 */
function toMessages(cachedMessages: CachedMessage[]): Message[] {
  return cachedMessages.map(m => ({
    role: m.role,
    content: m.content,
  }));
}

/**
 * Resume a session with context management
 */
export async function resumeSession(
  sessionId: string,
  options: ResumeOptions = {},
  cache: SessionLocalCache = getDefaultCache()
): Promise<ResumeResult> {
  const {
    maxContextTokens = 100000,
    preserveRecentMessages = 10,
    includeSystemMessages = true,
    allowSummarization = true,
    summarizer,
    fromMessageIndex,
    includeToolMetadata = false,
    filterRoles,
  } = options;

  const warnings: string[] = [];

  try {
    // Get session from cache
    const session = cache.getSession(sessionId);
    if (!session) {
      return {
        success: false,
        error: `Session "${sessionId}" not found`,
      };
    }

    // Determine message range
    const endIndex = session.messages.length;
    const startIndex = fromMessageIndex !== undefined
      ? Math.max(0, fromMessageIndex)
      : 0;

    if (startIndex >= endIndex) {
      return {
        success: false,
        error: `Invalid message index: ${startIndex}. Session has ${endIndex} messages.`,
      };
    }

    // Filter messages
    let relevantMessages = session.messages.slice(startIndex, endIndex);

    // Apply role filter if specified
    if (filterRoles && filterRoles.length > 0) {
      relevantMessages = relevantMessages.filter(m => filterRoles.includes(m.role));
    }

    // Remove system messages if not wanted
    if (!includeSystemMessages) {
      relevantMessages = relevantMessages.filter(m => m.role !== 'system');
    }

    // Convert to Message format
    let messages = toMessages(relevantMessages);
    let summarizedMessages = 0;
    let summary: string | undefined;

    // Check if context exceeds limits
    const totalTokens = estimateConversationTokens(messages);

    if (totalTokens > maxContextTokens) {
      logger.debug('Context exceeds limit, applying compression', {
        totalTokens,
        maxContextTokens,
      });

      if (allowSummarization) {
        // Separate recent messages to preserve
        const recentCount = Math.min(preserveRecentMessages, messages.length);
        const recentMessages = messages.slice(-recentCount);
        const olderMessages = messages.slice(0, -recentCount);

        if (olderMessages.length > 0) {
          // Calculate token budget for summary
          const recentTokens = estimateConversationTokens(recentMessages);
          const summaryBudget = Math.max(
            maxContextTokens - recentTokens - 500, // Buffer for summary wrapper
            1000 // Minimum summary budget
          );

          // Generate summary using compact model if available
          // Compact model is cheap and fast, ideal for summarization
          const aiSummarizer = summarizer || (isCompactModelAvailable() ? compactModelSummarize : undefined);

          const summaryResult: SummaryResult = await summarizeConversation(
            olderMessages,
            {
              targetTokens: summaryBudget,
              detailLevel: 'standard',
              preserveCodeBlocks: true,
              aiSummarize: aiSummarizer,
            }
          );

          summary = summaryResult.summary;
          summarizedMessages = olderMessages.length;

          // Create summary message
          const summaryMessage: Message = {
            role: 'system',
            content: `[Previous conversation summary (${summarizedMessages} messages)]\n\n${summary}`,
          };

          // Combine summary with recent messages
          messages = [summaryMessage, ...recentMessages];

          logger.debug('Applied summarization', {
            summarizedMessages,
            summaryTokens: summaryResult.tokens,
            recentMessages: recentCount,
          });
        }
      } else {
        // Simple truncation: keep recent messages
        const tokensPerMessage = totalTokens / messages.length;
        const messagesToKeep = Math.floor(maxContextTokens / tokensPerMessage);
        const truncateCount = messages.length - messagesToKeep;

        if (truncateCount > 0) {
          messages = messages.slice(-messagesToKeep);
          warnings.push(
            `Truncated ${truncateCount} older messages to fit context limit. Consider enabling summarization.`
          );
        }
      }
    }

    // Extract tool history if requested
    let toolHistory: ResumedContext['toolHistory'];
    if (includeToolMetadata) {
      toolHistory = relevantMessages
        .filter(m => m.metadata?.toolExecution)
        .map(m => {
          const exec = m.metadata!.toolExecution as {
            tool?: string;
            input?: unknown;
            output?: unknown;
            success?: boolean;
          };
          return {
            tool: exec.tool || 'unknown',
            input: exec.input,
            output: exec.output,
            timestamp: m.timestamp,
            success: exec.success ?? false,
          };
        });
    }

    // Build resumed context
    const contextTokens = estimateConversationTokens(messages);
    const resumedContext: ResumedContext = {
      sessionId,
      messages,
      summary,
      metadata: {
        originalStartTime: session.startedAt,
        totalOriginalMessages: session.messages.length,
        includedMessages: messages.length,
        summarizedMessages,
        contextTokens,
        wasSummarized: summarizedMessages > 0,
        lastActivityTime: session.lastActivityAt,
      },
      toolHistory,
    };

    logger.info('Session resumed', {
      sessionId,
      messagesIncluded: messages.length,
      summarizedMessages,
      contextTokens,
    });

    return {
      success: true,
      context: resumedContext,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error: any) {
    logger.error('Failed to resume session', { sessionId, error });
    return {
      success: false,
      error: error.message || 'Unknown error during resume',
    };
  }
}

/**
 * Get session preview for resume selection
 */
export interface SessionPreview {
  sessionId: string;
  messageCount: number;
  startTime: number;
  lastActivity: number;
  totalTokens: number;
  firstUserMessage?: string;
  lastAssistantMessage?: string;
  topics?: string[];
}

/**
 * Get previews of available sessions for resume
 */
export function getResumableSessions(
  cache: SessionLocalCache = getDefaultCache(),
  options: {
    limit?: number;
    minMessages?: number;
    sortBy?: 'lastActivity' | 'startTime' | 'messageCount';
  } = {}
): SessionPreview[] {
  const {
    limit = 20,
    minMessages = 2,
    sortBy = 'lastActivity',
  } = options;

  const sessionIds = cache.getSessionIds();
  const previews: SessionPreview[] = [];

  for (const sessionId of sessionIds) {
    const session = cache.getSession(sessionId);
    if (!session || session.messages.length < minMessages) {
      continue;
    }

    // Extract preview info
    const firstUserMessage = session.messages.find(m => m.role === 'user');
    const assistantMessages = session.messages.filter(m => m.role === 'assistant');
    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];

    previews.push({
      sessionId,
      messageCount: session.messages.length,
      startTime: session.startedAt,
      lastActivity: session.lastActivityAt,
      totalTokens: session.totalTokens,
      firstUserMessage: firstUserMessage?.content.substring(0, 100),
      lastAssistantMessage: lastAssistantMessage?.content.substring(0, 100),
    });
  }

  // Sort
  previews.sort((a, b) => {
    switch (sortBy) {
      case 'startTime':
        return b.startTime - a.startTime;
      case 'messageCount':
        return b.messageCount - a.messageCount;
      case 'lastActivity':
      default:
        return b.lastActivity - a.lastActivity;
    }
  });

  return previews.slice(0, limit);
}

/**
 * Check if a session can be resumed
 */
export function canResumeSession(
  sessionId: string,
  cache: SessionLocalCache = getDefaultCache()
): { canResume: boolean; reason?: string } {
  const session = cache.getSession(sessionId);

  if (!session) {
    return { canResume: false, reason: 'Session not found' };
  }

  if (session.messages.length === 0) {
    return { canResume: false, reason: 'Session has no messages' };
  }

  // Check for corrupted data
  const hasValidMessages = session.messages.every(
    m => m.role && m.content !== undefined
  );
  if (!hasValidMessages) {
    return { canResume: false, reason: 'Session contains invalid messages' };
  }

  return { canResume: true };
}

/**
 * Session Resume Manager class
 */
export class SessionResumeManager {
  private cache: SessionLocalCache;
  private defaultOptions: ResumeOptions;

  constructor(options: {
    cache?: SessionLocalCache;
    defaultResumeOptions?: ResumeOptions;
  } = {}) {
    this.cache = options.cache || getDefaultCache();
    this.defaultOptions = options.defaultResumeOptions || {};
  }

  /**
   * Resume a session
   */
  async resume(sessionId: string, options?: ResumeOptions): Promise<ResumeResult> {
    return resumeSession(sessionId, { ...this.defaultOptions, ...options }, this.cache);
  }

  /**
   * Get list of resumable sessions
   */
  getResumable(options?: Parameters<typeof getResumableSessions>[1]): SessionPreview[] {
    return getResumableSessions(this.cache, options);
  }

  /**
   * Check if session can be resumed
   */
  canResume(sessionId: string): { canResume: boolean; reason?: string } {
    return canResumeSession(sessionId, this.cache);
  }

  /**
   * Quick resume - resume with defaults, useful for "continue where I left off"
   */
  async quickResume(sessionId: string): Promise<ResumeResult> {
    return this.resume(sessionId, {
      allowSummarization: true,
      preserveRecentMessages: 20,
    });
  }

  /**
   * Resume most recent session
   */
  async resumeLatest(): Promise<ResumeResult> {
    const sessions = this.getResumable({ limit: 1, sortBy: 'lastActivity' });
    if (sessions.length === 0) {
      return { success: false, error: 'No sessions available to resume' };
    }
    return this.quickResume(sessions[0].sessionId);
  }
}

/**
 * Default resume manager instance
 */
let defaultResumeManager: SessionResumeManager | null = null;

export function getDefaultResumeManager(): SessionResumeManager {
  if (!defaultResumeManager) {
    defaultResumeManager = new SessionResumeManager();
  }
  return defaultResumeManager;
}
