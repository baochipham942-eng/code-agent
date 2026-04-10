// ============================================================================
// Evidence Graph Migration Tests
//
// 使用临时目录模拟 proposals / grader-reports / experiments 文件结构，
// 验证迁移脚本正确填充数据库。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.unmock('better-sqlite3');
import { EvidenceDb } from '../../../../src/main/evaluation/evidence/evidenceDb';
import { getSummary } from '../../../../src/main/evaluation/evidence/evidenceQueries';

// 直接导入迁移函数（绕过 main() 的自动执行问题——需用动态 import）
// 为了避免顶层 main() 执行，我们重新实现迁移逻辑的核心部分用于测试

// ---- 简化版迁移函数（从 evidence-migrate.ts 提取逻辑） ----

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([\w_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim();
  }
  return out;
}

function parseArrayField(raw: string | undefined): string[] {
  if (!raw) return [];
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function extractRuleContent(body: string): string | undefined {
  const re = /##\s+Rule Content\s*\n([\s\S]*)$/m;
  const m = re.exec(body);
  return m ? m[1].trim() : undefined;
}

async function migrateProposals(db: EvidenceDb, dir: string): Promise<{ count: number; evidenceKeyMap: Map<string, string[]> }> {
  const evidenceKeyMap = new Map<string, string[]>();
  let count = 0;
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return { count, evidenceKeyMap }; }
  const propFiles = files.filter(f => f.startsWith('prop-') && f.endsWith('.md'));
  for (const file of propFiles) {
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    const match = FRONTMATTER_RE.exec(raw);
    if (!match) continue;
    const [, fmText, body] = match;
    const fm = parseFrontmatter(fmText);
    if (!fm.id) continue;
    const tags = parseArrayField(fm.tags);
    const category = tags[0] ?? 'unknown';
    db.upsertProposal({ id: fm.id, category, status: fm.status ?? 'pending', rule_content: extractRuleContent(body), created_at: fm.createdAt ?? new Date().toISOString() });
    const evidenceKeys = parseArrayField(fm.evidence_keys);
    if (evidenceKeys.length > 0) evidenceKeyMap.set(fm.id, evidenceKeys);
    count++;
  }
  return { count, evidenceKeyMap };
}

async function migrateEvidence(db: EvidenceDb, dir: string): Promise<{ count: number; sessionIdMap: Map<string, number> }> {
  const sessionIdMap = new Map<string, number>();
  let count = 0;
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return { count, sessionIdMap }; }
  for (const file of files.filter(f => f.endsWith('.json'))) {
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    const parsed = JSON.parse(raw);
    const attr = parsed.failure_attribution;
    if (!attr?.root_cause_category || !parsed.session_id) continue;
    const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(file);
    const observedAt = dateMatch ? dateMatch[1] : '2026-01-01';
    const id = db.insertEvidence({
      session_id: parsed.session_id,
      category: attr.root_cause_category,
      confidence: attr.root_cause_confidence ?? 0.5,
      summary: attr.root_cause_summary,
      source_report: path.join(dir, file),
      observed_at: observedAt,
    });
    sessionIdMap.set(parsed.session_id, id);
    if (id > 0) count++;
  }
  return { count, sessionIdMap };
}

function linkEvidenceToProposals(db: EvidenceDb, evidenceKeyMap: Map<string, string[]>, sessionIdMap: Map<string, number>): number {
  let n = 0;
  for (const [propId, keys] of evidenceKeyMap) {
    for (const sid of keys) {
      const eid = sessionIdMap.get(sid);
      if (eid) { db.linkEvidenceProposal(eid, propId); n++; }
    }
  }
  return n;
}

