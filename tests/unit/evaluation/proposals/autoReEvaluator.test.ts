// ============================================================================
// autoReEvaluator tests — V3-alpha Trusted Channel
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import {
  checkAutoAppliedHealth,
  checkAllAutoAppliedHealth,
} from '../../../../src/main/evaluation/proposals/autoReEvaluator';

describe('checkAutoAppliedHealth', () => {
  let experimentsDir: string;
  let graderDir: string;

  beforeEach(async () => {
    experimentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reeval-e-'));
    graderDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reeval-g-'));
  });

  afterEach(async () => {
    await fs.rm(experimentsDir, { recursive: true, force: true });
    await fs.rm(graderDir, { recursive: true, force: true });
  });

  async function writeAutoExperiment(id: string, appliedAt: string, tags = 'loop, bash') {
    await fs.writeFile(
      path.join(experimentsDir, `${id}-loop.md`),
      `---\nid: ${id}\nnamespace: auto\nrollback_id: rb-1\napplied_at: ${appliedAt}\nsource_proposal: prop-001\ntags: [${tags}]\n---\n`,
    );
  }

  async function writeGraderReport(
    name: string,
    timestamp: string,
    score: number,
    category?: string,
  ) {
    const report: Record<string, unknown> = {
      timestamp,
      weighted_total: score,
    };
    if (category) {
      report.failure_attribution = { root_cause_category: category };
    }
    await fs.writeFile(
      path.join(graderDir, `${name}.json`),
      JSON.stringify(report),
    );
  }

  it('returns not enough rounds when fewer than threshold', async () => {
    await writeAutoExperiment('exp-001', '2026-04-05T00:00:00Z');
    // Only 2 reports after apply date
    await writeGraderReport('r1', '2026-04-06T00:00:00Z', 8.0);
    await writeGraderReport('r2', '2026-04-07T00:00:00Z', 7.5);

    const result = await checkAutoAppliedHealth('exp-001', { evalRoundsBeforeCheck: 3 }, {
      graderReportsDir: graderDir,
      experimentsDir,
    });

    expect(result.shouldRevert).toBe(false);
    expect(result.reason).toContain('not enough rounds');
    expect(result.roundsSinceApply).toBe(2);
  });

  it('returns shouldRevert=false when within threshold', async () => {
    await writeAutoExperiment('exp-001', '2026-04-05T00:00:00Z');

    // Baseline (before apply): 2/3 success = 66.7%
    await writeGraderReport('b1', '2026-04-01T00:00:00Z', 8.0, 'loop');
    await writeGraderReport('b2', '2026-04-02T00:00:00Z', 5.0, 'loop');
    await writeGraderReport('b3', '2026-04-03T00:00:00Z', 7.5, 'loop');

    // After apply: 3/4 success = 75% (improved, no dropoff)
    await writeGraderReport('a1', '2026-04-06T00:00:00Z', 8.0);
    await writeGraderReport('a2', '2026-04-07T00:00:00Z', 7.5);
    await writeGraderReport('a3', '2026-04-08T00:00:00Z', 9.0);
    await writeGraderReport('a4', '2026-04-09T00:00:00Z', 5.0);

    const result = await checkAutoAppliedHealth('exp-001', { evalRoundsBeforeCheck: 3 }, {
      graderReportsDir: graderDir,
      experimentsDir,
    });

    expect(result.shouldRevert).toBe(false);
    expect(result.roundsSinceApply).toBe(4);
  });

  it('returns shouldRevert=true when success rate drops significantly', async () => {
    await writeAutoExperiment('exp-001', '2026-04-05T00:00:00Z');

    // Baseline: 3/3 success = 100%
    await writeGraderReport('b1', '2026-04-01T00:00:00Z', 8.0);
    await writeGraderReport('b2', '2026-04-02T00:00:00Z', 9.0);
    await writeGraderReport('b3', '2026-04-03T00:00:00Z', 7.5);

    // After apply: 1/4 success = 25% (massive dropoff = 75%)
    await writeGraderReport('a1', '2026-04-06T00:00:00Z', 3.0);
    await writeGraderReport('a2', '2026-04-07T00:00:00Z', 2.0);
    await writeGraderReport('a3', '2026-04-08T00:00:00Z', 4.0);
    await writeGraderReport('a4', '2026-04-09T00:00:00Z', 8.0);

    const result = await checkAutoAppliedHealth(
      'exp-001',
      { evalRoundsBeforeCheck: 3, dropoffThresholdPct: 10 },
      { graderReportsDir: graderDir, experimentsDir },
    );

    expect(result.shouldRevert).toBe(true);
    expect(result.reason).toContain('dropped');
    expect(result.baselineSuccessRate).toBe(100);
  });

  it('returns not found when experiment does not exist', async () => {
    const result = await checkAutoAppliedHealth('exp-999', undefined, {
      graderReportsDir: graderDir,
      experimentsDir,
    });
    expect(result.shouldRevert).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('returns already reverted for .reverted.md files', async () => {
    await fs.writeFile(
      path.join(experimentsDir, 'exp-001-loop.reverted.md'),
      '---\nid: exp-001\nnamespace: auto\nrollback_id: rb-1\napplied_at: 2026-04-05T00:00:00Z\nsource_proposal: prop-001\ntags: [loop]\n---\n',
    );

    const result = await checkAutoAppliedHealth('exp-001', undefined, {
      graderReportsDir: graderDir,
      experimentsDir,
    });
    expect(result.shouldRevert).toBe(false);
    expect(result.reason).toContain('reverted');
  });

  it('returns no baseline when no pre-apply reports exist', async () => {
    await writeAutoExperiment('exp-001', '2026-04-01T00:00:00Z');
    // All reports are after apply date
    await writeGraderReport('a1', '2026-04-06T00:00:00Z', 8.0);
    await writeGraderReport('a2', '2026-04-07T00:00:00Z', 7.0);
    await writeGraderReport('a3', '2026-04-08T00:00:00Z', 6.0);

    const result = await checkAutoAppliedHealth(
      'exp-001',
      { evalRoundsBeforeCheck: 3 },
      { graderReportsDir: graderDir, experimentsDir },
    );
    expect(result.shouldRevert).toBe(false);
    expect(result.reason).toContain('no baseline');
  });
});

describe('checkAllAutoAppliedHealth', () => {
  let experimentsDir: string;
  let graderDir: string;

  beforeEach(async () => {
    experimentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reeval-all-e-'));
    graderDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reeval-all-g-'));
  });

  afterEach(async () => {
    await fs.rm(experimentsDir, { recursive: true, force: true });
    await fs.rm(graderDir, { recursive: true, force: true });
  });

  it('checks health for all active auto-applied rules', async () => {
    // Two active auto rules
    await fs.writeFile(
      path.join(experimentsDir, 'exp-001-a.md'),
      '---\nid: exp-001\nnamespace: auto\nrollback_id: rb-1\napplied_at: 2026-04-05T00:00:00Z\nsource_proposal: p1\ntags: [loop]\n---\n',
    );
    await fs.writeFile(
      path.join(experimentsDir, 'exp-002-b.md'),
      '---\nid: exp-002\nnamespace: auto\nrollback_id: rb-2\napplied_at: 2026-04-05T00:00:00Z\nsource_proposal: p2\ntags: [tool]\n---\n',
    );
    // One reverted (should be skipped)
    await fs.writeFile(
      path.join(experimentsDir, 'exp-003-c.reverted.md'),
      '---\nid: exp-003\nnamespace: auto\nrollback_id: rb-3\napplied_at: 2026-04-05T00:00:00Z\nsource_proposal: p3\ntags: [env]\n---\n',
    );

    const results = await checkAllAutoAppliedHealth(undefined, {
      graderReportsDir: graderDir,
      experimentsDir,
    });

    // Only active (non-reverted) rules checked
    expect(results.length).toBe(2);
    expect(results.map((r) => r.experimentId).sort()).toEqual([
      'exp-001',
      'exp-002',
    ]);
  });

  it('returns empty array when no auto-applied rules exist', async () => {
    const results = await checkAllAutoAppliedHealth(undefined, {
      graderReportsDir: graderDir,
      experimentsDir,
    });
    expect(results).toEqual([]);
  });
});
