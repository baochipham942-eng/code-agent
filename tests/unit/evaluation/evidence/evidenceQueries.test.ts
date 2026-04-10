// ============================================================================
// Evidence Graph Query Tests
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import { EvidenceDb } from '../../../../src/main/evaluation/evidence/evidenceDb';
import {
  getRuleCoverage,
  getCategoryImpact,
  getRuleEvolution,
  getRuleEffectiveness,
  getSummary,
} from '../../../../src/main/evaluation/evidence/evidenceQueries';

// ---- Fixture helper: 构建一组完整的 Evidence -> Proposal -> Rule 数据 ----
function seedFixtures(db: EvidenceDb): void {
  // Evidence
  db.insertEvidence({ session_id: 'sess-001', category: 'loop', confidence: 0.9, summary: 'loop detected in bash', observed_at: '2026-04-01' });
  db.insertEvidence({ session_id: 'sess-002', category: 'loop', confidence: 0.7, summary: 'loop in read_file', observed_at: '2026-04-02' });
  db.insertEvidence({ session_id: 'sess-003', category: 'tool_error', confidence: 0.8, summary: 'edit_file failed', observed_at: '2026-04-03' });
  db.insertEvidence({ session_id: 'sess-004', category: 'loop', confidence: 0.6, summary: 'another loop', observed_at: '2026-04-04' });

  // Proposals
  db.upsertProposal({ id: 'prop-001', category: 'loop', status: 'applied', created_at: '2026-04-01T00:00:00Z' });
  db.upsertProposal({ id: 'prop-002', category: 'tool_error', status: 'pending', created_at: '2026-04-03T00:00:00Z' });

  // Evidence-Proposal links
  db.linkEvidenceProposal(1, 'prop-001'); // sess-001 -> prop-001
  db.linkEvidenceProposal(2, 'prop-001'); // sess-002 -> prop-001
  db.linkEvidenceProposal(3, 'prop-002'); // sess-003 -> prop-002

  // Rules
  db.upsertRule({ id: 'exp-001', source_proposal_id: 'prop-001', rule_content: 'anti-loop v1', applied_at: '2026-04-05T00:00:00Z', family_id: 'fam-loop', version: 1 });
  db.upsertRule({ id: 'exp-002', source_proposal_id: 'prop-001', rule_content: 'anti-loop v2', applied_at: '2026-04-10T00:00:00Z', family_id: 'fam-loop', version: 2 });

  // Proposal-Rule links
  db.linkProposalRule('prop-001', 'exp-001');
  db.linkProposalRule('prop-001', 'exp-002');

  // Category snapshots (before and after rule applied)
  // snapshot_at 必须显式指定，否则 DEFAULT datetime('now') 导致时间排序不对
  db.insertSnapshot({ category: 'loop', window_start: '2026-03-01', window_end: '2026-04-01', total_sessions: 50, failure_count: 15, success_rate: 0.7, snapshot_at: '2026-04-01T00:00:00Z' });
  db.insertSnapshot({ category: 'loop', window_start: '2026-04-05', window_end: '2026-04-15', total_sessions: 40, failure_count: 6, success_rate: 0.85, snapshot_at: '2026-04-15T00:00:00Z' });
}

