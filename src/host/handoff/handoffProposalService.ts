// ============================================================================
// Handoff Proposal Service
// ============================================================================

import type Database from 'better-sqlite3';
import type {
  CreateHandoffProposalInput,
  HandoffProposal,
  HandoffProposalSource,
  HandoffProposalStatus,
  ListHandoffProposalsInput,
  UpdateHandoffProposalStatusInput,
} from '../../shared/contract/handoff';
import {
  buildHandoffProposalId,
  isHandoffProposalSource,
  isHandoffProposalStatus,
} from '../../shared/contract/handoff';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('HandoffProposalService');

type SQLiteRow = Record<string, unknown>;

function clamp(value: string, limit: number): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, limit);
}

export class HandoffProposalService {
  private static instance: HandoffProposalService | null = null;
  private schemaReady = false;

  static getInstance(): HandoffProposalService {
    if (!this.instance) {
      this.instance = new HandoffProposalService();
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
      CREATE TABLE IF NOT EXISTS handoff_proposals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_handoff_proposals_session_status_updated
      ON handoff_proposals(session_id, status, updated_at DESC)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_handoff_proposals_updated_at
      ON handoff_proposals(updated_at DESC)
    `);
    this.schemaReady = true;
  }

  list(input: ListHandoffProposalsInput = {}): HandoffProposal[] {
    try {
      const db = this.getDb();
      const status = input.status ?? 'pending';
      const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
      const where: string[] = [];
      const params: unknown[] = [];

      if (input.sessionId?.trim()) {
        where.push('session_id = ?');
        params.push(input.sessionId.trim());
      }
      if (status !== 'all') {
        if (!isHandoffProposalStatus(status)) {
          throw new Error(`Invalid handoff status: ${String(status)}`);
        }
        where.push('status = ?');
        params.push(status);
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db.prepare(`
        SELECT *
        FROM handoff_proposals
        ${whereSql}
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(...params, limit) as SQLiteRow[];

      return rows.map((row) => this.rowToProposal(row)).filter(Boolean) as HandoffProposal[];
    } catch (error) {
      logger.error('Failed to list handoff proposals', error);
      return [];
    }
  }

  create(input: CreateHandoffProposalInput): HandoffProposal {
    const sessionId = input.sessionId.trim();
    const sourceMessageId = input.sourceMessageId.trim();
    const title = clamp(input.title, 120);
    const prompt = clamp(input.prompt, 4000);
    const reason = input.reason ? clamp(input.reason, 280) : null;
    const source = input.source ?? 'assistant_tail';
    if (!sessionId) throw new Error('sessionId is required');
    if (!sourceMessageId) throw new Error('sourceMessageId is required');
    if (!isHandoffProposalSource(source)) throw new Error(`Invalid handoff source: ${String(source)}`);
    if (!title) throw new Error('title is required');
    if (!prompt) throw new Error('prompt is required');

    const db = this.getDb();
    const duplicate = db.prepare(`
      SELECT *
      FROM handoff_proposals
      WHERE session_id = ?
        AND status = 'pending'
        AND prompt = ?
      LIMIT 1
    `).get(sessionId, prompt) as SQLiteRow | undefined;
    if (duplicate) {
      return this.rowToProposal(duplicate);
    }

    const now = input.createdAt ?? Date.now();
    const id = buildHandoffProposalId(sessionId, sourceMessageId);
    db.prepare(`
      INSERT INTO handoff_proposals (
        id,
        session_id,
        source_message_id,
        source,
        status,
        title,
        prompt,
        reason,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        title = excluded.title,
        prompt = excluded.prompt,
        reason = excluded.reason,
        status = CASE
          WHEN handoff_proposals.status = 'pending' THEN excluded.status
          ELSE handoff_proposals.status
        END,
        updated_at = excluded.updated_at
    `).run(
      id,
      sessionId,
      sourceMessageId,
      source,
      title,
      prompt,
      reason,
      now,
      now,
    );

    const row = db.prepare(`
      SELECT *
      FROM handoff_proposals
      WHERE id = ?
      LIMIT 1
    `).get(id) as SQLiteRow | undefined;
    if (!row) {
      throw new Error(`Failed to load handoff proposal after create: ${id}`);
    }

    return this.rowToProposal(row);
  }

  updateStatus(input: UpdateHandoffProposalStatusInput): HandoffProposal | null {
    const id = input.id.trim();
    if (!id) throw new Error('id is required');
    if (!isHandoffProposalStatus(input.status)) {
      throw new Error(`Invalid handoff status: ${String(input.status)}`);
    }

    const db = this.getDb();
    const now = input.updatedAt ?? Date.now();
    const result = db.prepare(`
      UPDATE handoff_proposals
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(input.status, now, id);
    if (result.changes === 0) {
      return null;
    }

    const row = db.prepare(`
      SELECT *
      FROM handoff_proposals
      WHERE id = ?
      LIMIT 1
    `).get(id) as SQLiteRow | undefined;
    return row ? this.rowToProposal(row) : null;
  }

  private rowToProposal(row: SQLiteRow): HandoffProposal {
    const status = row.status as HandoffProposalStatus;
    const source = isHandoffProposalSource(row.source) ? row.source : 'assistant_tail';
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      sourceMessageId: row.source_message_id as string,
      source: source as HandoffProposalSource,
      status,
      title: row.title as string,
      prompt: row.prompt as string,
      reason: typeof row.reason === 'string' && row.reason.length > 0 ? row.reason : undefined,
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }
}

let handoffProposalServiceInstance: HandoffProposalService | null = null;

export function getHandoffProposalService(): HandoffProposalService {
  if (!handoffProposalServiceInstance) {
    handoffProposalServiceInstance = HandoffProposalService.getInstance();
  }
  return handoffProposalServiceInstance;
}
