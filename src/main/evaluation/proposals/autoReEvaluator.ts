// ============================================================================
// Auto Re-Evaluator — V3-alpha Trusted Channel
//
// Monitors auto-applied rules' health post-deploy by comparing failure rates
// before and after application. Reverts rules that show performance dropoff.
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { listAutoApplied, type AutoAppliedRule } from './autoApplyManager';
import { defaultExperimentsDir } from './proposalApplier';

export interface ReEvalConfig {
  evalRoundsBeforeCheck: number;  // default 3
  dropoffThresholdPct: number;    // default 10 (if success rate drops 10%, revert)
}

export interface ReEvalResult {
  experimentId: string;
  roundsSinceApply: number;
  shouldRevert: boolean;
  reason: string;
  currentSuccessRate?: number;
  baselineSuccessRate?: number;
}

const DEFAULT_CONFIG: ReEvalConfig = {
  evalRoundsBeforeCheck: 3,
  dropoffThresholdPct: 10,
};

export function defaultGraderReportsDir(): string {
  return path.join(os.homedir(), '.claude', 'grader-reports');
}

/**
 * Check health of a single auto-applied rule.
 *
 * Reads grader reports from `graderReportsDir`, splits them into baseline
 * (before the experiment's `applied_at`) and current (after), then compares
 * failure rates in the experiment's category.
 */
export async function checkAutoAppliedHealth(
  experimentId: string,
  config?: Partial<ReEvalConfig>,
  opts?: { graderReportsDir?: string; experimentsDir?: string },
): Promise<ReEvalResult> {
  const cfg: ReEvalConfig = { ...DEFAULT_CONFIG, ...config };
  const graderDir = opts?.graderReportsDir ?? defaultGraderReportsDir();
  const experimentsDir = opts?.experimentsDir ?? defaultExperimentsDir();

  // Find the experiment file to get applied_at and category
  const rule = await findAutoRule(experimentsDir, experimentId);
  if (!rule) {
    return {
      experimentId,
      roundsSinceApply: 0,
      shouldRevert: false,
      reason: `experiment ${experimentId} not found or not auto-applied`,
    };
  }

  if (rule.reverted) {
    return {
      experimentId,
      roundsSinceApply: 0,
      shouldRevert: false,
      reason: 'already reverted',
    };
  }

  const appliedAt = rule.appliedAt ? new Date(rule.appliedAt) : null;
  if (!appliedAt || isNaN(appliedAt.getTime())) {
    return {
      experimentId,
      roundsSinceApply: 0,
      shouldRevert: false,
      reason: 'missing or invalid applied_at timestamp',
    };
  }

  // Load grader reports and split by time
  const reports = await loadGraderReports(graderDir);
  const category = await extractExperimentCategory(experimentsDir, experimentId);

  const postApplyReports = reports.filter(
    (r) => r.timestamp > appliedAt.getTime(),
  );

  const roundsSinceApply = postApplyReports.length;
  if (roundsSinceApply < cfg.evalRoundsBeforeCheck) {
    return {
      experimentId,
      roundsSinceApply,
      shouldRevert: false,
      reason: `not enough rounds yet (${roundsSinceApply}/${cfg.evalRoundsBeforeCheck})`,
    };
  }

  // Compute failure rates
  const preApplyReports = reports.filter(
    (r) => r.timestamp <= appliedAt.getTime(),
  );
  const baselineSuccessRate = computeSuccessRate(preApplyReports, category);
  const currentSuccessRate = computeSuccessRate(postApplyReports, category);

  // If no baseline data, can't compare
  if (baselineSuccessRate === null) {
    return {
      experimentId,
      roundsSinceApply,
      shouldRevert: false,
      reason: 'no baseline data available for comparison',
      currentSuccessRate: currentSuccessRate ?? undefined,
    };
  }

  const dropoff = baselineSuccessRate - (currentSuccessRate ?? baselineSuccessRate);
  const shouldRevert = dropoff > cfg.dropoffThresholdPct;

  return {
    experimentId,
    roundsSinceApply,
    shouldRevert,
    reason: shouldRevert
      ? `success rate dropped by ${dropoff.toFixed(1)}% (baseline=${baselineSuccessRate.toFixed(1)}%, current=${(currentSuccessRate ?? 0).toFixed(1)}%)`
      : `healthy (dropoff=${dropoff.toFixed(1)}% within ${cfg.dropoffThresholdPct}% threshold)`,
    currentSuccessRate: currentSuccessRate ?? undefined,
    baselineSuccessRate,
  };
}

/**
 * Check all auto-applied rules' health.
 */
export async function checkAllAutoAppliedHealth(
  config?: Partial<ReEvalConfig>,
  opts?: { graderReportsDir?: string; experimentsDir?: string },
): Promise<ReEvalResult[]> {
  const experimentsDir = opts?.experimentsDir ?? defaultExperimentsDir();
  const rules = await listAutoApplied({ experimentsDir });
  const activeRules = rules.filter((r) => !r.reverted);

  const results: ReEvalResult[] = [];
  for (const rule of activeRules) {
    results.push(
      await checkAutoAppliedHealth(rule.experimentId, config, opts),
    );
  }
  return results;
}

// ---- internal helpers ----

interface GraderReport {
  timestamp: number;
  fileName: string;
  failureCategory?: string;
  success: boolean;
}

async function loadGraderReports(dir: string): Promise<GraderReport[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const reports: GraderReport[] = [];
  const jsonFiles = entries.filter((f) => f.endsWith('.json')).sort();

  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const parsed = JSON.parse(raw) as {
        timestamp?: string;
        weighted_total?: number;
        failure_attribution?: { root_cause_category?: string };
      };

      const ts = parsed.timestamp
        ? new Date(parsed.timestamp).getTime()
        : extractTimestampFromFilename(file);

      reports.push({
        timestamp: ts,
        fileName: file,
        failureCategory: parsed.failure_attribution?.root_cause_category,
        success: (parsed.weighted_total ?? 0) >= 7.0,
      });
    } catch {
      // skip malformed
    }
  }

  return reports;
}

function extractTimestampFromFilename(fileName: string): number {
  // Try to parse YYYY-MM-DD from filename
  const m = /(\d{4}-\d{2}-\d{2})/.exec(fileName);
  if (m) return new Date(m[1]).getTime();
  return 0;
}

function computeSuccessRate(
  reports: GraderReport[],
  category: string | null,
): number | null {
  if (reports.length === 0) return null;

  // If we have a category, only count reports relevant to that category
  const relevant = category
    ? reports.filter(
        (r) =>
          r.failureCategory === category ||
          r.failureCategory === undefined,
      )
    : reports;

  if (relevant.length === 0) return null;

  const successes = relevant.filter((r) => r.success).length;
  return (successes / relevant.length) * 100;
}

async function findAutoRule(
  dir: string,
  experimentId: string,
): Promise<AutoAppliedRule | null> {
  const rules = await listAutoApplied({ experimentsDir: dir });
  return rules.find((r) => r.experimentId === experimentId) ?? null;
}

async function extractExperimentCategory(
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
    if (!entry.startsWith(experimentId)) continue;
    try {
      const content = await fs.readFile(path.join(dir, entry), 'utf8');
      // Extract tags from frontmatter: tags: [loop, bash]
      const m = /^tags:\s*\[(.+)\]/m.exec(content);
      if (m) {
        const tags = m[1].split(',').map((t) => t.trim());
        return tags[0] ?? null;
      }
    } catch {
      // skip
    }
  }
  return null;
}
