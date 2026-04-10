// ============================================================================
// Evidence Graph Migration — V3-beta
//
// 一次性迁移：从现有 proposal frontmatter + grader reports 构建 evidence graph。
// 幂等设计（INSERT OR IGNORE / UPSERT），可安全重复运行。
//
// 数据源:
//   1. ~/.claude/proposals/prop-*.md → proposals 表 + evidence_keys
//   2. ~/.claude/grader-reports/*.json → evidence 表
//   3. evidence_keys 与 evidence.session_id 交叉 → evidence_proposals 链接
//   4. ~/.claude/experiments/exp-*.md → rules 表 + proposal_rules 链接
//
// Usage: npx tsx scripts/evidence-migrate.ts [--db-path <path>]
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EvidenceDb } from '../src/main/evaluation/evidence/evidenceDb';

// ---- Config ----

const PROPOSALS_DIR = path.join(os.homedir(), '.claude', 'proposals');
const REPORTS_DIR = path.join(os.homedir(), '.claude', 'grader-reports');
const EXPERIMENTS_DIR = path.join(os.homedir(), '.claude', 'experiments');

// ---- Simple frontmatter parser (同 proposalStore 的逻辑) ----

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

// ---- Migration steps ----

interface MigrationStats {
  evidence: number;
  proposals: number;
  rules: number;
  evidenceProposalLinks: number;
  proposalRuleLinks: number;
}

async function migrateProposals(db: EvidenceDb, dir: string): Promise<{ count: number; evidenceKeyMap: Map<string, string[]> }> {
  const evidenceKeyMap = new Map<string, string[]>();
  let count = 0;
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    console.log(`  proposals dir not found: ${dir}`);
    return { count, evidenceKeyMap };
  }

  const propFiles = files.filter(f => f.startsWith('prop-') && f.endsWith('.md'));
  for (const file of propFiles) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const match = FRONTMATTER_RE.exec(raw);
      if (!match) continue;
      const [, fmText, body] = match;
      const fm = parseFrontmatter(fmText);
      if (!fm.id) continue;

      const tags = parseArrayField(fm.tags);
      // category = 第一个 tag（与 proposal-generate 的约定一致）
      const category = tags[0] ?? 'unknown';
      const ruleContent = extractRuleContent(body);

      db.upsertProposal({
        id: fm.id,
        category,
        status: fm.status ?? 'pending',
        rule_content: ruleContent ?? undefined,
        created_at: fm.createdAt ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const evidenceKeys = parseArrayField(fm.evidence_keys);
      if (evidenceKeys.length > 0) {
        evidenceKeyMap.set(fm.id, evidenceKeys);
      }
      count++;
    } catch {
      // skip malformed
    }
  }
  return { count, evidenceKeyMap };
}

async function migrateEvidence(db: EvidenceDb, dir: string): Promise<{ count: number; sessionIdMap: Map<string, number> }> {
  const sessionIdMap = new Map<string, number>();
  let count = 0;
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    console.log(`  grader-reports dir not found: ${dir}`);
    return { count, sessionIdMap };
  }

  const jsonFiles = files.filter(f => f.endsWith('.json')).sort();
  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const parsed = JSON.parse(raw) as {
        session_id?: string;
        failure_attribution?: {
          root_cause_category?: string;
          root_cause_summary?: string;
          root_cause_confidence?: number;
        };
      };

      const attr = parsed.failure_attribution;
      if (!attr?.root_cause_category || !parsed.session_id) continue;

      // 从文件名解析日期
      const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(file);
      const observedAt = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);

      const id = db.insertEvidence({
        session_id: parsed.session_id,
        category: attr.root_cause_category,
        confidence: typeof attr.root_cause_confidence === 'number'
          ? Math.max(0, Math.min(1, attr.root_cause_confidence))
          : 0.5,
        summary: attr.root_cause_summary ?? undefined,
        source_report: path.join(dir, file),
        observed_at: observedAt,
      });

      sessionIdMap.set(parsed.session_id, id);
      if (id > 0) count++;
    } catch {
      // skip malformed
    }
  }
  return { count, sessionIdMap };
}

