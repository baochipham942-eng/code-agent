// ============================================================================
// SessionRepository FTS 搜索 — 从 SessionRepository.ts 拆出（零行为改动）
// session_messages_fts / transcript_fts 查询；类方法委托，传入 db。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { SESSION_SEARCH } from '../../../../shared/constants';
import { TRANSCRIPT_FTS_BODY_COLUMN_INDEX, type TranscriptKind } from '../../../../shared/transcriptFts.sql';
import { createLogger } from '../../infra/logger';
import { activeMessageWhere, loopInternalMessageWhere, visibleHistoryMessageWhere } from './sessionRepositoryParsers';

type SQLiteRow = Record<string, unknown>;
const logger = createLogger('SessionRepositoryFtsSearch');

/** session_messages_fts 单条命中行 */
export interface SessionMessagesFtsHit {
  messageId: string;
  sessionId: string;
  role: string;
  content: string;
  timestamp: number;
}

/** searchSessionMessagesFts 查询选项 */
export interface SessionMessagesFtsSearchOptions {
  limit?: number;
  sessionId?: string;
  /** 多会话作用域过滤（UI 跨会话搜索）；与 sessionId 同时给时优先生效 */
  sessionIds?: string[];
  /** 按消息 role 过滤 */
  role?: string;
  includeRewound?: boolean;
  /** limit 硬上限覆盖（默认 SESSION_SEARCH.FTS_QUERY_LIMIT_CAP，面向 agent 记忆侧） */
  limitCap?: number;
  /**
   * 短查询（低于 trigram 最小长度）改走全库 LIKE 而不是返回空。
   * 中文 2 字词是最高频搜索输入，但 trigram 至少要 3 字符——UI 搜索必须传 true，
   * 否则 2 字查询会退回只覆盖 LRU 缓存的老行为。
   * 默认 false：agent 记忆侧维持原语义（短查询无召回），不受影响。
   */
  shortQueryFallback?: boolean;
}

/** session_messages_fts 命中计数选项 */
export interface SessionMessagesFtsCountOptions {
  sessionId?: string;
  sessionIds?: string[];
  role?: string;
  includeRewound?: boolean;
  /** 见 SessionMessagesFtsSearchOptions.shortQueryFallback */
  shortQueryFallback?: boolean;
}

function normalizeFtsQuery(raw: string): string {
  if (raw.startsWith('"')) {
    return raw;
  }
  return '"' + raw.replace(/"/g, '""') + '"';
}

/**
 * 组装 session_messages_fts 查询的过滤条件（sessionIds/sessionId/role）。
 * includeRewound 分支查纯 FTS 表，会话列用 f.session_id；
 * 默认分支 JOIN messages 做可见性过滤，会话列用 m.session_id。
 */
function buildSessionMessagesFtsFilter(
  options: SessionMessagesFtsCountOptions,
): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const sessionColumn = options.includeRewound ? 'f.session_id' : 'm.session_id';

  if (options.sessionIds && options.sessionIds.length > 0) {
    conditions.push(`${sessionColumn} IN (${options.sessionIds.map(() => '?').join(', ')})`);
    params.push(...options.sessionIds);
  } else if (options.sessionId) {
    conditions.push(`${sessionColumn} = ?`);
    params.push(options.sessionId);
  }
  if (options.role) {
    conditions.push('f.role = ?');
    params.push(options.role);
  }

  return { clause: conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '', params };
}

/**
 * 短查询兜底：trigram 至少要 3 字符，2 字中文（最高频搜索输入）在 FTS 里恒为空召回。
 * 这里直接对 messages 表做 LIKE，可见性过滤复用 visibleHistoryMessageWhere，
 * 与 session_messages_fts 触发器的排除口径（is_meta / 循环噪音）保持一致。
 */
function buildShortQueryFilter(
  options: SessionMessagesFtsSearchOptions | SessionMessagesFtsCountOptions
): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.sessionIds && options.sessionIds.length > 0) {
    conditions.push(`m.session_id IN (${options.sessionIds.map(() => '?').join(', ')})`);
    params.push(...options.sessionIds);
  } else if (options.sessionId) {
    conditions.push('m.session_id = ?');
    params.push(options.sessionId);
  }
  if (options.role) {
    conditions.push('m.role = ?');
    params.push(options.role);
  }
  return { clause: conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '', params };
}

