// ============================================================================
// Session Search - Search across sessions by content, date, and metadata
// ============================================================================
// Provides comprehensive session search capabilities:
// - Full-text search across message content
// - Date range filtering
// - Metadata-based filtering
// - Relevance scoring and ranking
// - Search result highlighting
// ============================================================================

import { createLogger } from '../services/infra/logger';
import {
  SessionLocalCache,
  CachedSession,
  CachedMessage,
  getDefaultCache,
} from './localCache';

const logger = createLogger('SessionSearch');

/**
 * Search query options
 */
export interface SearchOptions {
  /** Maximum results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Filter by message role */
  role?: 'user' | 'assistant' | 'system';
  /** Filter by date range (start) */
  startDate?: Date | number;
  /** Filter by date range (end) */
  endDate?: Date | number;
  /** Case-sensitive search */
  caseSensitive?: boolean;
  /** Use regex pattern */
  useRegex?: boolean;
  /** Search only in specific sessions */
  sessionIds?: string[];
  /** Minimum relevance score (0-1) */
  minRelevance?: number;
  /** Include context around matches */
  includeContext?: number;
  /** Sort by field */
  sortBy?: 'relevance' | 'date' | 'session';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Search match in message content
 */
export interface SearchMatch {
  /** Start position of match */
  start: number;
  /** End position of match */
  end: number;
  /** Matched text */
  text: string;
  /** Context around match */
  context?: string;
}

/**
 * Individual search result
 */
export interface SearchResult {
  /** Session ID */
  sessionId: string;
  /** Message containing the match */
  message: CachedMessage;
  /** Message index in session */
  messageIndex: number;
  /** Matches found in this message */
  matches: SearchMatch[];
  /** Relevance score (0-1) */
  relevance: number;
  /** Highlighted content snippet */
  snippet: string;
}

/**
 * Search results summary
 */
export interface SearchResults {
  /** Search query */
  query: string;
  /** Total matches found */
  totalMatches: number;
  /** Number of sessions with matches */
  sessionsWithMatches: number;
  /** Individual results */
  results: SearchResult[];
  /** Search time (ms) */
  searchTime: number;
  /** Whether results were truncated */
  truncated: boolean;
}

/**
 * Calculate relevance score for a match
 */
function calculateRelevance(
  content: string,
  query: string,
  matches: SearchMatch[],
  message: CachedMessage
): number {
  let score = 0;

  // Base score from match count
  score += Math.min(matches.length * 0.1, 0.3);

  // Match position (earlier matches score higher)
  if (matches.length > 0) {
    const firstMatchPos = matches[0].start / content.length;
    score += (1 - firstMatchPos) * 0.1;
  }

  // Match density (matches per 100 chars)
  const density = (matches.length / content.length) * 100;
  score += Math.min(density * 0.1, 0.2);

  // Exact phrase match bonus
  if (content.toLowerCase().includes(query.toLowerCase())) {
    score += 0.2;
  }

  // Recent message bonus
  const age = Date.now() - message.timestamp;
  const dayInMs = 24 * 60 * 60 * 1000;
  if (age < dayInMs) {
    score += 0.1;
  } else if (age < 7 * dayInMs) {
    score += 0.05;
  }

  // User message bonus (often contains the main query)
  if (message.role === 'user') {
    score += 0.1;
  }

  return Math.min(score, 1);
}

/**
 * Generate search snippet with highlighting
 */
function generateSnippet(
  content: string,
  matches: SearchMatch[],
  maxLength: number = 200
): string {
  if (matches.length === 0) {
    return content.substring(0, maxLength) + (content.length > maxLength ? '...' : '');
  }

  // Find the best match to center the snippet around
  const bestMatch = matches[0];
  const contextSize = Math.floor((maxLength - bestMatch.text.length) / 2);

  const start = Math.max(0, bestMatch.start - contextSize);
  const end = Math.min(content.length, bestMatch.end + contextSize);

  let snippet = content.substring(start, end);

  // Add ellipsis if truncated
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  // Highlight matches in snippet
  // For simplicity, we use **bold** for markdown-style highlighting
  const adjustedMatches = matches
    .filter(m => m.start >= start && m.end <= end)
    .map(m => ({
      start: m.start - start + (start > 0 ? 3 : 0), // Account for ellipsis
      end: m.end - start + (start > 0 ? 3 : 0),
      text: m.text,
    }))
    .sort((a, b) => b.start - a.start); // Process from end to start

  for (const match of adjustedMatches) {
    snippet =
      snippet.substring(0, match.start) +
      `**${match.text}**` +
      snippet.substring(match.end);
  }

  return snippet;
}

/**
 * Find all matches of query in content
 */
function findMatches(
  content: string,
  query: string,
  options: SearchOptions
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const searchContent = options.caseSensitive ? content : content.toLowerCase();
  const searchQuery = options.caseSensitive ? query : query.toLowerCase();

  if (options.useRegex) {
    try {
      const flags = options.caseSensitive ? 'g' : 'gi';
      const regex = new RegExp(query, flags);
      let match;

      while ((match = regex.exec(content)) !== null) {
        const matchInfo: SearchMatch = {
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
        };

        if (options.includeContext && options.includeContext > 0) {
          const ctxStart = Math.max(0, match.index - options.includeContext);
          const ctxEnd = Math.min(content.length, match.index + match[0].length + options.includeContext);
          matchInfo.context = content.substring(ctxStart, ctxEnd);
        }

        matches.push(matchInfo);
      }
    } catch (e) {
      // Invalid regex, fall back to simple search
      logger.warn('Invalid regex pattern, falling back to simple search', { query });
      return findMatches(content, query, { ...options, useRegex: false });
    }
  } else {
    // Simple string search
    let startPos = 0;

    while (true) {
      const index = searchContent.indexOf(searchQuery, startPos);
      if (index === -1) break;

      const matchInfo: SearchMatch = {
        start: index,
        end: index + query.length,
        text: content.substring(index, index + query.length),
      };

      if (options.includeContext && options.includeContext > 0) {
        const ctxStart = Math.max(0, index - options.includeContext);
        const ctxEnd = Math.min(content.length, index + query.length + options.includeContext);
        matchInfo.context = content.substring(ctxStart, ctxEnd);
      }

      matches.push(matchInfo);
      startPos = index + 1;
    }
  }

  return matches;
}

/**
 * Check if message passes date filter
 */
function passesDateFilter(message: CachedMessage, options: SearchOptions): boolean {
  if (options.startDate) {
    const startTime = typeof options.startDate === 'number'
      ? options.startDate
      : options.startDate.getTime();
    if (message.timestamp < startTime) return false;
  }

  if (options.endDate) {
    const endTime = typeof options.endDate === 'number'
      ? options.endDate
      : options.endDate.getTime();
    if (message.timestamp > endTime) return false;
  }

  return true;
}

/**
 * Search sessions for a query
 */
export function searchSessions(
  query: string,
  options: SearchOptions = {},
  cache: SessionLocalCache = getDefaultCache()
): SearchResults {
  const startTime = Date.now();

  const {
    limit = 50,
    offset = 0,
    role,
    caseSensitive = false,
    useRegex = false,
    sessionIds,
    minRelevance = 0,
    includeContext = 50,
    sortBy = 'relevance',
    sortOrder = 'desc',
  } = options;

  const allResults: SearchResult[] = [];
  const sessionsWithMatches = new Set<string>();

  // Get sessions to search
  const searchSessionIds = sessionIds || cache.getSessionIds();

  // Search each session
  for (const sessionId of searchSessionIds) {
    const session = cache.getSession(sessionId);
    if (!session) continue;

    // Search messages
    for (let i = 0; i < session.messages.length; i++) {
      const message = session.messages[i];

      // Apply filters
      if (role && message.role !== role) continue;
      if (!passesDateFilter(message, options)) continue;

      // Find matches
      const matches = findMatches(message.content, query, {
        caseSensitive,
        useRegex,
        includeContext,
      });

      if (matches.length === 0) continue;

      // Calculate relevance
      const relevance = calculateRelevance(message.content, query, matches, message);
      if (relevance < minRelevance) continue;

      // Generate snippet
      const snippet = generateSnippet(message.content, matches);

      sessionsWithMatches.add(sessionId);

      allResults.push({
        sessionId,
        message,
        messageIndex: i,
        matches,
        relevance,
        snippet,
      });
    }
  }

  // Sort results
  allResults.sort((a, b) => {
    let comparison: number;

    switch (sortBy) {
      case 'date':
        comparison = a.message.timestamp - b.message.timestamp;
        break;
      case 'session':
        comparison = a.sessionId.localeCompare(b.sessionId);
        break;
      case 'relevance':
      default:
        comparison = a.relevance - b.relevance;
    }

    return sortOrder === 'desc' ? -comparison : comparison;
  });

  // Apply pagination
  const paginatedResults = allResults.slice(offset, offset + limit);

  const searchTime = Date.now() - startTime;

  logger.debug('Search completed', {
    query,
    totalMatches: allResults.length,
    sessionsWithMatches: sessionsWithMatches.size,
    searchTime,
  });

  return {
    query,
    totalMatches: allResults.length,
    sessionsWithMatches: sessionsWithMatches.size,
    results: paginatedResults,
    searchTime,
    truncated: allResults.length > offset + limit,
  };
}

/**
 * Search for sessions by metadata
 */
export function searchByMetadata(
  criteria: Record<string, unknown>,
  cache: SessionLocalCache = getDefaultCache()
): CachedSession[] {
  const sessions: CachedSession[] = [];
  const sessionIds = cache.getSessionIds();

  for (const sessionId of sessionIds) {
    const session = cache.getSession(sessionId);
    if (!session) continue;

    // Check if session metadata matches all criteria
    let matches = true;
    for (const [key, value] of Object.entries(criteria)) {
      if (session.metadata?.[key] !== value) {
        matches = false;
        break;
      }
    }

    if (matches) {
      sessions.push(session);
    }
  }

  return sessions;
}

/**
 * Get recent sessions
 */
export function getRecentSessions(
  options: {
    limit?: number;
    minMessages?: number;
    maxAge?: number; // in milliseconds
  } = {},
  cache: SessionLocalCache = getDefaultCache()
): CachedSession[] {
  const {
    limit = 10,
    minMessages = 1,
    maxAge,
  } = options;

  const now = Date.now();
  const sessions: CachedSession[] = [];
  const sessionIds = cache.getSessionIds();

  for (const sessionId of sessionIds) {
    const session = cache.getSession(sessionId);
    if (!session) continue;

    // Apply filters
    if (session.messages.length < minMessages) continue;
    if (maxAge && now - session.lastActivityAt > maxAge) continue;

    sessions.push(session);
  }

  // Sort by last activity (most recent first)
  sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  return sessions.slice(0, limit);
}

/**
 * Get sessions by date range
 */
export function getSessionsByDateRange(
  startDate: Date | number,
  endDate: Date | number,
  cache: SessionLocalCache = getDefaultCache()
): CachedSession[] {
  const startTime = typeof startDate === 'number' ? startDate : startDate.getTime();
  const endTime = typeof endDate === 'number' ? endDate : endDate.getTime();

  const sessions: CachedSession[] = [];
  const sessionIds = cache.getSessionIds();

  for (const sessionId of sessionIds) {
    const session = cache.getSession(sessionId);
    if (!session) continue;

    // Check if session falls within date range
    if (session.startedAt >= startTime && session.startedAt <= endTime) {
      sessions.push(session);
    }
  }

  // Sort by start time
  sessions.sort((a, b) => b.startedAt - a.startedAt);

  return sessions;
}

/**
 * Session Search Manager class
 */
export class SessionSearchManager {
  private cache: SessionLocalCache;
  private defaultOptions: SearchOptions;

