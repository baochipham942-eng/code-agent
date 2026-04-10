// ============================================================================
// Evidence Graph Schema — V3-beta
//
// SQLite DDL for the Evidence -> Category -> Proposal -> Rule graph.
// Replaces flat evidence_keys in proposal frontmatter with a queryable store.
// ============================================================================

export const EVIDENCE_GRAPH_SCHEMA = `
-- Evidence: 单个 session 级别的失败观察
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  summary TEXT,
  source_report TEXT,  -- grader report 文件路径
  observed_at TEXT NOT NULL,  -- ISO date
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Proposals: 映射 proposal markdown 文件
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,  -- e.g. 'prop-20260409-001'
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  rule_content TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Rules: 已应用的实验
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,  -- e.g. 'exp-001'
  source_proposal_id TEXT REFERENCES proposals(id),
  rule_content TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  reverted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  family_id TEXT  -- 同 family = 同一规则的迭代版本
);

-- Evidence-Proposal 关联
CREATE TABLE IF NOT EXISTS evidence_proposals (
  evidence_id INTEGER REFERENCES evidence(id),
  proposal_id TEXT REFERENCES proposals(id),
  PRIMARY KEY (evidence_id, proposal_id)
);

-- Proposal-Rule 关联
CREATE TABLE IF NOT EXISTS proposal_rules (
  proposal_id TEXT REFERENCES proposals(id),
  rule_id TEXT REFERENCES rules(id),
  PRIMARY KEY (proposal_id, rule_id)
);

-- Category 成功率快照（追踪规则有效性）
CREATE TABLE IF NOT EXISTS category_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  total_sessions INTEGER NOT NULL,
  failure_count INTEGER NOT NULL,
  success_rate REAL NOT NULL,
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 索引：常用查询加速
CREATE INDEX IF NOT EXISTS idx_evidence_category ON evidence(category);
CREATE INDEX IF NOT EXISTS idx_evidence_session ON evidence(session_id);
CREATE INDEX IF NOT EXISTS idx_proposals_category ON proposals(category);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_rules_family ON rules(family_id);
CREATE INDEX IF NOT EXISTS idx_rules_proposal ON rules(source_proposal_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_category ON category_snapshots(category);
`;
