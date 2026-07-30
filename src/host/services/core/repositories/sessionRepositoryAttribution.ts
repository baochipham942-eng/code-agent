import type BetterSqlite3 from 'better-sqlite3';
import { activeMessageWhere } from './sessionRepositoryParsers';

type SQLiteRow = Record<string, unknown>;

/**
 * Collaboration-aware clients persist messages.author_user_id. Older clients
 * do not, so the owning session user remains the compatibility fallback.
 * Rewound messages are excluded to align with the active conversation view.
 */
export function getLatestUserAuthorId(
  db: BetterSqlite3.Database,
  sessionId: string,
): string | null {
  const row = db.prepare(`
    SELECT COALESCE(m.author_user_id, s.user_id) AS author_user_id
    FROM sessions s
    LEFT JOIN messages m
      ON m.session_id = s.id
      AND m.role = 'user'
      AND ${activeMessageWhere('m')}
    WHERE s.id = ?
    ORDER BY m.timestamp DESC, m.rowid DESC
    LIMIT 1
  `).get(sessionId) as SQLiteRow | undefined;
  return typeof row?.author_user_id === 'string' && row.author_user_id.trim()
    ? row.author_user_id
    : null;
}