function linkEvidenceToProposals(
  db: EvidenceDb,
  evidenceKeyMap: Map<string, string[]>,
  sessionIdMap: Map<string, number>
): number {
  let linkCount = 0;
  for (const [proposalId, keys] of evidenceKeyMap) {
    for (const sessionId of keys) {
      const evidenceId = sessionIdMap.get(sessionId);
      if (evidenceId) {
        db.linkEvidenceProposal(evidenceId, proposalId);
        linkCount++;
      }
    }
  }
  return linkCount;
}

async function migrateRules(db: EvidenceDb, dir: string): Promise<{ count: number; proposalRuleLinks: number }> {
  let count = 0;
  let proposalRuleLinks = 0;
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    console.log(`  experiments dir not found: ${dir}`);
    return { count, proposalRuleLinks };
  }

  const expFiles = files.filter(f => f.startsWith('exp-') && f.endsWith('.md'));
  for (const file of expFiles) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const match = FRONTMATTER_RE.exec(raw);
      if (!match) continue;
      const [, fmText, body] = match;
      const fm = parseFrontmatter(fmText);
      if (!fm.id) continue;

      const ruleContent = extractRuleContent(body) ?? body.trim();

      // 从 source 字段提取 proposal id: "proposal (prop-20260409-001)"
      let sourceProposalId: string | undefined;
      const sourceMatch = /proposal\s*\(([^)]+)\)/.exec(fm.source ?? '');
      if (sourceMatch) {
        sourceProposalId = sourceMatch[1];
      }

      db.upsertRule({
        id: fm.id,
        source_proposal_id: sourceProposalId,
        rule_content: ruleContent,
        applied_at: fm.created ?? new Date().toISOString(),
        version: 1,
        family_id: fm.id, // 默认自己是 family 的起点
      });

      if (sourceProposalId) {
        db.linkProposalRule(sourceProposalId, fm.id);
        proposalRuleLinks++;
      }

      count++;
    } catch {
      // skip malformed
    }
  }
  return { count, proposalRuleLinks };
}

// ---- CLI ----

function parseArgs(): { dbPath?: string } {
  const argv = process.argv.slice(2);
  let dbPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db-path' && argv[i + 1]) {
      dbPath = argv[++i];
    }
  }
  return { dbPath };
}

async function main() {
  const { dbPath } = parseArgs();

  console.log('\n── evidence-migrate (V3-beta) ──\n');

  const db = new EvidenceDb(dbPath);
  db.initialize();

  console.log('Step 1/4: Migrating proposals...');
  const { count: propCount, evidenceKeyMap } = await migrateProposals(db, PROPOSALS_DIR);
  console.log(`  Proposals: ${propCount}`);

  console.log('Step 2/4: Migrating evidence from grader reports...');
  const { count: evidCount, sessionIdMap } = await migrateEvidence(db, REPORTS_DIR);
  console.log(`  Evidence: ${evidCount}`);

  console.log('Step 3/4: Linking evidence to proposals...');
  const epLinks = linkEvidenceToProposals(db, evidenceKeyMap, sessionIdMap);
  console.log(`  Evidence-Proposal links: ${epLinks}`);

  console.log('Step 4/4: Migrating rules from experiments...');
  const { count: ruleCount, proposalRuleLinks: prLinks } = await migrateRules(db, EXPERIMENTS_DIR);
  console.log(`  Rules: ${ruleCount}`);
  console.log(`  Proposal-Rule links: ${prLinks}`);

  const stats: MigrationStats = {
    evidence: evidCount,
    proposals: propCount,
    rules: ruleCount,
    evidenceProposalLinks: epLinks,
    proposalRuleLinks: prLinks,
  };

  console.log(`\nMigrated: ${stats.evidence} evidence, ${stats.proposals} proposals, ${stats.rules} rules, ${stats.evidenceProposalLinks + stats.proposalRuleLinks} links`);

  db.close();
}

// 导出供测试使用
export { migrateProposals, migrateEvidence, linkEvidenceToProposals, migrateRules };

main().catch(err => {
  console.error(`Error: ${err?.message ?? err}`);
  process.exit(1);
});
