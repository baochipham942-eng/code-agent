import type BetterSqlite3 from 'better-sqlite3';
import type { Message } from '../../../../shared/contract';
import { MEMORY } from '../../../../shared/constants';
import {
  countTranscriptFtsSourceRows,
  rebuildTranscriptFts,
  type TranscriptKind,
} from '../../../../shared/transcriptFts.sql';
import { createLogger } from '../../infra/logger';
import {
  rowToMessage,
  visibleHistoryMessageWhere,
} from './sessionRepositoryParsers';
import { runSessionMessagesFtsCount, runSessionMessagesFtsSearch, runTranscriptFtsSearch } from './sessionRepositoryFtsSearch';
import type {
  SessionMessagesFtsCountOptions,
  SessionMessagesFtsHit,
  SessionMessagesFtsSearchOptions,
} from './sessionRepositoryFtsSearch';

const logger = createLogger('SessionFtsRepository');

type SQLiteRow = Record<string, unknown>;
type TriggerDefinition = { name: string; sql: string };

const SESSION_FTS_SOURCE_WHERE = `
  COALESCE(is_meta, 0) = 0
  AND COALESCE(content, '') NOT LIKE '%【循环模式 · 第%轮】%'
  AND COALESCE(content, '') NOT LIKE '%[[LOOP_WAIT]]%'
`;

const SESSION_FTS_STAGING_TABLE_SQL = `
  CREATE VIRTUAL TABLE session_messages_fts_rebuild USING fts5(
    message_id UNINDEXED,
    session_id UNINDEXED,
    role UNINDEXED,
    content,
    timestamp UNINDEXED,
    tokenize = 'trigram'
  )
`;

export class SessionFtsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  searchSessionMessagesFts(
    query: string,
    options: SessionMessagesFtsSearchOptions = {},
  ): SessionMessagesFtsHit[] {
    return runSessionMessagesFtsSearch(this.db, query, options);
  }

  countSessionMessagesFts(
    query: string,
    options: SessionMessagesFtsCountOptions = {},
  ): { matches: number; sessions: number } {
    return runSessionMessagesFtsCount(this.db, query, options);
  }

  backfillSessionMessagesFts(): number {
    try {
      const ftsRows = this.countRows('session_messages_fts');
      const sourceRows = this.countSessionMessagesFtsSourceRows();

      if (ftsRows === sourceRows) {
        return 0;
      }

      logger.info(`[EpisodicFts] Rebuilding projection: source=${sourceRows}, fts=${ftsRows}`);
      const rebuilt = this.rebuildSessionMessagesFts();
      logger.info(`[EpisodicFts] Rebuild complete: ${rebuilt} rows`);
      return rebuilt;
    } catch (err) {
      logger.warn('[EpisodicFts] Backfill failed (non-blocking)', { error: err });
      return 0;
    }
  }

  private countRows(tableName: 'session_messages_fts' | 'transcript_fts'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as {
      count: number | bigint;
    };
    return Number(row.count);
  }

  private countSessionMessagesFtsSourceRows(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${SESSION_FTS_SOURCE_WHERE}`).get() as {
      count: number | bigint;
    };
    return Number(row.count);
  }

  private rebuildSessionMessagesFts(): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const triggers = this.sessionMessagesFtsTriggerDefinitions();
      this.db.exec('DROP TABLE IF EXISTS session_messages_fts_rebuild');
      this.db.exec(SESSION_FTS_STAGING_TABLE_SQL);
      this.db.prepare(
        `
          INSERT INTO session_messages_fts_rebuild (message_id, session_id, role, content, timestamp)
          SELECT id, session_id, role, COALESCE(content, ''), timestamp
          FROM messages
          WHERE ${SESSION_FTS_SOURCE_WHERE}
        `,
      ).run();

      const sourceRows = this.countSessionMessagesFtsSourceRows();
      const stagingRows = Number(
        (this.db.prepare('SELECT COUNT(*) AS count FROM session_messages_fts_rebuild').get() as {
          count: number | bigint;
        }).count,
      );
      if (stagingRows !== sourceRows) {
        throw new Error(`Session FTS rebuild row count mismatch: source=${sourceRows}, staging=${stagingRows}`);
      }

      for (const trigger of triggers) {
        this.db.exec(`DROP TRIGGER ${this.quoteSqlIdentifier(trigger.name)}`);
      }
      this.db.exec('DROP TABLE session_messages_fts');
      this.db.exec('ALTER TABLE session_messages_fts_rebuild RENAME TO session_messages_fts');
      for (const trigger of triggers) {
        this.db.exec(trigger.sql);
      }
      this.db.exec('COMMIT');
      return stagingRows;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // SQLite may already have rolled back the transaction.
      }
      throw err;
    }
  }

  private sessionMessagesFtsTriggerDefinitions(): TriggerDefinition[] {
    return this.db.prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'trigger'
        AND instr(sql, 'session_messages_fts') > 0
        AND sql IS NOT NULL
    `).all() as TriggerDefinition[];
  }

  private quoteSqlIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
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
      const ftsRows = this.countRows('transcript_fts');
      const sourceRows = countTranscriptFtsSourceRows(this.db);
      if (ftsRows === sourceRows) {
        return 0;
      }

      logger.info(`[TranscriptFts] Rebuilding projection: source=${sourceRows}, fts=${ftsRows}`);
      const rebuilt = rebuildTranscriptFts(this.db);
      logger.info(`[TranscriptFts] Rebuild complete: ${rebuilt} rows`);
      return rebuilt;
    } catch (err) {
      logger.warn('[TranscriptFts] Backfill failed (non-blocking)', { error: err });
      return 0;
    }
  }
}
