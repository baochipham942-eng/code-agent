// ============================================================================
// Evidence Database Manager — V3-beta
//
// Manages the SQLite database for the evidence graph. Uses better-sqlite3
// (synchronous API) for simplicity.
// ============================================================================

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as os from 'node:os';
import { EVIDENCE_GRAPH_SCHEMA } from './schema';

export const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  '.claude',
  'evidence-graph.db'
);

export class EvidenceDb {
  private db: Database.Database;

  /**
   * @param dbPath 数据库文件路径，传 ':memory:' 用于测试
   */
  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath);
    // WAL 模式提升并发读性能
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  /** 执行 DDL 创建所有表和索引 */
  initialize(): void {
    this.db.exec(EVIDENCE_GRAPH_SCHEMA);
  }

  /** 获取底层 Database 实例（供 query 层使用） */
  getDb(): Database.Database {
    return this.db;
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }

  // ---- Evidence CRUD ----

  insertEvidence(params: {
    session_id: string;
    category: string;
    confidence: number;
    summary?: string;
    source_report?: string;
    observed_at: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO evidence (session_id, category, confidence, summary, source_report, observed_at)
      VALUES (@session_id, @category, @confidence, @summary, @source_report, @observed_at)
    `);
    // better-sqlite3 要求所有命名参数都存在，undefined 需转为 null
    const result = stmt.run({
      ...params,
      summary: params.summary ?? null,
      source_report: params.source_report ?? null,
    });
    // INSERT OR IGNORE 时如果已存在，changes=0，返回已有记录的 id
    if (result.changes === 0) {
      const existing = this.db.prepare('SELECT id FROM evidence WHERE session_id = ?').get(params.session_id) as { id: number } | undefined;
      return existing?.id ?? 0;
    }
    return Number(result.lastInsertRowid);
  }

  // ---- Proposal CRUD ----

  upsertProposal(params: {
    id: string;
    category: string;
    status: string;
    rule_content?: string;
    created_at: string;
    updated_at?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO proposals (id, category, status, rule_content, created_at, updated_at)
      VALUES (@id, @category, @status, @rule_content, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        category = excluded.category,
        status = excluded.status,
        rule_content = excluded.rule_content,
        updated_at = excluded.updated_at
    `);
    stmt.run({
      ...params,
      updated_at: params.updated_at ?? new Date().toISOString(),
      rule_content: params.rule_content ?? null,
    });
  }

  // ---- Rule CRUD ----

  upsertRule(params: {
    id: string;
    source_proposal_id?: string;
    rule_content: string;
    applied_at: string;
    reverted_at?: string;
    version?: number;
    family_id?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO rules (id, source_proposal_id, rule_content, applied_at, reverted_at, version, family_id)
      VALUES (@id, @source_proposal_id, @rule_content, @applied_at, @reverted_at, @version, @family_id)
      ON CONFLICT(id) DO UPDATE SET
        source_proposal_id = excluded.source_proposal_id,
        rule_content = excluded.rule_content,
        applied_at = excluded.applied_at,
        reverted_at = excluded.reverted_at,
        version = excluded.version,
        family_id = excluded.family_id
    `);
    stmt.run({
      ...params,
      source_proposal_id: params.source_proposal_id ?? null,
      reverted_at: params.reverted_at ?? null,
      version: params.version ?? 1,
      family_id: params.family_id ?? null,
    });
  }

  // ---- Link tables ----

  linkEvidenceProposal(evidenceId: number, proposalId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO evidence_proposals (evidence_id, proposal_id)
      VALUES (?, ?)
    `).run(evidenceId, proposalId);
  }

  linkProposalRule(proposalId: string, ruleId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO proposal_rules (proposal_id, rule_id)
      VALUES (?, ?)
    `).run(proposalId, ruleId);
  }

  // ---- Category Snapshots ----

  insertSnapshot(params: {
    category: string;
    window_start: string;
    window_end: string;
    total_sessions: number;
    failure_count: number;
    success_rate: number;
    snapshot_at?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO category_snapshots (category, window_start, window_end, total_sessions, failure_count, success_rate, snapshot_at)
      VALUES (@category, @window_start, @window_end, @total_sessions, @failure_count, @success_rate, @snapshot_at)
    `);
    const result = stmt.run({
      ...params,
      snapshot_at: params.snapshot_at ?? new Date().toISOString(),
    });
    return Number(result.lastInsertRowid);
  }
}
