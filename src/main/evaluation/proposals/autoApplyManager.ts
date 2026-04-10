// ============================================================================
// Auto-Apply Manager — V3-alpha Trusted Channel
//
// Applies proposals with `namespace: auto` tag and rollback tracking.
// Reuses `applyProposal()` from proposalApplier for the core promotion logic,
// then patches the experiment file with auto-apply metadata.
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { applyProposal, defaultExperimentsDir } from './proposalApplier';
import { loadProposal, updateStatus } from './proposalStore';
import { evaluateAutoApply, type AutoApplyThresholds } from './autoApplyGate';

export interface AutoApplyResult {
  experimentId: string;
  experimentPath: string;
  autoApplied: boolean;
  namespace: 'auto';
  rollbackId: string;
}

export interface RollbackResult {
  experimentId: string;
  reverted: boolean;
  reason: string;
}

export interface AutoAppliedRule {
  experimentId: string;
  experimentPath: string;
  rollbackId: string;
  appliedAt: string;
  sourceProposalId: string;
  reverted: boolean;
}

export async function autoApply(
  proposalPath: string,
  opts?: { experimentsDir?: string; thresholds?: Partial<AutoApplyThresholds> },
): Promise<AutoApplyResult> {
  const proposal = await loadProposal(proposalPath);

  // Validate via gate
  const decision = evaluateAutoApply(proposal, opts?.thresholds);
  if (!decision.canAutoApply) {
    throw new Error(
      `Cannot auto-apply ${proposal.id}: ${decision.reason}`,
    );
  }

  const experimentsDir = opts?.experimentsDir ?? defaultExperimentsDir();

  // Delegate to core applier
  const result = await applyProposal(proposalPath, { experimentsDir });

  // Patch experiment file with auto-apply metadata
  const rollbackId = crypto.randomUUID();
  const appliedAt = new Date().toISOString();
  const expContent = await fs.readFile(result.experimentPath, 'utf8');
  const patchedContent = patchExperimentFrontmatter(expContent, {
    namespace: 'auto',
    rollback_id: rollbackId,
    applied_at: appliedAt,
    source_proposal: proposal.id,
    auto_applied: 'true',
  });
  await fs.writeFile(result.experimentPath, patchedContent, 'utf8');

  return {
    experimentId: result.experimentId,
    experimentPath: result.experimentPath,
    autoApplied: true,
    namespace: 'auto',
    rollbackId,
  };
}

export async function rollbackAutoApplied(
  experimentId: string,
  reason: string,
  opts?: { experimentsDir?: string },
): Promise<RollbackResult> {
  const experimentsDir = opts?.experimentsDir ?? defaultExperimentsDir();
  const expFile = await findExperimentFile(experimentsDir, experimentId);

  if (!expFile) {
    return {
      experimentId,
      reverted: false,
      reason: `experiment ${experimentId} not found in ${experimentsDir}`,
    };
  }

  const content = await fs.readFile(expFile, 'utf8');
  if (!content.includes('namespace: auto')) {
    return {
      experimentId,
      reverted: false,
      reason: `experiment ${experimentId} is not auto-applied`,
    };
  }

  if (expFile.endsWith('.reverted.md')) {
    return {
      experimentId,
      reverted: false,
      reason: `experiment ${experimentId} is already reverted`,
    };
  }

  // Rename to .reverted.md
  const revertedPath = expFile.replace(/\.md$/, '.reverted.md');
  await fs.rename(expFile, revertedPath);

  // Update source proposal status to superseded
  const sourceProposalId = extractField(content, 'source_proposal');
  if (sourceProposalId) {
    // Best-effort: proposal file might be missing
    try {
      const proposalDir = path.dirname(expFile).replace('experiments', 'proposals');
      const proposalFile = path.join(proposalDir, `${sourceProposalId}.md`);
      await updateStatus(proposalFile, 'superseded');
    } catch {
      // proposal file may not exist at expected path — that's ok
    }
  }

  return {
    experimentId,
    reverted: true,
    reason: reason || 'manual rollback',
  };
}

export async function listAutoApplied(
  opts?: { experimentsDir?: string },
): Promise<AutoAppliedRule[]> {
  const experimentsDir = opts?.experimentsDir ?? defaultExperimentsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(experimentsDir);
  } catch {
    return [];
  }

  const results: AutoAppliedRule[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(experimentsDir, entry);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    if (!content.includes('namespace: auto')) continue;

    const experimentId = extractField(content, 'id') ?? entry.replace(/\.md$/, '');
    const rollbackId = extractField(content, 'rollback_id') ?? '';
    const appliedAt = extractField(content, 'applied_at') ?? '';
    const sourceProposalId = extractField(content, 'source_proposal') ?? '';
    const reverted = entry.endsWith('.reverted.md');

    results.push({
      experimentId,
      experimentPath: filePath,
      rollbackId,
      appliedAt,
      sourceProposalId,
      reverted,
    });
  }

  return results;
}

// ---- internal helpers ----

function patchExperimentFrontmatter(
  content: string,
  fields: Record<string, string>,
): string {
  // Insert new fields before the closing `---` of the frontmatter
  const secondDashIdx = content.indexOf('---', content.indexOf('---') + 3);
  if (secondDashIdx === -1) return content;

  const newLines = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  return (
    content.slice(0, secondDashIdx) +
    newLines +
    '\n' +
    content.slice(secondDashIdx)
  );
}

function extractField(content: string, field: string): string | null {
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'm');
  const m = re.exec(content);
  return m ? m[1].trim() : null;
}

async function findExperimentFile(
  dir: string,
  experimentId: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.startsWith(experimentId) && entry.endsWith('.md')) {
      return path.join(dir, entry);
    }
  }
  return null;
}
