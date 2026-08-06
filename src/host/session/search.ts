// ============================================================================
// Session Search - Search across sessions by content, date, and metadata
// ============================================================================
// Provides comprehensive session search capabilities:
// - Full-text search across message content
// - Date range filtering
// - Metadata-based filtering
// - Relevance scoring and ranking
// - Search result highlighting
//
// 数据源：主路径走已有的 SQLite FTS（session_messages_fts，trigram，覆盖全库），
// 由 IPC 层惰性注入 SessionSearchFtsSource；短查询（低于 trigram 最小长度）、
// caseSensitive / useRegex、或 DB 未就绪时回落内存 LRU 搜索（原行为）。
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { SESSION_SEARCH } from '../../shared/constants';
import type { Message } from '../../shared/contract';
import {
  SessionLocalCache,
  CachedSession,
  CachedMessage,
  getDefaultCache,
} from './localCache';

const logger = createLogger('SessionSearch');

/**
 * FTS 候选命中行（与 sessionRepositoryFtsSearch.SessionMessagesFtsHit 结构一致；
 * 此处重复定义以避免 host/session → services/core 的静态依赖）。
 * 不导出：仅供 SessionSearchFtsSource 签名内部使用，避免新增死出口。
 */
interface SessionSearchFtsHit {
  messageId: string;
  sessionId: string;
  role: string;
  content: string;
  timestamp: number;
}

/**
 * UI 会话搜索的 FTS 数据源（DatabaseService 的结构子集，由 IPC 层惰性注入）。
 * isReady 在每次搜索时现查，DB 未就绪则回落内存搜索。
 */
export interface SessionSearchFtsSource {
  readonly isReady: boolean;
  searchSessionMessagesFts(
    query: string,
    options?: {
      limit?: number;
      sessionIds?: string[];
      role?: string;
      limitCap?: number;
    }
  ): SessionSearchFtsHit[];
  countSessionMessagesFts(
    query: string,
    options?: { sessionIds?: string[]; role?: string }
  ): { matches: number; sessions: number };
  getMessages(sessionId: string, limit?: number): Message[];
}

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
  /** Conversation turn number containing this message, when inferable */
  turnNumber?: number;
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
    } catch {
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

function getWorkbenchMetadata(message: CachedMessage): Record<string, unknown> | undefined {
  const workbench = message.metadata?.workbench;
  return workbench && typeof workbench === 'object'
    ? workbench as Record<string, unknown>
    : undefined;
}

function isRuntimeSupplementMessage(message: CachedMessage): boolean {
  if (message.role !== 'user') return false;
  const workbench = getWorkbenchMetadata(message);
  return workbench?.runtimeInputMode === 'supplement';
}

export function inferConversationTurnNumbers(messages: CachedMessage[]): Array<number | undefined> {
  const turnNumbers: Array<number | undefined> = [];
  let currentTurnNumber = 0;

  for (const message of messages) {
    if (message.role === 'user') {
      if (isRuntimeSupplementMessage(message) && currentTurnNumber > 0) {
        turnNumbers.push(currentTurnNumber);
        continue;
      }
      currentTurnNumber += 1;
      turnNumbers.push(currentTurnNumber);
      continue;
    }

    if (message.role === 'assistant') {
      if (currentTurnNumber === 0) {
        currentTurnNumber = 1;
      }
      turnNumbers.push(currentTurnNumber);
      continue;
    }

    turnNumbers.push(currentTurnNumber > 0 ? currentTurnNumber : undefined);
  }

  return turnNumbers;
}

/**
 * 按当前排序档位比较两条结果（relevance/date/session + asc/desc），两条搜索路径共用。
 */
function compareSearchResults(
  a: SearchResult,
  b: SearchResult,
  sortBy: 'relevance' | 'date' | 'session',
  sortOrder: 'asc' | 'desc'
): number {
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
}

/**
 * 是否可走 FTS 主路径：数据源就绪 + 查询达到 trigram 最小长度 +
 * 未请求内存-only 能力（caseSensitive / useRegex）。
 */
function canUseFtsSource(
  query: string,
  options: SearchOptions,
  ftsSource: SessionSearchFtsSource | undefined
): ftsSource is SessionSearchFtsSource {
  return Boolean(
    ftsSource &&
    ftsSource.isReady &&
    !options.caseSensitive &&
    !options.useRegex &&
    query.trim().length >= SESSION_SEARCH.FTS_MIN_QUERY_LENGTH
  );
}

function isCacheableSearchMessage(
  message: Message
): message is Message & { role: CachedMessage['role'] } {
  return message.role === 'user' || message.role === 'assistant' || message.role === 'system';
}

/**
 * 取会话消息（优先 LRU 缓存；未命中时从 DB 回填窗口并写入缓存，
 * 与 session.ipc.ts 的 hydrateCrossSessionSearchCache 同一形状）。
 */
function getOrHydrateSearchSession(
  sessionId: string,
  cache: SessionLocalCache,
  ftsSource: SessionSearchFtsSource
): CachedSession | undefined {
  const cached = cache.getSession(sessionId);
  if (cached) return cached;

  try {
    const messages: CachedMessage[] = ftsSource
      .getMessages(sessionId, SESSION_SEARCH.HYDRATE_MESSAGE_LIMIT)
      .filter(isCacheableSearchMessage)
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        metadata: message.metadata as Record<string, unknown> | undefined,
        toolCalls: message.toolCalls,
        toolResults: message.toolResults,
      }));
    const startedAt = messages[0]?.timestamp ?? Date.now();
    const session: CachedSession = {
      sessionId,
      messages,
      startedAt,
      lastActivityAt: messages[messages.length - 1]?.timestamp ?? startedAt,
      totalTokens: 0,
    };
    cache.setSession(session);
    return session;
  } catch (error) {
    logger.warn('Failed to hydrate session from DB for FTS search', { sessionId, error });
    return undefined;
  }
}

