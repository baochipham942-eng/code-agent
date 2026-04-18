// ============================================================================
// Review Queue Service - Persisted review queue for Phase 6.1 + 6.2 and minimal 6.3 sink
// ============================================================================

import type Database from 'better-sqlite3';
import type {
  EnqueueReviewItemInput,
  ReviewQueueItem,
} from '../../shared/contract/reviewQueue';
import {
  buildReviewQueueItemId,
  buildSessionTraceIdentity,
} from '../../shared/contract/reviewQueue';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ReviewQueueService');

type SQLiteRow = Record<string, unknown>;

export class ReviewQueueService {
  private static instance: ReviewQueueService | null = null;
  private schemaReady = false;

  static getInstance(): ReviewQueueService {
    if (!this.instance) {
      this.instance = new ReviewQueueService();
    }
    return this.instance;
  }

  private getDb(): Database.Database {
    const db = getDatabase().getDb();
    if (!db) {
      throw new Error('Database not initialized');
    }
    this.ensureSchema(db);
    return db;
  }

  private ensureSchema(db: Database.Database): void {
    if (this.schemaReady) {
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS review_queue_items (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL UNIQUE,
        trace_source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        replay_key TEXT NOT NULL,
        session_title TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_review_queue_items_updated_at
      ON review_queue_items(updated_at DESC)
    `);
    this.schemaReady = true;
  }

  listItems(): ReviewQueueItem[] {
    try {
      const rows = this.getDb().prepare(`
        SELECT *
        FROM review_queue_items
        ORDER BY updated_at DESC
      `).all() as SQLiteRow[];

      return rows.map((row) => this.rowToItem(row));
    } catch (error) {
      logger.error('Failed to list review queue items', error);
      return [];
    }
  }

  enqueueSession(input: EnqueueReviewItemInput): ReviewQueueItem {
    const trace = buildSessionTraceIdentity(input.sessionId);
    const now = Date.now();
    const id = buildReviewQueueItemId(trace);
    const sessionTitle = this.resolveSessionTitle(input);

    const db = this.getDb();
    db.prepare(`
      INSERT INTO review_queue_items (
        id,
        trace_id,
        trace_source,
        session_id,
        replay_key,
        session_title,
        reason,
        source,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_title = excluded.session_title,
        reason = excluded.reason,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(
      id,
      trace.traceId,
      trace.source,
      trace.sessionId,
      trace.replayKey,
      sessionTitle,
      input.reason || 'manual_review',
      input.source || 'current_session_bar',
      now,
      now,
    );

    const row = db.prepare(`
      SELECT *
      FROM review_queue_items
      WHERE id = ?
      LIMIT 1
    `).get(id) as SQLiteRow | undefined;

    if (!row) {
      throw new Error(`Failed to load review queue item after enqueue: ${id}`);
    }

    return this.rowToItem(row);
  }

  private resolveSessionTitle(input: EnqueueReviewItemInput): string {
    const db = getDatabase();
    try {
      const session = db.getSession(input.sessionId, { includeDeleted: true });
      if (session?.title) {
        return session.title;
      }
    } catch (error) {
      logger.warn('Failed to resolve session title for review queue', { error, sessionId: input.sessionId });
    }

    if (input.sessionTitle?.trim()) {
      return input.sessionTitle.trim();
    }

    return `Session ${input.sessionId.slice(0, 8)}`;
  }

  private rowToItem(row: SQLiteRow): ReviewQueueItem {
    return {
      id: row.id as string,
      trace: {
        traceId: row.trace_id as string,
        source: row.trace_source as ReviewQueueItem['trace']['source'],
        sessionId: row.session_id as string,
        replayKey: row.replay_key as string,
      },
      sessionId: row.session_id as string,
      sessionTitle: row.session_title as string,
      reason: row.reason as ReviewQueueItem['reason'],
      source: row.source as ReviewQueueItem['source'],
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }
}

let reviewQueueServiceInstance: ReviewQueueService | null = null;

export function getReviewQueueService(): ReviewQueueService {
  if (!reviewQueueServiceInstance) {
    reviewQueueServiceInstance = ReviewQueueService.getInstance();
  }
  return reviewQueueServiceInstance;
}