describe('Evidence Queries', () => {
  let db: EvidenceDb;

  beforeEach(() => {
    db = new EvidenceDb(':memory:');
    db.initialize();
    seedFixtures(db);
  });

  afterEach(() => {
    db.close();
  });

  // ---- getRuleCoverage ----

  describe('getRuleCoverage', () => {
    it('返回规则覆盖的 session 和 category', () => {
      const result = getRuleCoverage(db.getDb(), 'exp-001');
      expect(result.sessions).toContain('sess-001');
      expect(result.sessions).toContain('sess-002');
      expect(result.sessions.length).toBe(2);
      expect(result.categories).toContain('loop');
      expect(result.proposalChain).toContain('prop-001');
    });

    it('不存在的 rule 返回空结果', () => {
      const result = getRuleCoverage(db.getDb(), 'exp-999');
      expect(result.sessions).toEqual([]);
      expect(result.categories).toEqual([]);
      expect(result.proposalChain).toEqual([]);
    });
  });

  // ---- getCategoryImpact ----

  describe('getCategoryImpact', () => {
    it('返回 loop category 的完整影响', () => {
      const result = getCategoryImpact(db.getDb(), 'loop');
      expect(result.evidenceCount).toBe(3); // sess-001, sess-002, sess-004
      expect(result.proposals.length).toBe(1);
      expect(result.proposals[0].id).toBe('prop-001');
      expect(result.rules.length).toBe(2);
    });

    it('tool_error category 无关联 rule', () => {
      const result = getCategoryImpact(db.getDb(), 'tool_error');
      expect(result.evidenceCount).toBe(1);
      expect(result.proposals.length).toBe(1);
      expect(result.rules.length).toBe(0); // prop-002 未关联任何 rule
    });

    it('空 category 返回零', () => {
      const result = getCategoryImpact(db.getDb(), 'nonexistent');
      expect(result.evidenceCount).toBe(0);
      expect(result.proposals).toEqual([]);
      expect(result.rules).toEqual([]);
    });
  });

  // ---- getRuleEvolution ----

  describe('getRuleEvolution', () => {
    it('返回 family 版本历史', () => {
      const result = getRuleEvolution(db.getDb(), 'fam-loop');
      expect(result.versions.length).toBe(2);
      expect(result.versions[0].version).toBe(1);
      expect(result.versions[1].version).toBe(2);
      expect(result.proposalIds).toContain('prop-001');
      expect(result.status).toBe('active');
    });

    it('reverted 规则状态正确', () => {
      // 将 v2 标记为 reverted
      db.upsertRule({
        id: 'exp-002',
        source_proposal_id: 'prop-001',
        rule_content: 'anti-loop v2',
        applied_at: '2026-04-10T00:00:00Z',
        reverted_at: '2026-04-12T00:00:00Z',
        family_id: 'fam-loop',
        version: 2,
      });
      const result = getRuleEvolution(db.getDb(), 'fam-loop');
      expect(result.status).toBe('reverted');
    });

    it('不存在的 family 返回空', () => {
      const result = getRuleEvolution(db.getDb(), 'fam-nonexistent');
      expect(result.versions).toEqual([]);
      expect(result.status).toBe('unknown');
    });
  });

  // ---- getRuleEffectiveness ----

  describe('getRuleEffectiveness', () => {
    it('返回前后快照和 delta', () => {
      const result = getRuleEffectiveness(db.getDb(), 'exp-001');
      expect(result.before).toBeTruthy();
      expect(result.after).toBeTruthy();
      expect(result.before!.success_rate).toBe(0.7);
      expect(result.after!.success_rate).toBe(0.85);
      expect(result.delta).toBeCloseTo(0.15);
    });

    it('不存在的 rule 返回 null', () => {
      const result = getRuleEffectiveness(db.getDb(), 'exp-999');
      expect(result.before).toBeNull();
      expect(result.after).toBeNull();
      expect(result.delta).toBeNull();
    });

    it('无关联 proposal 的 rule 返回 null delta', () => {
      db.upsertRule({ id: 'exp-orphan', rule_content: 'orphan', applied_at: '2026-04-05T00:00:00Z' });
      const result = getRuleEffectiveness(db.getDb(), 'exp-orphan');
      expect(result.delta).toBeNull();
    });
  });

  // ---- getSummary ----

  describe('getSummary', () => {
    it('返回总数和 category 分布', () => {
      const result = getSummary(db.getDb());
      expect(result.totalEvidence).toBe(4);
      expect(result.totalProposals).toBe(2);
      expect(result.totalRules).toBe(2);
      expect(result.categoryBreakdown.get('loop')).toBe(3);
      expect(result.categoryBreakdown.get('tool_error')).toBe(1);
    });

    it('空数据库返回零', () => {
      const emptyDb = new EvidenceDb(':memory:');
      emptyDb.initialize();
      const result = getSummary(emptyDb.getDb());
      expect(result.totalEvidence).toBe(0);
      expect(result.totalProposals).toBe(0);
      expect(result.totalRules).toBe(0);
      expect(result.categoryBreakdown.size).toBe(0);
      emptyDb.close();
    });
  });
});
