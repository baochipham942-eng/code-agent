// ============================================================================
// EvidenceDb Tests
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import { EvidenceDb } from '../../../../src/main/evaluation/evidence/evidenceDb';

describe('EvidenceDb', () => {
  let db: EvidenceDb;

  beforeEach(() => {
    db = new EvidenceDb(':memory:');
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  // ---- Initialize ----

  it('initialize 创建所有表', () => {
    const tables = db.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all() as Array<{ name: string }>;
    expect(tables.length).toBe(6);
  });

  it('重复 initialize 不报错', () => {
    expect(() => db.initialize()).not.toThrow();
  });

  // ---- Evidence ----

  it('insertEvidence 返回自增 id', () => {
    const id = db.insertEvidence({
      session_id: 'sess-001',
      category: 'loop',
      confidence: 0.8,
      summary: 'test summary',
      observed_at: '2026-04-01',
    });
    expect(id).toBe(1);
  });

  it('insertEvidence 重复 session_id 幂等', () => {
    const id1 = db.insertEvidence({
      session_id: 'sess-001',
      category: 'loop',
      confidence: 0.8,
      observed_at: '2026-04-01',
    });
    const id2 = db.insertEvidence({
      session_id: 'sess-001',
      category: 'loop',
      confidence: 0.9,
      observed_at: '2026-04-02',
    });
    // INSERT OR IGNORE 返回已有记录 id
    expect(id2).toBe(id1);
  });

  it('insertEvidence 不同 session_id 递增', () => {
    const id1 = db.insertEvidence({
      session_id: 'sess-001',
      category: 'loop',
      confidence: 0.8,
      observed_at: '2026-04-01',
    });
    const id2 = db.insertEvidence({
      session_id: 'sess-002',
      category: 'tool_error',
      confidence: 0.6,
      observed_at: '2026-04-01',
    });
    expect(id2).toBe(id1 + 1);
  });

  // ---- Proposal ----

  it('upsertProposal 插入新记录', () => {
    db.upsertProposal({
      id: 'prop-001',
      category: 'loop',
      status: 'pending',
      created_at: '2026-04-01T00:00:00Z',
    });
    const row = db.getDb().prepare('SELECT * FROM proposals WHERE id = ?').get('prop-001') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.category).toBe('loop');
    expect(row.status).toBe('pending');
  });

  it('upsertProposal 更新已有记录', () => {
    db.upsertProposal({
      id: 'prop-001',
      category: 'loop',
      status: 'pending',
      created_at: '2026-04-01T00:00:00Z',
    });
    db.upsertProposal({
      id: 'prop-001',
      category: 'loop',
      status: 'applied',
      created_at: '2026-04-01T00:00:00Z',
    });
    const row = db.getDb().prepare('SELECT * FROM proposals WHERE id = ?').get('prop-001') as Record<string, unknown>;
    expect(row.status).toBe('applied');
  });

  // ---- Rule ----

  it('upsertRule 插入和更新', () => {
    db.upsertProposal({
      id: 'prop-001',
      category: 'loop',
      status: 'applied',
      created_at: '2026-04-01T00:00:00Z',
    });
    db.upsertRule({
      id: 'exp-001',
      source_proposal_id: 'prop-001',
      rule_content: 'do not loop',
      applied_at: '2026-04-02T00:00:00Z',
      family_id: 'fam-loop',
    });
    const row = db.getDb().prepare('SELECT * FROM rules WHERE id = ?').get('exp-001') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.rule_content).toBe('do not loop');
    expect(row.family_id).toBe('fam-loop');

    // Update
    db.upsertRule({
      id: 'exp-001',
      source_proposal_id: 'prop-001',
      rule_content: 'do not loop v2',
      applied_at: '2026-04-02T00:00:00Z',
      version: 2,
      family_id: 'fam-loop',
    });
    const updated = db.getDb().prepare('SELECT * FROM rules WHERE id = ?').get('exp-001') as Record<string, unknown>;
    expect(updated.rule_content).toBe('do not loop v2');
    expect(updated.version).toBe(2);
  });

  // ---- Link tables ----

  it('linkEvidenceProposal 创建链接', () => {
    const evidId = db.insertEvidence({
      session_id: 'sess-001',
      category: 'loop',
      confidence: 0.8,
      observed_at: '2026-04-01',
    });
    db.upsertProposal({
      id: 'prop-001',
      category: 'loop',
      status: 'pending',
      created_at: '2026-04-01T00:00:00Z',
    });
    db.linkEvidenceProposal(evidId, 'prop-001');

    const link = db.getDb().prepare('SELECT * FROM evidence_proposals WHERE evidence_id = ? AND proposal_id = ?').get(evidId, 'prop-001');
    expect(link).toBeTruthy();
  });

  it('linkEvidenceProposal 幂等', () => {
    const evidId = db.insertEvidence({
      session_id: 'sess-001',
      category: 'loop',
      confidence: 0.8,
      observed_at: '2026-04-01',
    });
    db.upsertProposal({
      id: 'prop-001',
      category: 'loop',
      status: 'pending',
      created_at: '2026-04-01T00:00:00Z',
    });
    db.linkEvidenceProposal(evidId, 'prop-001');
    expect(() => db.linkEvidenceProposal(evidId, 'prop-001')).not.toThrow();
  });

  it('linkProposalRule 创建链接', () => {
    db.upsertProposal({
      id: 'prop-001',
      category: 'loop',
      status: 'applied',
      created_at: '2026-04-01T00:00:00Z',
    });
    db.upsertRule({
      id: 'exp-001',
      rule_content: 'rule',
      applied_at: '2026-04-02T00:00:00Z',
    });
    db.linkProposalRule('prop-001', 'exp-001');

    const link = db.getDb().prepare('SELECT * FROM proposal_rules WHERE proposal_id = ? AND rule_id = ?').get('prop-001', 'exp-001');
    expect(link).toBeTruthy();
  });

  // ---- Snapshot ----

  it('insertSnapshot 返回 id', () => {
    const id = db.insertSnapshot({
      category: 'loop',
      window_start: '2026-03-01',
      window_end: '2026-04-01',
      total_sessions: 100,
      failure_count: 20,
      success_rate: 0.8,
    });
    expect(id).toBe(1);
  });
});