/**
 * FTS 主路径：全库召回候选 → 内存内做高亮定位 / relevance / 过滤 / 排序。
 * totalMatches / sessionsWithMatches 在候选触顶时用 FTS COUNT 反映全量，
 * 不再只反映缓存内数量。
 */
function searchSessionsViaFts(
  query: string,
  options: SearchOptions,
  cache: SessionLocalCache,
  ftsSource: SessionSearchFtsSource,
  startTime: number
): SearchResults {
  const {
    limit = 50,
    offset = 0,
    role,
    sessionIds,
    minRelevance = 0,
    includeContext = 50,
    sortBy = 'relevance',
    sortOrder = 'desc',
  } = options;

  const hits = ftsSource.searchSessionMessagesFts(query, {
    sessionIds,
    role,
    limit: SESSION_SEARCH.FTS_CANDIDATE_LIMIT,
    limitCap: SESSION_SEARCH.FTS_CANDIDATE_LIMIT,
  });

  const allResults: SearchResult[] = [];
  const sessionsWithMatches = new Set<string>();
  const turnNumbersBySession = new Map<string, Array<number | undefined>>();

  for (const hit of hits) {
    const session = getOrHydrateSearchSession(hit.sessionId, cache, ftsSource);
    if (!session) continue;

    let turnNumbers = turnNumbersBySession.get(hit.sessionId);
    if (!turnNumbers) {
      turnNumbers = inferConversationTurnNumbers(session.messages);
      turnNumbersBySession.set(hit.sessionId, turnNumbers);
    }

    // 命中消息超出回填窗口时，用 FTS 行兜底构造结果（跳转走 messageId，
    // messageIndex = -1 由 renderer 按「位置未知」展示），保证老消息可达。
    let messageIndex = session.messages.findIndex((m) => m.id === hit.messageId);
    let message: CachedMessage;
    let turnNumber: number | undefined;
    if (messageIndex >= 0) {
      message = session.messages[messageIndex];
      turnNumber = turnNumbers[messageIndex];
    } else {
      if (hit.role !== 'user' && hit.role !== 'assistant' && hit.role !== 'system') continue;
      message = {
        id: hit.messageId,
        role: hit.role,
        content: hit.content,
        timestamp: hit.timestamp,
      };
      messageIndex = -1;
      turnNumber = undefined;
    }

    if (!passesDateFilter(message, options)) continue;

    const matches = findMatches(message.content, query, {
      caseSensitive: false,
      useRegex: false,
      includeContext,
    });
    // FTS 命中但子串定位失败（大小写折叠差异等边界），保守跳过
    if (matches.length === 0) continue;

    const relevance = calculateRelevance(message.content, query, matches, message);
    if (relevance < minRelevance) continue;

    sessionsWithMatches.add(hit.sessionId);

    allResults.push({
      sessionId: hit.sessionId,
      message,
      messageIndex,
      turnNumber,
      matches,
      relevance,
      snippet: generateSnippet(message.content, matches),
    });
  }

  allResults.sort((a, b) => compareSearchResults(a, b, sortBy, sortOrder));

  // 全量计数：候选未触顶时内存结果就是全集；触顶且无内存-only 过滤
  // （日期 / minRelevance）时，用 FTS COUNT 如实报告全量。
  const candidatesCapped = hits.length >= SESSION_SEARCH.FTS_CANDIDATE_LIMIT;
  const hasMemoryOnlyFilters =
    options.startDate !== undefined || options.endDate !== undefined || minRelevance > 0;

  let totalMatches = allResults.length;
  let totalSessions = sessionsWithMatches.size;
  let truncated: boolean;
  if (candidatesCapped && !hasMemoryOnlyFilters) {
    const totals = ftsSource.countSessionMessagesFts(query, { sessionIds, role });
    totalMatches = Math.max(totals.matches, allResults.length);
    totalSessions = Math.max(totals.sessions, totalSessions);
    truncated = totalMatches > offset + limit;
  } else {
    // 触顶但带内存-only 过滤时无法精确计数，保守标记 truncated
    truncated = candidatesCapped || totalMatches > offset + limit;
  }

  const paginatedResults = allResults.slice(offset, offset + limit);
  const searchTime = Date.now() - startTime;

  logger.debug('FTS search completed', {
    query,
    candidates: hits.length,
    totalMatches,
    sessionsWithMatches: totalSessions,
    searchTime,
  });

  return {
    query,
    totalMatches,
    sessionsWithMatches: totalSessions,
    results: paginatedResults,
    searchTime,
    truncated,
  };
}

