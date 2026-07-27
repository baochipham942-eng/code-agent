import type BetterSqlite3 from 'better-sqlite3';
import type { Message } from '../../../../shared/contract';
import { MEMORY } from '../../../../shared/constants';
import { runTranscriptFtsBackfill, type TranscriptKind } from '../../../../shared/transcriptFts.sql';
import { createLogger } from '../../infra/logger';
import {
  loopInternalMessageWhere,
  rowToMessage,
  visibleHistoryMessageWhere,
} from './sessionRepositoryParsers';
import { runSessionMessagesFtsSearch, runTranscriptFtsSearch } from './sessionRepositoryFtsSearch';

const logger = createLogger('SessionFtsRepository');

type SQLiteRow = Record<string, unknown>;

export class SessionFtsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  searchSessionMessagesFts(
    query: string,
    options: {
      limit?: number;
      sessionId?: string;
      includeRewound?: boolean;
    } = {},
  ): Array<{
    messageId: string;
    sessionId: string;
    role: string;
    content: string;
    timestamp: number;
  }> {
    return runSessionMessagesFtsSearch(this.db, query, options);
  }

  backfillSessionMessagesFts(): number {
    try {
      const ftsHasRows = this.db.prepare('SELECT 1 FROM session_messages_fts LIMIT 1').get() !== undefined;
      const msgHasRows = this.db.prepare('SELECT 1 FROM messages LIMIT 1').get() !== undefined;

      if (ftsHasRows || !msgHasRows) {
        return 0;
      }

      logger.info('[EpisodicFts] Backfilling FTS from messages...');
      const result = this.db
        .prepare(
          `
          INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
          SELECT id, session_id, role, COALESCE(content, ''), timestamp
          FROM messages
          WHERE COALESCE(is_meta, 0) = 0
            AND ${loopInternalMessageWhere('messages')}
          `,
        )
        .run();
      const inserted = Number(result.changes ?? 0);
      logger.info(`[EpisodicFts] Backfill complete: ${inserted} rows`);
      return inserted;
    } catch (err) {
      logger.warn('[EpisodicFts] Backfill failed (non-blocking)', { error: err });
      return 0;
    }
  }

  searchTranscriptFts(
    query: string,
    options: {
      limit?: number;
      sessionId?: string;
      kinds?: TranscriptKind[];
      toolName?: string;
      timeAfter?: number;
      timeBefore?: number;
      includeRewound?: boolean;
    } = {},
  ): Array<{
    messageId: string;
    sessionId: string;
    kind: TranscriptKind;
    toolName: string | null;
    snippet: string;
    timestamp: number;
  }> {
    return runTranscriptFtsSearch(this.db, query, options);
  }

  getTranscriptAround(
    messageId: string,
    options: { before?: number; after?: number } = {},
  ): {
    sessionId: string;
    messages: Array<{ message: Message; matched: boolean }>;
  } | null {
    const clampWindow = (value: number | undefined, fallback: number): number => {
      if (value === undefined || !Number.isFinite(value)) return fallback;
      return Math.max(0, Math.min(Math.floor(value), MEMORY.HISTORY_AROUND_MAX_WINDOW));
    };
    const before = clampWindow(options.before, MEMORY.HISTORY_AROUND_DEFAULT_WINDOW);
    const after = clampWindow(options.after, MEMORY.HISTORY_AROUND_DEFAULT_WINDOW);

    const anchor = this.db
      .prepare('SELECT rowid AS rid, session_id, timestamp FROM messages WHERE id = ?')
      .get(messageId) as { rid: number; session_id: string; timestamp: number } | undefined;
    if (!anchor) {
      return null;
    }

    const visible = `${visibleHistoryMessageWhere('m')}`;
    const beforeRows = this.db
      .prepare(
        `
        SELECT m.* FROM messages m
        WHERE m.session_id = ?
          AND (m.timestamp < ? OR (m.timestamp = ? AND m.rowid <= ?))
          AND (${visible} OR m.id = ?)
        ORDER BY m.timestamp DESC, m.rowid DESC
        LIMIT ?
        `,
      )
      .all(anchor.session_id, anchor.timestamp, anchor.timestamp, anchor.rid, messageId, before + 1) as SQLiteRow[];

    const afterRows = this.db
      .prepare(
        `
        SELECT m.* FROM messages m
        WHERE m.session_id = ?
          AND (m.timestamp > ? OR (m.timestamp = ? AND m.rowid > ?))
          AND ${visible}
        ORDER BY m.timestamp ASC, m.rowid ASC
        LIMIT ?
        `,
      )
      .all(anchor.session_id, anchor.timestamp, anchor.timestamp, anchor.rid, after) as SQLiteRow[];

    const ordered = [...beforeRows.reverse(), ...afterRows];
    return {
      sessionId: anchor.session_id,
      messages: ordered.map((row) => ({
        message: rowToMessage(row),
        matched: String(row.id) === messageId,
      })),
    };
  }

  backfillTranscriptFts(): number {
    try {
      const ftsHasRows = this.db.prepare('SELECT 1 FROM transcript_fts LIMIT 1').get() !== undefined;
      const msgHasRows = this.db.prepare('SELECT 1 FROM messages LIMIT 1').get() !== undefined;
      if (ftsHasRows || !msgHasRows) {
        return 0;
      }

      logger.info('[TranscriptFts] Backfilling from messages...');
      const inserted = runTranscriptFtsBackfill(this.db);
      logger.info(`[TranscriptFts] Backfill complete: ${inserted} rows`);
      return inserted;
    } catch (err) {
      logger.warn('[TranscriptFts] Backfill failed (non-blocking)', { error: err });
      return 0;
    }
  }
}