function runShortQueryLikeSearch(
  db: BetterSqlite3.Database,
  trimmed: string,
  options: SessionMessagesFtsSearchOptions
): SessionMessagesFtsHit[] {
  const filter = buildShortQueryFilter(options);
  const limit = Math.max(1, Math.min(options.limit ?? 10, options.limitCap ?? SESSION_SEARCH.FTS_QUERY_LIMIT_CAP));
  try {
    const rows = db.prepare(`
      SELECT m.id AS message_id, m.session_id, m.role, m.content, m.timestamp
      FROM messages m
      WHERE m.content LIKE ? ESCAPE '\\' ${filter.clause}
        AND ${visibleHistoryMessageWhere('m')}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(`%${escapeLikePattern(trimmed)}%`, ...filter.params, limit) as SQLiteRow[];
    return rows.map((row) => ({
      messageId: String(row.message_id ?? ''),
      sessionId: String(row.session_id ?? ''),
      role: String(row.role ?? ''),
      content: String(row.content ?? ''),
      timestamp: Number(row.timestamp ?? 0)
    }));
  } catch (err) {
    logger.warn('[EpisodicFts] short-query LIKE search failed', { query: trimmed, error: err });
    return [];
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function runSessionMessagesFtsSearch(db: BetterSqlite3.Database,
  query: string,
  options: SessionMessagesFtsSearchOptions = {}
): SessionMessagesFtsHit[] {
  const trimmed = query.trim();
  if (trimmed.length < SESSION_SEARCH.FTS_MIN_QUERY_LENGTH) {
    return options.shortQueryFallback ? runShortQueryLikeSearch(db, trimmed, options) : [];
  }

  const ftsQuery = normalizeFtsQuery(trimmed);
  const limit = Math.max(1, Math.min(options.limit ?? 10, options.limitCap ?? SESSION_SEARCH.FTS_QUERY_LIMIT_CAP));
  const filter = buildSessionMessagesFtsFilter(options);
  const params: unknown[] = [ftsQuery, ...filter.params, limit];

  try {
    const sql = options.includeRewound
      ? `
        SELECT f.message_id, f.session_id, f.role, f.content, f.timestamp
        FROM session_messages_fts f
        WHERE f.content MATCH ? ${filter.clause}
          AND ${loopInternalMessageWhere('f')}
        ORDER BY rank, f.timestamp DESC
        LIMIT ?
        `
      : `
        SELECT f.message_id, f.session_id, f.role, f.content, f.timestamp
        FROM session_messages_fts f
        JOIN messages m ON m.id = f.message_id
        WHERE f.content MATCH ? ${filter.clause}
          AND ${visibleHistoryMessageWhere('m')}
        ORDER BY rank, f.timestamp DESC
        LIMIT ?
        `;
    const rows = db.prepare(sql).all(...params) as SQLiteRow[];

    return rows.map((row) => ({
      messageId: String(row.message_id ?? ''),
      sessionId: String(row.session_id ?? ''),
      role: String(row.role ?? ''),
      content: String(row.content ?? ''),
      timestamp: Number(row.timestamp ?? 0)
    }));
  } catch (err) {
    logger.warn('[EpisodicFts] search failed', {
      query: trimmed,
      error: err
    });
    return [];
  }
}

/**
 * session_messages_fts 全量命中计数（不受 limit 截断）。
 * 供 UI 搜索如实报告 totalMatches / sessionsWithMatches / truncated。
 */
export function runSessionMessagesFtsCount(db: BetterSqlite3.Database,
  query: string,
  options: SessionMessagesFtsCountOptions = {}
): { matches: number; sessions: number } {
  const empty = { matches: 0, sessions: 0 };
  const trimmed = query.trim();
  if (trimmed.length < SESSION_SEARCH.FTS_MIN_QUERY_LENGTH) {
    if (!options.shortQueryFallback) {
      return empty;
    }
    const filter = buildShortQueryFilter(options);
    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS matches, COUNT(DISTINCT m.session_id) AS sessions
        FROM messages m
        WHERE m.content LIKE ? ESCAPE '\\' ${filter.clause}
          AND ${visibleHistoryMessageWhere('m')}
      `).get(`%${escapeLikePattern(trimmed)}%`, ...filter.params) as SQLiteRow | undefined;
      return row
        ? { matches: Number(row.matches ?? 0), sessions: Number(row.sessions ?? 0) }
        : empty;
    } catch (err) {
      logger.warn('[EpisodicFts] short-query LIKE count failed', { query: trimmed, error: err });
      return empty;
    }
  }

  const ftsQuery = normalizeFtsQuery(trimmed);
  const filter = buildSessionMessagesFtsFilter(options);
  const params: unknown[] = [ftsQuery, ...filter.params];

  try {
    const sql = options.includeRewound
      ? `
        SELECT COUNT(*) AS matches, COUNT(DISTINCT f.session_id) AS sessions
        FROM session_messages_fts f
        WHERE f.content MATCH ? ${filter.clause}
          AND ${loopInternalMessageWhere('f')}
        `
      : `
        SELECT COUNT(*) AS matches, COUNT(DISTINCT f.session_id) AS sessions
        FROM session_messages_fts f
        JOIN messages m ON m.id = f.message_id
        WHERE f.content MATCH ? ${filter.clause}
          AND ${visibleHistoryMessageWhere('m')}
        `;
    const row = db.prepare(sql).get(...params) as SQLiteRow | undefined;
    if (!row) {
      return empty;
    }
    return {
      matches: Number(row.matches ?? 0),
      sessions: Number(row.sessions ?? 0),
    };
  } catch (err) {
    logger.warn('[EpisodicFts] count failed', {
      query: trimmed,
      error: err
    });
    return empty;
  }
}

