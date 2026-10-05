// ============================================================================
// N-TELEMETRY-SESSION-TITLE-STALE — 遥测会话标题回填
// ----------------------------------------------------------------------------
// telemetry_sessions.title 历史上只存开会话那刻的占位快照（'CLI Session' /
// 首条消息前 80 字），模型自动起的标题和用户改名只写 sessions.title。本模块在
// 启动维护期用 sessions.title 幂等回填遥测表：已一致的行不动，sessions 侧仍是
// 占位命名的行也不动（别拿 'New Chat' 砸掉遥测里的首条消息快照）。
// 写入与在线同步同一道 guardTelemetryText 口径。
// ============================================================================

import type Database from 'better-sqlite3';
import {
  deriveFallbackSessionTitle,
  isPlaceholderSessionTitle,
} from '../../shared/sessionTitlePlaceholder';
import { createLogger } from '../services/infra/logger';
import { guardTelemetryText } from './telemetryStorageParsers';

const logger = createLogger('TelemetryBackfill');

/** 首次建遥测行时读 sessions.title：已命名才返回，占位/空白/无行都当没有。 */
export function readNamedChatTitle(db: Database.Database, sessionId: string): string | null {
  try {
    const row = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title: string | null } | undefined;
    const named = row?.title?.trim();
    if (!named || isPlaceholderSessionTitle(named)) return null;
    return named;
  } catch {
    return null;
  }
}

/**
 * 只读 sessions.title 写遥测表，幂等。返回本次更新的行数（0 = 全一致或无可回填）。
 * fail-safe：回填失败不阻塞启动。
 */
export function backfillTelemetrySessionTitles(db: Database.Database): number {
  try {
    const rows = db.prepare(`
      SELECT t.id AS id, t.title AS telemetry_title, s.title AS chat_title
      FROM telemetry_sessions t
      JOIN sessions s ON s.id = t.id
    `).all() as Array<{ id: string; telemetry_title: string | null; chat_title: string | null }>;

    const update = db.prepare('UPDATE telemetry_sessions SET title = ? WHERE id = ?');
    let updated = 0;
    db.transaction(() => {
      for (const row of rows) {
        if (isPlaceholderSessionTitle(row.chat_title)) continue;
        const guarded = guardTelemetryText(row.chat_title, 2_000);
        if (!guarded || guarded === row.telemetry_title) continue;
        update.run(guarded, row.id);
        updated += 1;
      }
    })();
    if (updated > 0) {
      logger.info(`Backfilled ${updated} telemetry session title(s) from sessions.title`);
    }
    return updated;
  } catch (error) {
    logger.warn('Telemetry session title backfill failed (ignored):', error);
    return 0;
  }
}

interface CliPlaceholderTitleRow {
  id: string;
  title: string;
  content: string | null;
}

/**
 * CLI 占位标题回填。只处理 id 为 cli_session_* 且标题仍是占位、并有一条可见用户消息的行。
 * 用与在线降级相同的首行截断，不调模型。apply 默认 false，只计数不写。
 * 返回本次会改（或已改）的行数；已改名、没有用户消息、非 CLI 会话都不计。
 */
export function backfillCliPlaceholderSessionTitles(
  db: Database.Database,
  options: { apply?: boolean } = {},
): number {
  const rows = db.prepare(`
    SELECT s.id AS id, s.title AS title, (
      SELECT m.content
      FROM messages m
      WHERE m.session_id = s.id
        AND m.role = 'user'
        AND m.is_meta = 0
        AND m.visibility = 'active'
        AND TRIM(m.content) != ''
      ORDER BY m.timestamp ASC, m.rowid ASC
      LIMIT 1
    ) AS content
    FROM sessions s
    WHERE s.id LIKE 'cli\\_session\\_%' ESCAPE '\\'
  `).all() as CliPlaceholderTitleRow[];

  const pending: Array<{ id: string; from: string; title: string }> = [];
  for (const row of rows) {
    if (!isPlaceholderSessionTitle(row.title)) continue;
    if (typeof row.content !== 'string' || !row.content.trim()) continue;
    const title = deriveFallbackSessionTitle(row.content);
    if (!title.trim() || title === row.title) continue;
    pending.push({ id: row.id, from: row.title, title });
  }

  if (options.apply !== true || pending.length === 0) return pending.length;

  const update = db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND title = ?');
  db.transaction(() => {
    for (const row of pending) update.run(row.title, row.id, row.from);
  })();
  logger.info(`Backfilled ${pending.length} CLI placeholder session title(s)`);
  return pending.length;
}
