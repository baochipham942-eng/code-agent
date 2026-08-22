// ============================================================================
// SessionRepository 专家主 thread 查询 — 从 SessionRepository.ts 拆出（max-lines 棘轮，
// 同 sessionRepositoryFtsSearch.ts 的拆法：自由函数 + 传入 db）。
// 「去 TA 的会话」续聊判定（N-NAMEDMATE 刀 1）：判定必须在宿主 SQL 层——renderer 的
// 会话列表是分页加载的，前端遍历判「没有」不可靠。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { StoredSession } from '../../../protocol/types';
import { rowToSession, visibleHistoryMessageWhere } from './sessionRepositoryParsers';

type SQLiteRow = Record<string, unknown>;

/**
 * 按专家 roleId 找最近活跃的专家主 thread（sessions.metadata.expertThread 标记）。
 * 排除已删除/已归档，按 updated_at 最新取一条。
 * userId 语义同 SessionRepository.applyOwnerFilter：undefined 不过滤，null 只取无主会话。
 */
export function findLatestExpertThreadSession(
  db: BetterSqlite3.Database,
  roleId: string,
  userId?: string | null,
): StoredSession | null {
  const filters = [
    's.is_deleted = 0',
    "s.status != 'archived'",
    "json_extract(s.metadata, '$.expertThread.roleId') = ?",
  ];
  const params: unknown[] = [roleId];
  if (userId === null) {
    filters.push('s.user_id IS NULL');
  } else if (userId !== undefined) {
    filters.push('s.user_id = ?');
    params.push(userId);
  }
  const stmt = db.prepare(`
    SELECT s.*,
           COUNT(m.id) as message_count,
           COALESCE(SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END), 0) as turn_count
    FROM sessions s
    LEFT JOIN messages m ON s.id = m.session_id AND ${visibleHistoryMessageWhere('m')}
    WHERE ${filters.join(' AND ')}
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT 1
  `);

  const row = stmt.get(...params) as SQLiteRow | undefined;
  return row ? rowToSession(row) : null;
}