export function runTranscriptFtsSearch(db: BetterSqlite3.Database,
  query: string,
  options: {
    limit?: number;
    sessionId?: string;
    kinds?: TranscriptKind[];
    toolName?: string;
    timeAfter?: number;
    timeBefore?: number;
    includeRewound?: boolean;
  } = {}
): Array<{
  messageId: string;
  sessionId: string;
  kind: TranscriptKind;
  toolName: string | null;
  snippet: string;
  timestamp: number;
}> {
  const trimmed = query.trim();
  if (trimmed.length < 3) {
    return [];
  }

  const ftsQuery = normalizeFtsQuery(trimmed);
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const conditions: string[] = [];
  const params: unknown[] = [ftsQuery];

  if (options.sessionId) {
    conditions.push('f.session_id = ?');
    params.push(options.sessionId);
  }
  if (options.kinds && options.kinds.length > 0) {
    conditions.push(`f.kind IN (${options.kinds.map(() => '?').join(', ')})`);
    params.push(...options.kinds);
  }
  if (options.toolName) {
    conditions.push('f.tool_name = ?');
    params.push(options.toolName);
  }
  if (options.timeAfter !== undefined) {
    conditions.push('f.timestamp >= ?');
    params.push(options.timeAfter);
  }
  if (options.timeBefore !== undefined) {
    conditions.push('f.timestamp <= ?');
    params.push(options.timeBefore);
  }
  params.push(limit);

  const extra = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
  const snippetExpr = `snippet(transcript_fts, ${TRANSCRIPT_FTS_BODY_COLUMN_INDEX}, '«', '»', ' … ', 24)`;
  // meta/loop 已在 trigger 期排除；查询期只需补 rewound 可见性过滤
  const sql = options.includeRewound
    ? `
      SELECT f.message_id, f.session_id, f.kind, f.tool_name, f.timestamp, ${snippetExpr} AS snip
      FROM transcript_fts f
      WHERE f.body MATCH ? ${extra}
      ORDER BY rank, f.timestamp DESC
      LIMIT ?
      `
    : `
      SELECT f.message_id, f.session_id, f.kind, f.tool_name, f.timestamp, ${snippetExpr} AS snip
      FROM transcript_fts f
      JOIN messages m ON m.id = f.message_id
      WHERE f.body MATCH ? ${extra}
        AND ${activeMessageWhere('m')}
      ORDER BY rank, f.timestamp DESC
      LIMIT ?
      `;

  const rows = db.prepare(sql).all(...params) as SQLiteRow[];
  return rows.map((row) => ({
    messageId: String(row.message_id ?? ''),
    sessionId: String(row.session_id ?? ''),
    kind: String(row.kind ?? '') as TranscriptKind,
    toolName: row.tool_name ? String(row.tool_name) : null,
    snippet: String(row.snip ?? ''),
    timestamp: Number(row.timestamp ?? 0)
  }));
}