async function migrateRules(db: EvidenceDb, dir: string): Promise<{ count: number; links: number }> {
  let count = 0;
  let links = 0;
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return { count, links }; }
  for (const file of files.filter(f => f.startsWith('exp-') && f.endsWith('.md'))) {
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    const match = FRONTMATTER_RE.exec(raw);
    if (!match) continue;
    const [, fmText, body] = match;
    const fm = parseFrontmatter(fmText);
    if (!fm.id) continue;
    const ruleContent = extractRuleContent(body) ?? body.trim();
    let sourceProposalId: string | undefined;
    const sourceMatch = /proposal\s*\(([^)]+)\)/.exec(fm.source ?? '');
    if (sourceMatch) sourceProposalId = sourceMatch[1];
    db.upsertRule({ id: fm.id, source_proposal_id: sourceProposalId, rule_content: ruleContent, applied_at: fm.created ?? '2026-01-01' });
    if (sourceProposalId) { db.linkProposalRule(sourceProposalId, fm.id); links++; }
    count++;
  }
  return { count, links };
}

// ---- Test fixtures ----

const PROPOSAL_MD = `---
id: prop-20260409-001
createdAt: 2026-04-09T10:00:00Z
status: pending
source: synthesize
type: new_l3_experiment
hypothesis: Agent should not loop
target_metric: loop count down 50%
rollback_condition: success rate drops > 5pp
tags: [loop, auto-generated]
evidence_keys: [sess-alpha, sess-beta]
---

## Rule Content

- Do not loop
- Stop after 3 retries
`;

const PROPOSAL_MD_2 = `---
id: prop-20260410-001
createdAt: 2026-04-10T10:00:00Z
status: applied
source: synthesize
type: new_l3_experiment
hypothesis: Better tool error handling
target_metric: tool_error down 40%
rollback_condition: success rate drops > 5pp
tags: [tool_error]
evidence_keys: [sess-gamma]
---

## Rule Content

- Diagnose before retry
`;

const REPORT_ALPHA = JSON.stringify({
  session_id: 'sess-alpha',
  failure_attribution: {
    root_cause_category: 'loop',
    root_cause_summary: 'Bash tool looped 5 times',
    root_cause_confidence: 0.9,
  },
});

const REPORT_BETA = JSON.stringify({
  session_id: 'sess-beta',
  failure_attribution: {
    root_cause_category: 'loop',
    root_cause_summary: 'read_file called in loop',
    root_cause_confidence: 0.7,
  },
});

const REPORT_GAMMA = JSON.stringify({
  session_id: 'sess-gamma',
  failure_attribution: {
    root_cause_category: 'tool_error',
    root_cause_summary: 'edit_file permission denied',
    root_cause_confidence: 0.8,
  },
});

const EXPERIMENT_MD = `---
id: exp-001
tags: [loop]
status: active
created: 2026-04-10
source: proposal (prop-20260409-001)
---

## Rule Content

- Anti-loop rule v1
`;

