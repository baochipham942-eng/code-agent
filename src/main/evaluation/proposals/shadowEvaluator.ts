// ============================================================================
// Shadow Evaluator — Self-Evolving v2.5 Phase 3
//
// Scores a pending Proposal via three signals (dependency-injected so tests
// can mock each independently):
//
//   1) conflict scan  — grep proposal tag keywords against existing rule files
//   2) attribution    — aggregate failure_attribution.root_cause_category from
//                        recent grader-reports; reward proposals whose tags
//                        match a high-frequency category (Phase 2 data feed)
//   3) regression gate — hard block if the v2.4 gate fails
//
// Score math:
//   score = 0.3 * (regression_pass ? 1 : 0)
//         + 0.2 * min(attribution_hits, 2)
//         - 0.3 * conflict_count
//   clamped to [0, 1]
//
// Recommendation rules (in priority order):
//   - regressionGateDecision === 'block'   → reject
//   - conflictsWith.length > 0             → needs_human
//   - addressesCategories.length === 0     → needs_human
//   - score >= 0.5                         → apply
//   - otherwise                            → needs_human
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  Proposal,
  ShadowEvalResult,
} from './proposalTypes';

export interface ShadowEvaluatorDeps {
  scanConflicts: (proposal: Proposal) => Promise<string[]>;
  readAttributionCategories: () => Promise<Map<string, number>>;
  runRegressionGate: () => Promise<'pass' | 'block' | 'skipped'>;
}

export class ShadowEvaluator {
  constructor(private readonly deps: ShadowEvaluatorDeps) {}

  async evaluate(proposal: Proposal): Promise<ShadowEvalResult> {
    const [conflictsWith, categoryCounts, regressionGateDecision] = await Promise.all([
      this.deps.scanConflicts(proposal),
      this.deps.readAttributionCategories(),
      this.deps.runRegressionGate(),
    ]);

    // Attribution hits: proposal tags ∩ high-frequency categories.
    const tagSet = new Set(proposal.tags.map((t) => t.toLowerCase()));
    const addressesCategories: ShadowEvalResult['addressesCategories'] = [];
    for (const [category, hits] of categoryCounts) {
      if (tagSet.has(category.toLowerCase())) {
        addressesCategories.push({ category, hits });
      }
    }
    // Sort by hit count desc for stable output.
    addressesCategories.sort((a, b) => b.hits - a.hits);

    // Score math.
    const regressionBoost = regressionGateDecision === 'pass' ? 0.3 : 0;
    const attributionBoost = Math.min(addressesCategories.length, 2) * 0.2;
    const conflictPenalty = conflictsWith.length * 0.3;
    let score = regressionBoost + attributionBoost - conflictPenalty;
    score = Math.max(0, Math.min(1, score));

    // Recommendation.
    let recommendation: ShadowEvalResult['recommendation'];
    let reason: string;
    if (regressionGateDecision === 'block') {
      recommendation = 'reject';
      reason = 'Regression gate blocked — baseline would regress.';
    } else if (conflictsWith.length > 0) {
      recommendation = 'needs_human';
      reason = `Proposal conflicts with ${conflictsWith.length} existing rule(s).`;
    } else if (addressesCategories.length === 0) {
      recommendation = 'needs_human';
      reason = 'No recent failure categories match this proposal — unclear value.';
    } else if (score >= 0.5) {
      recommendation = 'apply';
      reason = `High score (${score.toFixed(2)}) with ${addressesCategories.length} attribution hit(s).`;
    } else {
      recommendation = 'needs_human';
      reason = `Low score (${score.toFixed(2)}); human review needed.`;
    }

    return {
      evaluatedAt: new Date().toISOString(),
      conflictsWith,
      addressesCategories,
      regressionGateDecision,
      score,
      recommendation,
      reason,
    };
  }
}

// ============================================================================
// Default signal implementations
// ============================================================================

export const MIN_KEYWORD_LENGTH = 3;

/**
 * Default conflict scanner: greps proposal tags (as lowercase substrings)
 * against any `.md` file under each of the provided directories. Missing
 * directories are silently skipped. Matches are returned as absolute paths.
 */
export async function scanConflictsInDir(
  proposal: Proposal,
  dirs: string[]
): Promise<string[]> {
  const keywords = proposal.tags
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= MIN_KEYWORD_LENGTH);
  if (keywords.length === 0) return [];

  const hits: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const filePath = path.join(dir, entry);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch {
        continue;
      }
      const lower = raw.toLowerCase();
      if (keywords.some((k) => lower.includes(k))) {
        hits.push(filePath);
      }
    }
  }
  return hits;
}

export function defaultConflictDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.claude', 'rules'),
    path.join(home, '.claude', 'skills'),
  ];
}

/**
 * Default attribution reader: scans `dir` for `*.json` grader reports and
 * aggregates `failure_attribution.root_cause_category` counts. Reports
 * without the field (schema v2.1) are silently ignored.
 */
export async function readAttributionCategoriesFromDir(
  dir: string
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return counts;
  }

  const jsonFiles = entries.filter((f) => f.endsWith('.json'));
  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const parsed = JSON.parse(raw) as {
        failure_attribution?: { root_cause_category?: string };
      };
      const cat = parsed.failure_attribution?.root_cause_category;
      if (cat && typeof cat === 'string') {
        counts.set(cat, (counts.get(cat) ?? 0) + 1);
      }
    } catch {
      // skip malformed
    }
  }
  return counts;
}

export function defaultGraderReportsDir(): string {
  return path.join(os.homedir(), '.claude', 'grader-reports');
}
