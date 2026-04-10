// ============================================================================
// Evidence Graph Query API — V3-beta
//
// 提供 Evidence <-> Proposal <-> Rule 图上的常用查询。
// 所有查询使用同步 better-sqlite3 API。
// ============================================================================

import type Database from 'better-sqlite3';

// ---- Result Types ----

export interface RuleCoverageResult {
  sessions: string[];
  categories: string[];
  proposalChain: string[];
}

export interface CategoryImpactResult {
  rules: Array<{ id: string; rule_content: string; applied_at: string; version: number }>;
  proposals: Array<{ id: string; status: string; created_at: string }>;
  evidenceCount: number;
}

export interface RuleEvolutionResult {
  versions: Array<{ id: string; version: number; applied_at: string; reverted_at: string | null; rule_content: string }>;
  proposalIds: string[];
  status: string;
}

export interface CategorySnapshot {
  category: string;
  window_start: string;
  window_end: string;
  total_sessions: number;
  failure_count: number;
  success_rate: number;
  snapshot_at: string;
}

export interface RuleEffectivenessResult {
  before: CategorySnapshot | null;
  after: CategorySnapshot | null;
  delta: number | null;
}

export interface SummaryResult {
  totalEvidence: number;
  totalProposals: number;
  totalRules: number;
  categoryBreakdown: Map<string, number>;
}

// ---- Query Functions ----

/**
 * 某条规则覆盖了哪些 session？
 * 路径: Rule -> proposal_rules -> Proposal -> evidence_proposals -> Evidence
 */
export function getRuleCoverage(db: Database.Database, ruleId: string): RuleCoverageResult {
  // 获取关联的 proposal
  const proposalRows = db.prepare(`
    SELECT DISTINCT p.id
    FROM proposal_rules pr
    JOIN proposals p ON pr.proposal_id = p.id
    WHERE pr.rule_id = ?
  `).all(ruleId) as Array<{ id: string }>;

  const proposalChain = proposalRows.map(r => r.id);

  // 获取关联的 evidence
  const evidenceRows = db.prepare(`
    SELECT DISTINCT e.session_id, e.category
    FROM proposal_rules pr
    JOIN evidence_proposals ep ON pr.proposal_id = ep.proposal_id
    JOIN evidence e ON ep.evidence_id = e.id
    WHERE pr.rule_id = ?
  `).all(ruleId) as Array<{ session_id: string; category: string }>;

  const sessions = [...new Set(evidenceRows.map(r => r.session_id))];
  const categories = [...new Set(evidenceRows.map(r => r.category))];

  return { sessions, categories, proposalChain };
}

/**
 * 某个失败类别有哪些规则在解决？
 */
export function getCategoryImpact(db: Database.Database, category: string): CategoryImpactResult {
  const rules = db.prepare(`
    SELECT DISTINCT r.id, r.rule_content, r.applied_at, r.version
    FROM rules r
    JOIN proposal_rules pr ON r.id = pr.rule_id
    JOIN proposals p ON pr.proposal_id = p.id
    WHERE p.category = ?
    ORDER BY r.applied_at DESC
  `).all(category) as CategoryImpactResult['rules'];

  const proposals = db.prepare(`
    SELECT id, status, created_at
    FROM proposals
    WHERE category = ?
    ORDER BY created_at DESC
  `).all(category) as CategoryImpactResult['proposals'];

  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM evidence
    WHERE category = ?
  `).get(category) as { cnt: number } | undefined;

  return {
    rules,
    proposals,
    evidenceCount: countRow?.cnt ?? 0,
  };
}

/**
 * 某个规则家族的版本演进历史
 */
export function getRuleEvolution(db: Database.Database, familyId: string): RuleEvolutionResult {
  const versions = db.prepare(`
    SELECT id, version, applied_at, reverted_at, rule_content
    FROM rules
    WHERE family_id = ?
    ORDER BY version ASC
  `).all(familyId) as RuleEvolutionResult['versions'];

  // 关联的 proposal
  const proposalRows = db.prepare(`
    SELECT DISTINCT pr.proposal_id
    FROM proposal_rules pr
    JOIN rules r ON pr.rule_id = r.id
    WHERE r.family_id = ?
  `).all(familyId) as Array<{ proposal_id: string }>;

  const proposalIds = proposalRows.map(r => r.proposal_id);

  // 当前状态：最新版本是否被 revert
  let status = 'unknown';
  if (versions.length > 0) {
    const latest = versions[versions.length - 1];
    status = latest.reverted_at ? 'reverted' : 'active';
  }

  return { versions, proposalIds, status };
}

/**
 * 规则应用前后，对应 category 的失败率变化
 * 取 rule applied_at 之前最近的快照作 before，之后最近的作 after
 */
export function getRuleEffectiveness(db: Database.Database, ruleId: string): RuleEffectivenessResult {
  const rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(ruleId) as {
    id: string;
    source_proposal_id: string | null;
    applied_at: string;
  } | undefined;

  if (!rule) return { before: null, after: null, delta: null };

  // 找 rule 关联的 category（通过 proposal）
  const proposalRow = db.prepare(`
    SELECT p.category
    FROM proposal_rules pr
    JOIN proposals p ON pr.proposal_id = p.id
    WHERE pr.rule_id = ?
    LIMIT 1
  `).get(ruleId) as { category: string } | undefined;

  if (!proposalRow) return { before: null, after: null, delta: null };

  const category = proposalRow.category;

  const before = db.prepare(`
    SELECT category, window_start, window_end, total_sessions, failure_count, success_rate, snapshot_at
    FROM category_snapshots
    WHERE category = ? AND snapshot_at <= ?
    ORDER BY snapshot_at DESC
    LIMIT 1
  `).get(category, rule.applied_at) as CategorySnapshot | undefined;

  const after = db.prepare(`
    SELECT category, window_start, window_end, total_sessions, failure_count, success_rate, snapshot_at
    FROM category_snapshots
    WHERE category = ? AND snapshot_at > ?
    ORDER BY snapshot_at ASC
    LIMIT 1
  `).get(category, rule.applied_at) as CategorySnapshot | undefined;

  const delta = (before && after) ? after.success_rate - before.success_rate : null;

  return {
    before: before ?? null,
    after: after ?? null,
    delta,
  };
}

/**
 * Dashboard 概览
 */
export function getSummary(db: Database.Database): SummaryResult {
  const evidenceCount = (db.prepare('SELECT COUNT(*) as cnt FROM evidence').get() as { cnt: number }).cnt;
  const proposalCount = (db.prepare('SELECT COUNT(*) as cnt FROM proposals').get() as { cnt: number }).cnt;
  const ruleCount = (db.prepare('SELECT COUNT(*) as cnt FROM rules').get() as { cnt: number }).cnt;

  const categoryRows = db.prepare(`
    SELECT category, COUNT(*) as cnt
    FROM evidence
    GROUP BY category
    ORDER BY cnt DESC
  `).all() as Array<{ category: string; cnt: number }>;

  const categoryBreakdown = new Map<string, number>();
  for (const row of categoryRows) {
    categoryBreakdown.set(row.category, row.cnt);
  }

  return {
    totalEvidence: evidenceCount,
    totalProposals: proposalCount,
    totalRules: ruleCount,
    categoryBreakdown,
  };
}