  constructor(options: {
    cache?: SessionLocalCache;
    defaultSearchOptions?: SearchOptions;
  } = {}) {
    this.cache = options.cache || getDefaultCache();
    this.defaultOptions = options.defaultSearchOptions || {};
  }

  /**
   * Search sessions
   */
  search(query: string, options?: SearchOptions): SearchResults {
    return searchSessions(query, { ...this.defaultOptions, ...options }, this.cache);
  }

  /**
   * Quick search with defaults
   */
  quickSearch(query: string, limit: number = 10): SearchResults {
    return this.search(query, { limit, sortBy: 'relevance' });
  }

  /**
   * Search by metadata
   */
  byMetadata(criteria: Record<string, unknown>): CachedSession[] {
    return searchByMetadata(criteria, this.cache);
  }

  /**
   * Get recent sessions
   */
  recent(options?: Parameters<typeof getRecentSessions>[0]): CachedSession[] {
    return getRecentSessions(options, this.cache);
  }

  /**
   * Get sessions by date range
   */
  byDateRange(startDate: Date | number, endDate: Date | number): CachedSession[] {
    return getSessionsByDateRange(startDate, endDate, this.cache);
  }

  /**
   * Find sessions containing specific code (file references, function names)
   */
  findCodeReferences(pattern: string): SearchResults {
    return this.search(pattern, {
      useRegex: true,
      role: 'assistant', // Code usually appears in assistant responses
      sortBy: 'relevance',
    });
  }

  /**
   * Find sessions about a topic
   */
  findByTopic(topic: string): SearchResults {
    // Search with word boundaries for better topic matching
    return this.search(`\\b${topic}\\b`, {
      useRegex: true,
      caseSensitive: false,
      sortBy: 'relevance',
    });
  }
}

/**
 * Default search manager instance
 */
let defaultSearchManager: SessionSearchManager | null = null;

export function getDefaultSearchManager(): SessionSearchManager {
  if (!defaultSearchManager) {
    defaultSearchManager = new SessionSearchManager();
  }
  return defaultSearchManager;
}
