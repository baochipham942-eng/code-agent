// ============================================================================
// Review Queue Service - Persisted review queue for Phase 6.1 + 6.2 and minimal 6.3 sink
// ============================================================================

import type Database from 'better-sqlite3';
import type {
  EnqueueReviewItemInput,
  ReviewQueueFailureCapabilityAsset,
  ReviewQueueFailureCapabilityMetadata,
  ReviewQueueItem,
  UpdateReviewQueueFailureCapabilityAssetInput,
} from '../../shared/contract/reviewQueue';
import {
  buildReviewQueueFailureCapabilityAssetDraft,
  buildReviewQueueItemId,
  buildSessionTraceIdentity,
  isReviewQueueFailureCapabilityAssetStatus,
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
        failure_capability TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.ensureColumn(db, 'review_queue_items', 'failure_capability', 'TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_review_queue_items_updated_at
      ON review_queue_items(updated_at DESC)
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_queue_failure_assets (
        id TEXT PRIMARY KEY,
        review_item_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        status TEXT NOT NULL,
        sink TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        step_index INTEGER,
        confidence REAL,
        evidence TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(review_item_id) REFERENCES review_queue_items(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_review_queue_failure_assets_updated_at
      ON review_queue_failure_assets(updated_at DESC)
    `);
    this.schemaReady = true;
  }

  listItems(): ReviewQueueItem[] {
    try {
      const rows = this.getDb().prepare(`
        ${this.getReviewQueueSelectSql()}
        ORDER BY items.updated_at DESC
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
    const reason = input.reason || 'manual_review';
    const source = input.source || 'current_session_bar';
    const failureCapability = reason === 'failure_followup'
      ? this.serializeFailureCapability(input.failureCapability)
      : null;

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
        failure_capability,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_title = excluded.session_title,
        reason = excluded.reason,
        source = excluded.source,
        failure_capability = excluded.failure_capability,
        updated_at = excluded.updated_at
    `).run(
      id,
      trace.traceId,
      trace.source,
      trace.sessionId,
      trace.replayKey,
      sessionTitle,
      reason,
      source,
      failureCapability,
      now,
      now,
    );

    if (reason === 'failure_followup' && input.failureCapability) {
      const failureAsset = buildReviewQueueFailureCapabilityAssetDraft({
        reviewItemId: id,
        sessionId: trace.sessionId,
        traceId: trace.traceId,
        metadata: input.failureCapability,
        createdAt: now,
      });
      this.upsertFailureAsset(db, failureAsset);
    } else {
      this.deleteFailureAsset(db, id);
    }

    const row = db.prepare(`
      ${this.getReviewQueueSelectSql()}
      WHERE items.id = ?
      LIMIT 1
    `).get(id) as SQLiteRow | undefined;

    if (!row) {
      throw new Error(`Failed to load review queue item after enqueue: ${id}`);
    }

    return this.rowToItem(row);
  }

  updateFailureAssetStatus(
    input: UpdateReviewQueueFailureCapabilityAssetInput,
  ): ReviewQueueItem | null {
    if (!input.reviewItemId?.trim()) {
      throw new Error('reviewItemId is required');
    }
    if (!isReviewQueueFailureCapabilityAssetStatus(input.status)) {
      throw new Error(`Invalid failure asset status: ${String(input.status)}`);
    }

    const db = this.getDb();
    const now = input.updatedAt ?? Date.now();
    const result = db.prepare(`
      UPDATE review_queue_failure_assets
      SET status = ?, updated_at = ?
      WHERE review_item_id = ?
    `).run(input.status, now, input.reviewItemId);

    if (result.changes === 0) {
      return null;
    }

    db.prepare(`
      UPDATE review_queue_items
      SET updated_at = ?
      WHERE id = ?
    `).run(now, input.reviewItemId);

    const row = db.prepare(`
      ${this.getReviewQueueSelectSql()}
      WHERE items.id = ?
      LIMIT 1
    `).get(input.reviewItemId) as SQLiteRow | undefined;

    return row ? this.rowToItem(row) : null;
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
      failureCapability: this.parseFailureCapability(row.failure_capability),
      failureAsset: this.parseFailureAsset(row),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  private getReviewQueueSelectSql(): string {
    return `
      SELECT
        items.id,
        items.trace_id,
        items.trace_source,
        items.session_id,
        items.replay_key,
        items.session_title,
        items.reason,
        items.source,
        items.failure_capability,
        items.created_at,
        items.updated_at,
        assets.id AS failure_asset_id,
        assets.review_item_id AS failure_asset_review_item_id,
        assets.session_id AS failure_asset_session_id,
        assets.trace_id AS failure_asset_trace_id,
        assets.status AS failure_asset_status,
        assets.sink AS failure_asset_sink,
        assets.category AS failure_asset_category,
        assets.title AS failure_asset_title,
        assets.body AS failure_asset_body,
        assets.step_index AS failure_asset_step_index,
        assets.confidence AS failure_asset_confidence,
        assets.evidence AS failure_asset_evidence,
        assets.created_at AS failure_asset_created_at,
        assets.updated_at AS failure_asset_updated_at
      FROM review_queue_items items
      LEFT JOIN review_queue_failure_assets assets
        ON assets.review_item_id = items.id
    `;
  }

  private ensureColumn(db: Database.Database, tableName: string, columnName: string, definition: string): void {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  private serializeFailureCapability(
    metadata: ReviewQueueFailureCapabilityMetadata | undefined,
  ): string | null {
    if (!metadata) {
      return null;
    }

    return JSON.stringify(metadata);
  }

  private upsertFailureAsset(db: Database.Database, asset: ReviewQueueFailureCapabilityAsset): void {
    db.prepare(`
      INSERT INTO review_queue_failure_assets (
        id,
        review_item_id,
        session_id,
        trace_id,
        status,
        sink,
        category,
        title,
        body,
        step_index,
        confidence,
        evidence,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(review_item_id) DO UPDATE SET
        session_id = excluded.session_id,
        trace_id = excluded.trace_id,
        status = excluded.status,
        sink = excluded.sink,
        category = excluded.category,
        title = excluded.title,
        body = excluded.body,
        step_index = excluded.step_index,
        confidence = excluded.confidence,
        evidence = excluded.evidence,
        updated_at = excluded.updated_at
    `).run(
      asset.id,
      asset.reviewItemId,
      asset.sessionId,
      asset.traceId,
      asset.status,
      asset.sink,
      asset.category,
      asset.title,
      asset.body,
      asset.stepIndex ?? null,
      asset.confidence ?? null,
      this.serializeNumberArray(asset.evidence),
      asset.createdAt,
      asset.updatedAt,
    );
  }

  private deleteFailureAsset(db: Database.Database, reviewItemId: string): void {
    db.prepare(`
      DELETE FROM review_queue_failure_assets
      WHERE review_item_id = ?
    `).run(reviewItemId);
  }

  private serializeNumberArray(values: number[] | undefined): string | null {
    if (!values?.length) {
      return null;
    }

    return JSON.stringify(values);
  }

  private parseFailureCapability(value: unknown): ReviewQueueFailureCapabilityMetadata | undefined {
    if (typeof value !== 'string' || value.length === 0) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(value) as Partial<ReviewQueueFailureCapabilityMetadata>;
      if (!parsed || typeof parsed !== 'object') {
        return undefined;
      }
      if (
        parsed.sink !== 'skill'
        && parsed.sink !== 'dataset'
        && parsed.sink !== 'prompt_policy'
        && parsed.sink !== 'capability_health'
      ) {
        return undefined;
      }
      if (
        parsed.category !== 'tool_error'
        && parsed.category !== 'bad_decision'
        && parsed.category !== 'missing_context'
        && parsed.category !== 'loop'
        && parsed.category !== 'hallucination'
        && parsed.category !== 'env_failure'
        && parsed.category !== 'deviation'
        && parsed.category !== 'unknown'
      ) {
        return undefined;
      }

      return {
        sink: parsed.sink,
        category: parsed.category,
        summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
        stepIndex: typeof parsed.stepIndex === 'number' ? parsed.stepIndex : undefined,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
        evidence: Array.isArray(parsed.evidence)
          ? parsed.evidence.filter((item): item is number => typeof item === 'number')
          : undefined,
      };
    } catch {
      return undefined;
    }
  }

  private parseFailureAsset(row: SQLiteRow): ReviewQueueFailureCapabilityAsset | undefined {
    if (typeof row.failure_asset_id !== 'string') {
      return undefined;
    }
    if (
      row.failure_asset_status !== 'draft'
      && row.failure_asset_status !== 'ready'
      && row.failure_asset_status !== 'applied'
      && row.failure_asset_status !== 'dismissed'
    ) {
      return undefined;
    }
    if (
      row.failure_asset_sink !== 'skill'
      && row.failure_asset_sink !== 'dataset'
      && row.failure_asset_sink !== 'prompt_policy'
      && row.failure_asset_sink !== 'capability_health'
    ) {
      return undefined;
    }
    if (
      row.failure_asset_category !== 'tool_error'
      && row.failure_asset_category !== 'bad_decision'
      && row.failure_asset_category !== 'missing_context'
      && row.failure_asset_category !== 'loop'
      && row.failure_asset_category !== 'hallucination'
      && row.failure_asset_category !== 'env_failure'
      && row.failure_asset_category !== 'deviation'
      && row.failure_asset_category !== 'unknown'
    ) {
      return undefined;
    }

    return {
      id: row.failure_asset_id,
      reviewItemId: row.failure_asset_review_item_id as string,
      sessionId: row.failure_asset_session_id as string,
      traceId: row.failure_asset_trace_id as string,
      status: row.failure_asset_status,
      sink: row.failure_asset_sink,
      category: row.failure_asset_category,
      title: row.failure_asset_title as string,
      body: row.failure_asset_body as string,
      stepIndex: typeof row.failure_asset_step_index === 'number' ? row.failure_asset_step_index : undefined,
      confidence: typeof row.failure_asset_confidence === 'number' ? row.failure_asset_confidence : undefined,
      evidence: this.parseNumberArray(row.failure_asset_evidence),
      createdAt: Number(row.failure_asset_created_at ?? 0),
      updatedAt: Number(row.failure_asset_updated_at ?? 0),
    };
  }

  private parseNumberArray(value: unknown): number[] | undefined {
    if (typeof value !== 'string' || value.length === 0) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        return undefined;
      }
      const numbers = parsed.filter((item): item is number => typeof item === 'number');
      return numbers.length > 0 ? numbers : undefined;
    } catch {
      return undefined;
    }
  }
}

let reviewQueueServiceInstance: ReviewQueueService | null = null;

export function getReviewQueueService(): ReviewQueueService {
  if (!reviewQueueServiceInstance) {
    reviewQueueServiceInstance = ReviewQueueService.getInstance();
  }
  return reviewQueueServiceInstance;
}