describe('Evidence Graph Migration', () => {
  let tmpDir: string;
  let proposalsDir: string;
  let reportsDir: string;
  let experimentsDir: string;
  let db: EvidenceDb;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-migrate-'));
    proposalsDir = path.join(tmpDir, 'proposals');
    reportsDir = path.join(tmpDir, 'grader-reports');
    experimentsDir = path.join(tmpDir, 'experiments');
    await fs.mkdir(proposalsDir, { recursive: true });
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.mkdir(experimentsDir, { recursive: true });

    // Write fixtures
    await fs.writeFile(path.join(proposalsDir, 'prop-20260409-001.md'), PROPOSAL_MD);
    await fs.writeFile(path.join(proposalsDir, 'prop-20260410-001.md'), PROPOSAL_MD_2);
    await fs.writeFile(path.join(reportsDir, '2026-04-01-sess-alpha.json'), REPORT_ALPHA);
    await fs.writeFile(path.join(reportsDir, '2026-04-02-sess-beta.json'), REPORT_BETA);
    await fs.writeFile(path.join(reportsDir, '2026-04-03-sess-gamma.json'), REPORT_GAMMA);
    await fs.writeFile(path.join(experimentsDir, 'exp-001-loop.md'), EXPERIMENT_MD);

    db = new EvidenceDb(':memory:');
    db.initialize();
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('迁移 proposals', async () => {
    const { count, evidenceKeyMap } = await migrateProposals(db, proposalsDir);
    expect(count).toBe(2);
    expect(evidenceKeyMap.get('prop-20260409-001')).toEqual(['sess-alpha', 'sess-beta']);
    expect(evidenceKeyMap.get('prop-20260410-001')).toEqual(['sess-gamma']);
  });

  it('迁移 evidence', async () => {
    const { count, sessionIdMap } = await migrateEvidence(db, reportsDir);
    expect(count).toBe(3);
    expect(sessionIdMap.has('sess-alpha')).toBe(true);
    expect(sessionIdMap.has('sess-beta')).toBe(true);
    expect(sessionIdMap.has('sess-gamma')).toBe(true);
  });

  it('链接 evidence 和 proposals', async () => {
    await migrateEvidence(db, reportsDir);
    const { evidenceKeyMap } = await migrateProposals(db, proposalsDir);
    // 手动构建 sessionIdMap（因为 id 基于插入顺序）
    const rows = db.getDb().prepare('SELECT id, session_id FROM evidence').all() as Array<{ id: number; session_id: string }>;
    const sessionIdMap = new Map(rows.map(r => [r.session_id, r.id]));
    const links = linkEvidenceToProposals(db, evidenceKeyMap, sessionIdMap);
    expect(links).toBe(3); // 2 for prop-001, 1 for prop-002

    const epRows = db.getDb().prepare('SELECT * FROM evidence_proposals').all();
    expect(epRows.length).toBe(3);
  });

  it('迁移 rules', async () => {
    // 需要先有 proposal 才能创建 FK
    await migrateProposals(db, proposalsDir);
    const { count, links } = await migrateRules(db, experimentsDir);
    expect(count).toBe(1);
    expect(links).toBe(1);
  });

  it('完整迁移流程', async () => {
    const { count: propCount, evidenceKeyMap } = await migrateProposals(db, proposalsDir);
    const { count: evidCount, sessionIdMap } = await migrateEvidence(db, reportsDir);
    const epLinks = linkEvidenceToProposals(db, evidenceKeyMap, sessionIdMap);
    const { count: ruleCount, links: prLinks } = await migrateRules(db, experimentsDir);

    expect(propCount).toBe(2);
    expect(evidCount).toBe(3);
    expect(epLinks).toBe(3);
    expect(ruleCount).toBe(1);
    expect(prLinks).toBe(1);

    // Verify via getSummary
    const summary = getSummary(db.getDb());
    expect(summary.totalEvidence).toBe(3);
    expect(summary.totalProposals).toBe(2);
    expect(summary.totalRules).toBe(1);
    expect(summary.categoryBreakdown.get('loop')).toBe(2);
    expect(summary.categoryBreakdown.get('tool_error')).toBe(1);
  });

  it('幂等：重复迁移不增加记录', async () => {
    // 第一次
    const { evidenceKeyMap: ekm1 } = await migrateProposals(db, proposalsDir);
    const { sessionIdMap: sim1 } = await migrateEvidence(db, reportsDir);
    linkEvidenceToProposals(db, ekm1, sim1);
    await migrateRules(db, experimentsDir);

    const s1 = getSummary(db.getDb());

    // 第二次
    const { evidenceKeyMap: ekm2 } = await migrateProposals(db, proposalsDir);
    const { sessionIdMap: sim2 } = await migrateEvidence(db, reportsDir);
    linkEvidenceToProposals(db, ekm2, sim2);
    await migrateRules(db, experimentsDir);

    const s2 = getSummary(db.getDb());

    expect(s2.totalEvidence).toBe(s1.totalEvidence);
    expect(s2.totalProposals).toBe(s1.totalProposals);
    expect(s2.totalRules).toBe(s1.totalRules);
  });

  it('缺失目录不崩溃', async () => {
    const { count } = await migrateProposals(db, '/nonexistent/path');
    expect(count).toBe(0);
    const { count: ec } = await migrateEvidence(db, '/nonexistent/path');
    expect(ec).toBe(0);
  });
});
