// ============================================================================
// Proposal Store — Self-Evolving v2.5 Phase 3
//
// Reads and writes Proposal markdown files under ~/.claude/proposals/.
// Frontmatter format (YAML-ish, same simple parser style as v2.4 caseLoader):
//
//   ---
//   id: prop-20260409-001
//   createdAt: 2026-04-09T10:00:00Z
//   status: pending
//   source: synthesize
//   type: new_l3_experiment
//   hypothesis: ...
//   target_metric: ...
//   rollback_condition: ...
//   tags: [loop, bash]
//   sunset: 2026-05-09         # optional
//   shadow_eval: {...json...}  # optional, filled after evaluate
//   ---
//
//   ## Rule Content
//
//   <rule body>
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  Proposal,
  ProposalStatus,
  ProposalType,
  ShadowEvalResult,
} from './proposalTypes';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const REQUIRED_FIELDS = [
  'id',
  'createdAt',
  'status',
  'source',
  'type',
  'hypothesis',
  'target_metric',
  'rollback_condition',
] as const;

export function defaultProposalsDir(): string {
  return path.join(os.homedir(), '.claude', 'proposals');
}

// ---- public API ----

export async function loadProposal(filePath: string): Promise<Proposal> {
  const raw = await fs.readFile(filePath, 'utf8');
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error(`Proposal ${filePath} is missing YAML frontmatter`);
  }
  const [, fmText, body] = match;
  const fm = parseFrontmatter(fmText);

  for (const field of REQUIRED_FIELDS) {
    if (!fm[field]) {
      throw new Error(`Proposal ${filePath} missing required field: ${field}`);
    }
  }

  return {
    id: String(fm.id),
    filePath,
    createdAt: String(fm.createdAt),
    status: String(fm.status) as ProposalStatus,
    source: String(fm.source) as Proposal['source'],
    type: String(fm.type) as ProposalType,
    ruleId: fm.ruleId ? String(fm.ruleId) : undefined,
    hypothesis: String(fm.hypothesis),
    targetMetric: String(fm.target_metric),
    rollbackCondition: String(fm.rollback_condition),
    tags: toStringArray(fm.tags),
    sunset: fm.sunset ? String(fm.sunset) : undefined,
    shadowEval: fm.shadow_eval ? parseShadowEval(String(fm.shadow_eval)) : undefined,
    ruleContent: extractRuleContent(body),
  };
}

export async function loadAllProposals(dir: string): Promise<Proposal[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const files = entries.filter((f) => f.startsWith('prop-') && f.endsWith('.md'));
  const out: Proposal[] = [];
  for (const file of files) {
    try {
      out.push(await loadProposal(path.join(dir, file)));
    } catch {
      // skip malformed
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export async function writeProposal(
  dir: string,
  proposal: Proposal
): Promise<Proposal> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${proposal.id}.md`);
  const content = serializeProposal({ ...proposal, filePath });
  await fs.writeFile(filePath, content, 'utf8');
  return { ...proposal, filePath };
}

export async function updateStatus(
  filePath: string,
  status: ProposalStatus,
  extra?: { shadowEval?: ShadowEvalResult }
): Promise<void> {
  const existing = await loadProposal(filePath);
  const updated: Proposal = {
    ...existing,
    status,
    shadowEval: extra?.shadowEval ?? existing.shadowEval,
  };
  await fs.writeFile(filePath, serializeProposal(updated), 'utf8');
}

/**
 * Generate a monotonically increasing proposal id for the current day.
 * Scans the target dir for `prop-YYYYMMDD-NNN.md` and returns NNN+1.
 */
export async function generateProposalId(dir: string, now: Date = new Date()): Promise<string> {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const prefix = `prop-${y}${m}${d}`;

  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    // dir missing — fresh sequence
  }
  const sameDay = files.filter((f) => f.startsWith(prefix) && f.endsWith('.md'));
  const seqs: number[] = [];
  for (const f of sameDay) {
    const m2 = /-(\d{3})\.md$/.exec(f);
    if (m2) seqs.push(parseInt(m2[1], 10));
  }
  const next = (seqs.length > 0 ? Math.max(...seqs) : 0) + 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

// ---- internal ----

function serializeProposal(p: Proposal): string {
  const lines = ['---'];
  lines.push(`id: ${p.id}`);
  lines.push(`createdAt: ${p.createdAt}`);
  lines.push(`status: ${p.status}`);
  lines.push(`source: ${p.source}`);
  lines.push(`type: ${p.type}`);
  if (p.ruleId) lines.push(`ruleId: ${p.ruleId}`);
  lines.push(`hypothesis: ${p.hypothesis}`);
  lines.push(`target_metric: ${p.targetMetric}`);
  lines.push(`rollback_condition: ${p.rollbackCondition}`);
  lines.push(`tags: [${p.tags.join(', ')}]`);
  if (p.sunset) lines.push(`sunset: ${p.sunset}`);
  if (p.shadowEval) {
    lines.push(`shadow_eval: ${JSON.stringify(p.shadowEval)}`);
  }
  lines.push('---', '');
  if (p.ruleContent) {
    lines.push('## Rule Content', '', p.ruleContent.trim(), '');
  }
  return lines.join('\n');
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split('\n')) {
    const m = /^([\w_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawVal] = m;
    out[key] = parseValue(rawVal.trim());
  }
  return out;
}

function parseValue(raw: string): unknown {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String).filter((s) => s.length > 0);
  if (typeof val === 'string' && val.length > 0) return [val];
  return [];
}

function parseShadowEval(raw: string): ShadowEvalResult | undefined {
  try {
    return JSON.parse(raw) as ShadowEvalResult;
  } catch {
    return undefined;
  }
}

function extractRuleContent(body: string): string | undefined {
  const re = /##\s+Rule Content\s*\n([\s\S]*?)(?:\n##\s|$)/m;
  const m = re.exec(body);
  return m ? m[1].trim() : undefined;
}
