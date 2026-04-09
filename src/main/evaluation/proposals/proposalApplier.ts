// ============================================================================
// Proposal Applier — Self-Evolving v2.5 Phase 3
//
// Promotes a proposal from ~/.claude/proposals/ to a new L3 experiment file
// under ~/.claude/experiments/. Only proposals in `shadow_passed` or
// `needs_human` status can be applied (explicit override by human).
// Updates the source proposal's status to `applied` after successful write.
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadProposal, updateStatus } from './proposalStore';
import type { Proposal } from './proposalTypes';

export interface ApplyOptions {
  experimentsDir?: string;
}

export interface ApplyResult {
  experimentId: string;
  experimentPath: string;
}

const APPLICABLE_STATUSES = new Set<Proposal['status']>([
  'shadow_passed',
  'needs_human',
]);

export function defaultExperimentsDir(): string {
  return path.join(os.homedir(), '.claude', 'experiments');
}

export async function applyProposal(
  proposalPath: string,
  opts: ApplyOptions = {}
): Promise<ApplyResult> {
  const proposal = await loadProposal(proposalPath);
  if (!APPLICABLE_STATUSES.has(proposal.status)) {
    throw new Error(
      `Cannot apply proposal ${proposal.id} with status ${proposal.status} — ` +
        `must be shadow_passed or needs_human`
    );
  }

  const experimentsDir = opts.experimentsDir ?? defaultExperimentsDir();
  await fs.mkdir(experimentsDir, { recursive: true });

  const experimentId = await nextExperimentId(experimentsDir);
  const slug = slugFromTags(proposal.tags, proposal.id);
  const experimentPath = path.join(experimentsDir, `${experimentId}-${slug}.md`);
  const content = renderExperiment(proposal, experimentId);
  await fs.writeFile(experimentPath, content, 'utf8');

  await updateStatus(proposalPath, 'applied');

  return { experimentId, experimentPath };
}

// ---- helpers ----

async function nextExperimentId(dir: string): Promise<string> {
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    // fresh directory
  }
  const seqs: number[] = [];
  for (const f of files) {
    const m = /^exp-(\d{3})/.exec(f);
    if (m) seqs.push(parseInt(m[1], 10));
  }
  const next = (seqs.length > 0 ? Math.max(...seqs) : 0) + 1;
  return `exp-${String(next).padStart(3, '0')}`;
}

function slugFromTags(tags: string[], fallback: string): string {
  const clean = tags
    .map((t) => t.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))
    .filter((t) => t.length > 0);
  if (clean.length === 0) return fallback.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  return clean.slice(0, 3).join('-');
}

function renderExperiment(proposal: Proposal, experimentId: string): string {
  const sunset = proposal.sunset ?? defaultSunset();
  const lines = [
    'disable-model-invocation: true',
    '---',
    `id: ${experimentId}`,
    `tags: [${proposal.tags.join(', ')}]`,
    'status: active',
    `created: ${todayYmd()}`,
    `sunset: ${sunset}`,
    `confidence: 0.7`,
    `source: proposal (${proposal.id})`,
    'disable-model-invocation: true',
    '---',
    '',
    '## Instructions',
    '',
    `- **hypothesis**: ${proposal.hypothesis}`,
    `- **target_metric**: ${proposal.targetMetric}`,
    '',
    '## Constraints',
    '',
    `- **rollback_condition**: ${proposal.rollbackCondition}`,
    '',
    '## Stopping Criteria',
    '',
    '- **success**: target_metric 连续 3 个 session 达标',
    '- **failure**: 2 周无改善',
    `- **timeout**: ${sunset}`,
    '',
    '## Rule Content',
    '',
    proposal.ruleContent?.trim() ?? '(no rule content)',
    '',
  ];
  return lines.join('\n');
}

function todayYmd(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function defaultSunset(): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + 30);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
