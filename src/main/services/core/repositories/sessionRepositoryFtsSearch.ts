// ============================================================================
// SessionRepository FTS 搜索 — 从 SessionRepository.ts 拆出（零行为改动）
// session_messages_fts / transcript_fts 查询；类方法委托，传入 db。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { TRANSCRIPT_FTS_BODY_COLUMN_INDEX, type TranscriptKind } from '../../../../shared/transcriptFts.sql';
import { createLogger } from '../../infra/logger';
import { activeMessageWhere, loopInternalMessageWhere, visibleHistoryMessageWhere } from './sessionRepositoryParsers';

type SQLiteRow = Record<string, unknown>;
const logger = createLogger('SessionRepositoryFtsSearch');

function normalizeFtsQuery(raw: string): string {
  if (raw.startsWith('"')) {
    return raw;
  }
  return '"' + raw.replace(/"/g, '""') + '"';
}

export function runSessionMessagesFtsSearch(db: BetterSqlite3.Database, 
  query: string,
  options: {
    limit?: number;
    sessionId?: string;
    includeRewound?: boolean;
  } = {}
): Array<{
  messageId: string;
  sessionId: string;
  role: string;
  content: string;
  timestamp: number;
}> {
  const trimmed = query.trim();
  if (trimmed.length < 3) {
    return [];
  }

  const ftsQuery = normalizeFtsQuery(trimmed);
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const params: unknown[] = [ftsQuery];
  let whereSession = '';
  if (options.sessionId) {
    whereSession = options.includeRewound ? 'AND f.session_id = ?' : 'AND m.session_id = ?';
    params.push(options.sessionId);
  }
  params.push(limit);

  try {
    const sql = options.includeRewound
      ? `
        SELECT f.message_id, f.session_id, f.role, f.content, f.timestamp
        FROM session_messages_fts f
        WHERE f.content MATCH ? ${whereSession}
          AND ${loopInternalMessageWhere('f')}
        ORDER BY rank, f.timestamp DESC
        LIMIT ?
        `
      : `
        SELECT f.message_id, f.session_id, f.role, f.content, f.timestamp
        FROM session_messages_fts f
        JOIN messages m ON m.id = f.message_id
        WHERE f.content MATCH ? ${whereSession}
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