/**
 * Search sessions for a query
 *
 * 主路径走 SQLite FTS（ftsSource 就绪且查询满足 trigram 最小长度时）；
 * 否则回落内存 LRU 缓存搜索（原行为）。
 */
export function searchSessions(
  query: string,
  options: SearchOptions = {},
  cache: SessionLocalCache = getDefaultCache(),
  ftsSource?: SessionSearchFtsSource
): SearchResults {
  const startTime = Date.now();

  if (canUseFtsSource(query, options, ftsSource)) {
    return searchSessionsViaFts(query, options, cache, ftsSource, startTime);
  }

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
    const turnNumbers = inferConversationTurnNumbers(session.messages);

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
        turnNumber: turnNumbers[i],
        matches,
        relevance,
        snippet,
      });
    }
  }

  // Sort results
  allResults.sort((a, b) => compareSearchResults(a, b, sortBy, sortOrder));

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
  private ftsSource?: SessionSearchFtsSource;

  constructor(options: {
    cache?: SessionLocalCache;
    defaultSearchOptions?: SearchOptions;
    ftsSource?: SessionSearchFtsSource;
  } = {}) {
    this.cache = options.cache || getDefaultCache();
    this.defaultOptions = options.defaultSearchOptions || {};
    this.ftsSource = options.ftsSource;
  }

  /**
   * Search sessions
   *
   * 可通过 ftsSource 参数（或构造时注入）走 FTS 主路径；
   * 未注入 / DB 未就绪 / 短查询 / caseSensitive / useRegex 时回落内存搜索。
   */
  search(
    query: string,
    options?: SearchOptions,
    ftsSource?: SessionSearchFtsSource
  ): SearchResults {
    return searchSessions(
      query,
      { ...this.defaultOptions, ...options },
      this.cache,
      ftsSource ?? this.ftsSource
    );
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
