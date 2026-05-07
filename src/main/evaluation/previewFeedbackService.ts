import type Database from 'better-sqlite3';
import type {
  CreatePreviewFeedbackInput,
  ListPreviewFeedbackInput,
  PreviewFeedbackChatContext,
  PreviewFeedbackItem,
  UpdatePreviewFeedbackStatusInput,
} from '../../shared/contract/previewFeedback';
import { isPreviewFeedbackStatus } from '../../shared/contract/previewFeedback';
import type { ScenarioAcceptanceIssue } from '../../shared/contract/scenarioAcceptance';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('PreviewFeedbackService');

type SQLiteRow = Record<string, unknown>;

function defaultAnchor(): PreviewFeedbackItem['anchor'] {
  return { kind: 'artifact' };
}

function buildFeedbackId(input: CreatePreviewFeedbackInput): string {
  const suffix = input.reviewCheckId || input.issueCode || String(input.createdAt ?? Date.now());
  return `preview-feedback:${input.sessionId}:${input.previewItemId}:${suffix}`.replace(/\s+/g, '-');
}

export class PreviewFeedbackService {
  private static instance: PreviewFeedbackService | null = null;
  private schemaReady = false;

  static getInstance(): PreviewFeedbackService {
    if (!this.instance) {
      this.instance = new PreviewFeedbackService();
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
    if (this.schemaReady) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS preview_feedback_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        preview_item_id TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        note TEXT NOT NULL,
        anchor TEXT NOT NULL,
        review_id TEXT,
        review_check_id TEXT,
        issue_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_preview_feedback_session_preview
      ON preview_feedback_items(session_id, preview_item_id, updated_at DESC)
    `);
    this.schemaReady = true;
  }

  list(input: ListPreviewFeedbackInput): PreviewFeedbackItem[] {
    if (!input.sessionId?.trim()) {
      throw new Error('sessionId is required');
    }

    const where = ['session_id = ?'];
    const params: unknown[] = [input.sessionId];
    if (input.previewItemId) {
      where.push('preview_item_id = ?');
      params.push(input.previewItemId);
    }
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }

    try {
      const rows = this.getDb().prepare(`
        SELECT *
        FROM preview_feedback_items
        WHERE ${where.join(' AND ')}
        ORDER BY updated_at DESC
      `).all(...params) as SQLiteRow[];
      return rows.map((row) => this.rowToItem(row)).filter((item): item is PreviewFeedbackItem => Boolean(item));
    } catch (error) {
      logger.error('Failed to list preview feedback', error);
      return [];
    }
  }

  create(input: CreatePreviewFeedbackInput): PreviewFeedbackItem {
    if (!input.sessionId?.trim()) throw new Error('sessionId is required');
    if (!input.previewItemId?.trim()) throw new Error('previewItemId is required');
    if (!input.note?.trim()) throw new Error('note is required');

    const now = input.createdAt ?? Date.now();
    const updatedAt = input.updatedAt ?? now;
    const item: PreviewFeedbackItem = {
      id: input.id || buildFeedbackId({ ...input, createdAt: now }),
      sessionId: input.sessionId,
      previewItemId: input.previewItemId,
      status: 'open',
      source: input.source || 'user',
      note: input.note.trim(),
      anchor: input.anchor || defaultAnchor(),
      reviewId: input.reviewId,
      reviewCheckId: input.reviewCheckId,
      issueCode: input.issueCode,
      createdAt: now,
      updatedAt,
    };

    const db = this.getDb();
    db.prepare(`
      INSERT INTO preview_feedback_items (
        id,
        session_id,
        preview_item_id,
        status,
        source,
        note,
        anchor,
        review_id,
        review_check_id,
        issue_code,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        source = excluded.source,
        note = excluded.note,
        anchor = excluded.anchor,
        review_id = excluded.review_id,
        review_check_id = excluded.review_check_id,
        issue_code = excluded.issue_code,
        updated_at = excluded.updated_at
    `).run(
      item.id,
      item.sessionId,
      item.previewItemId,
      item.status,
      item.source,
      item.note,
      JSON.stringify(item.anchor),
      item.reviewId ?? null,
      item.reviewCheckId ?? null,
      item.issueCode ?? null,
      item.createdAt,
      item.updatedAt,
    );

    return this.rowToItem(db.prepare(`
      SELECT * FROM preview_feedback_items WHERE id = ? LIMIT 1
    `).get(item.id) as SQLiteRow) as PreviewFeedbackItem;
  }

  createFromIssue(sessionId: string, reviewId: string, issue: ScenarioAcceptanceIssue): PreviewFeedbackItem {
    return this.create({
      id: `preview-feedback:${sessionId}:${issue.id}`,
      sessionId,
      previewItemId: issue.artifactId,
      source: 'delivery_review',
      note: `${issue.title}: ${issue.message}\nFix: ${issue.repairInstruction}`,
      anchor: issue.anchor,
      reviewId,
      reviewCheckId: issue.id,
      issueCode: issue.code,
      createdAt: Date.now(),
    });
  }

  updateStatus(input: UpdatePreviewFeedbackStatusInput): PreviewFeedbackItem | null {
    if (!input.id?.trim()) throw new Error('id is required');
    if (!isPreviewFeedbackStatus(input.status)) {
      throw new Error(`Invalid preview feedback status: ${String(input.status)}`);
    }

    const db = this.getDb();
    const updatedAt = input.updatedAt ?? Date.now();
    const result = db.prepare(`
      UPDATE preview_feedback_items
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(input.status, updatedAt, input.id);
    if (result.changes === 0) return null;

    const row = db.prepare(`
      SELECT * FROM preview_feedback_items WHERE id = ? LIMIT 1
    `).get(input.id) as SQLiteRow | undefined;
    return row ? this.rowToItem(row) ?? null : null;
  }

  buildChatContext(input: { sessionId: string; previewItemId?: string; includeResolved?: boolean }): PreviewFeedbackChatContext {
    const items = this.list({ sessionId: input.sessionId, previewItemId: input.previewItemId })
      .filter((item) => input.includeResolved || item.status === 'open' || item.status === 'sent');
    const lines = [
      '请基于这些 Preview feedback 修复当前交付物：',
      ...items.map((item, index) => {
        const anchor = formatAnchor(item.anchor);
        return `${index + 1}. [${item.issueCode || item.source}] ${item.note}${anchor ? ` (${anchor})` : ''}`;
      }),
    ];
    return {
      message: items.length > 0 ? lines.join('\n') : '',
      items,
    };
  }

  private rowToItem(row: SQLiteRow | undefined): PreviewFeedbackItem | undefined {
    if (!row) return undefined;
    const status = row.status;
    if (!isPreviewFeedbackStatus(status)) return undefined;
    const source = row.source === 'delivery_review' ? 'delivery_review' : 'user';

    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      previewItemId: row.preview_item_id as string,
      status,
      source,
      note: row.note as string,
      anchor: parseAnchor(row.anchor),
      reviewId: typeof row.review_id === 'string' ? row.review_id : undefined,
      reviewCheckId: typeof row.review_check_id === 'string' ? row.review_check_id : undefined,
      issueCode: typeof row.issue_code === 'string' ? row.issue_code : undefined,
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }
}

function parseAnchor(value: unknown): PreviewFeedbackItem['anchor'] {
  if (typeof value !== 'string' || !value.trim()) return defaultAnchor();
  try {
    const parsed = JSON.parse(value) as PreviewFeedbackItem['anchor'];
    return parsed && typeof parsed === 'object' ? parsed : defaultAnchor();
  } catch {
    return defaultAnchor();
  }
}

function formatAnchor(anchor: PreviewFeedbackItem['anchor']): string {
  if (anchor.kind === 'file_line' && anchor.filePath) {
    return `${anchor.filePath}:${anchor.lineStart ?? 1}`;
  }
  if (anchor.kind === 'html_selector' && anchor.selector) {
    return anchor.selector;
  }
  if (anchor.kind === 'text_quote' && anchor.quote) {
    return `"${anchor.quote.slice(0, 80)}"`;
  }
  if (anchor.kind === 'diff_hunk' && anchor.hunk) {
    return anchor.hunk.slice(0, 80);
  }
  return anchor.filePath || '';
}

let previewFeedbackServiceInstance: PreviewFeedbackService | null = null;

export function getPreviewFeedbackService(): PreviewFeedbackService {
  if (!previewFeedbackServiceInstance) {
    previewFeedbackServiceInstance = PreviewFeedbackService.getInstance();
  }
  return previewFeedbackServiceInstance;
}
