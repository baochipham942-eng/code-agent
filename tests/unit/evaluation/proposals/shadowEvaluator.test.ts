// ============================================================================
// shadowEvaluator tests — Self-Evolving v2.5 Phase 3
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import {
  ShadowEvaluator,
  scanConflictsInDir,
  readAttributionCategoriesFromDir,
} from '../../../../src/main/evaluation/proposals/shadowEvaluator';
import type { Proposal } from '../../../../src/main/evaluation/proposals/proposalTypes';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-20260409-001',
    filePath: '/tmp/fake.md',
    createdAt: '2026-04-09T10:00:00Z',
    status: 'pending',
    source: 'synthesize',
    type: 'new_l3_experiment',
    hypothesis: 'prevent bash loop',
    targetMetric: 'loop deviations drop to 0',
    rollbackCondition: 'session quality drops',
    tags: ['loop', 'bash'],
    ruleContent: 'When bash has been called 3 times with same args, STOP.',
    ...overrides,
  };
}

describe('ShadowEvaluator (core)', () => {
  it('recommends apply when no conflicts + attribution hits + regression passes', async () => {
    const evaluator = new ShadowEvaluator({
      scanConflicts: vi.fn().mockResolvedValue([]),
      readAttributionCategories: vi
        .fn()
        .mockResolvedValue(new Map([['loop', 5], ['tool_error', 2]])),
      runRegressionGate: vi.fn().mockResolvedValue('pass'),
    });

    const result = await evaluator.evaluate(makeProposal());
    expect(result.regressionGateDecision).toBe('pass');
    expect(result.addressesCategories.length).toBeGreaterThan(0);
    expect(result.addressesCategories[0].category).toBe('loop');
    expect(result.score).toBeGreaterThanOrEqual(0.5);
    expect(result.recommendation).toBe('apply');
    expect(result.conflictsWith).toEqual([]);
  });

  it('rejects when regression gate blocks (hard override)', async () => {
    const evaluator = new ShadowEvaluator({
      scanConflicts: vi.fn().mockResolvedValue([]),
      readAttributionCategories: vi.fn().mockResolvedValue(new Map([['loop', 10]])),
      runRegressionGate: vi.fn().mockResolvedValue('block'),
    });
    const result = await evaluator.evaluate(makeProposal());
    expect(result.regressionGateDecision).toBe('block');
    expect(result.recommendation).toBe('reject');
    expect(result.reason).toMatch(/regression/i);
  });

  it('downgrades score when conflicts are present', async () => {
    const evaluator = new ShadowEvaluator({
      scanConflicts: vi
        .fn()
        .mockResolvedValue(['~/.claude/rules/frontend.md', '~/.claude/rules/testing.md']),
      readAttributionCategories: vi.fn().mockResolvedValue(new Map([['loop', 1]])),
      runRegressionGate: vi.fn().mockResolvedValue('pass'),
    });
    const result = await evaluator.evaluate(makeProposal());
    expect(result.conflictsWith.length).toBe(2);
    expect(result.recommendation).toBe('needs_human');
    expect(result.reason).toMatch(/conflict/i);
  });

  it('recommends needs_human when attribution has no hits', async () => {
    const evaluator = new ShadowEvaluator({
      scanConflicts: vi.fn().mockResolvedValue([]),
      readAttributionCategories: vi.fn().mockResolvedValue(new Map()),
      runRegressionGate: vi.fn().mockResolvedValue('pass'),
    });
    const result = await evaluator.evaluate(makeProposal());
    expect(result.addressesCategories).toEqual([]);
    expect(result.recommendation).toBe('needs_human');
  });

  it('treats skipped regression gate as neutral (does not override)', async () => {
    const evaluator = new ShadowEvaluator({
      scanConflicts: vi.fn().mockResolvedValue([]),
      readAttributionCategories: vi.fn().mockResolvedValue(new Map([['loop', 5]])),
      runRegressionGate: vi.fn().mockResolvedValue('skipped'),
    });
    const result = await evaluator.evaluate(makeProposal());
    expect(result.regressionGateDecision).toBe('skipped');
    // With no regression boost but strong attribution, still recommends apply
    expect(['apply', 'needs_human']).toContain(result.recommendation);
  });
});

describe('scanConflictsInDir (default conflict scanner)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prop-scan-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('finds files containing proposal tag keywords', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'frontend.md'),
      '# frontend rules\n- when bash loop detected, stop\n'
    );
    await fs.writeFile(
      path.join(tmpDir, 'security.md'),
      '# security rules\n- never exec untrusted input\n'
    );
    const hits = await scanConflictsInDir(
      makeProposal({ tags: ['bash', 'loop'] }),
      [tmpDir]
    );
    expect(hits.some((h) => h.includes('frontend.md'))).toBe(true);
    expect(hits.some((h) => h.includes('security.md'))).toBe(false);
  });

  it('returns [] for empty tags', async () => {
    await fs.writeFile(path.join(tmpDir, 'x.md'), 'content');
    const hits = await scanConflictsInDir(makeProposal({ tags: [] }), [tmpDir]);
    expect(hits).toEqual([]);
  });

  it('returns [] for missing dir', async () => {
    const hits = await scanConflictsInDir(makeProposal(), [
      path.join(tmpDir, 'nowhere'),
    ]);
    expect(hits).toEqual([]);
  });
});

describe('readAttributionCategoriesFromDir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prop-attr-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('aggregates root_cause_category counts from grader report JSONs', async () => {
    await fs.writeFile(
      path.join(tmpDir, '2026-04-08-a.json'),
      JSON.stringify({
        failure_attribution: { root_cause_category: 'loop' },
      })
    );
    await fs.writeFile(
      path.join(tmpDir, '2026-04-09-b.json'),
      JSON.stringify({
        failure_attribution: { root_cause_category: 'loop' },
      })
    );
    await fs.writeFile(
      path.join(tmpDir, '2026-04-09-c.json'),
      JSON.stringify({
        failure_attribution: { root_cause_category: 'env_failure' },
      })
    );
    const map = await readAttributionCategoriesFromDir(tmpDir);
    expect(map.get('loop')).toBe(2);
    expect(map.get('env_failure')).toBe(1);
  });

  it('skips reports without failure_attribution (v2.1 legacy)', async () => {
    await fs.writeFile(
      path.join(tmpDir, '2026-04-01.json'),
      JSON.stringify({ scores: [], weighted_total: 7.0 })
    );
    const map = await readAttributionCategoriesFromDir(tmpDir);
    expect(map.size).toBe(0);
  });

  it('returns empty map for missing dir', async () => {
    const map = await readAttributionCategoriesFromDir(path.join(tmpDir, 'nowhere'));
    expect(map.size).toBe(0);
  });
});
