// ============================================================================
// Evidence Graph Schema Tests
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 还原全局 mock，使用真实 better-sqlite3
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { EVIDENCE_GRAPH_SCHEMA } from '../../../../src/main/evaluation/evidence/schema';

describe('Evidence Graph Schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('DDL 执行无错误', () => {
    expect(() => db.exec(EVIDENCE_GRAPH_SCHEMA)).not.toThrow();
  });

  it('创建所有 6 张表', () => {
    db.exec(EVIDENCE_GRAPH_SCHEMA);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name).sort();
    expect(names).toEqual([
      'category_snapshots',
      'evidence',
      'evidence_proposals',
      'proposal_rules',
      'proposals',
      'rules',
    ]);
  });

  it('evidence 表有正确的列', () => {
    db.exec(EVIDENCE_GRAPH_SCHEMA);
    const cols = db.prepare('PRAGMA table_info(evidence)').all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('session_id');
    expect(colNames).toContain('category');
    expect(colNames).toContain('confidence');
    expect(colNames).toContain('summary');
    expect(colNames).toContain('source_report');
    expect(colNames).toContain('observed_at');
    expect(colNames).toContain('created_at');
  });

  it('evidence.session_id UNIQUE 约束', () => {
    db.exec(EVIDENCE_GRAPH_SCHEMA);
    db.prepare(
      "INSERT INTO evidence (session_id, category, confidence, observed_at) VALUES ('s1', 'loop', 0.8, '2026-01-01')"
    ).run();
    // 重复 session_id 应报错
    expect(() =>
      db.prepare(
        "INSERT INTO evidence (session_id, category, confidence, observed_at) VALUES ('s1', 'loop', 0.9, '2026-01-02')"
      ).run()
    ).toThrow(/UNIQUE/);
  });

  it('proposals.id PRIMARY KEY 约束', () => {
    db.exec(EVIDENCE_GRAPH_SCHEMA);
    db.prepare(
      "INSERT INTO proposals (id, category, status, created_at) VALUES ('prop-001', 'loop', 'pending', '2026-01-01')"
    ).run();
    expect(() =>
      db.prepare(
        "INSERT INTO proposals (id, category, status, created_at) VALUES ('prop-001', 'loop', 'pending', '2026-01-02')"
      ).run()
    ).toThrow(/UNIQUE/);
  });

  it('evidence_proposals 复合主键约束', () => {
    db.exec(EVIDENCE_GRAPH_SCHEMA);
    db.prepare(
      "INSERT INTO evidence (session_id, category, confidence, observed_at) VALUES ('s1', 'loop', 0.8, '2026-01-01')"
    ).run();
    db.prepare(
      "INSERT INTO proposals (id, category, status, created_at) VALUES ('prop-001', 'loop', 'pending', '2026-01-01')"
    ).run();
    db.prepare('INSERT INTO evidence_proposals (evidence_id, proposal_id) VALUES (1, ?)').run('prop-001');
    expect(() =>
      db.prepare('INSERT INTO evidence_proposals (evidence_id, proposal_id) VALUES (1, ?)').run('prop-001')
    ).toThrow(/UNIQUE/);
  });

  it('schema 幂等：重复执行 DDL 不报错', () => {
    db.exec(EVIDENCE_GRAPH_SCHEMA);
    expect(() => db.exec(EVIDENCE_GRAPH_SCHEMA)).not.toThrow();
  });

  it('创建索引', () => {
    db.exec(EVIDENCE_GRAPH_SCHEMA);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all() as Array<{ name: string }>;
    expect(indexes.length).toBeGreaterThanOrEqual(7);
  });
});
