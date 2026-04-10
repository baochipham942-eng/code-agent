// ============================================================================
// autoApplyManager tests — V3-alpha Trusted Channel
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import {
  autoApply,
  rollbackAutoApplied,
  listAutoApplied,
} from '../../../../src/main/evaluation/proposals/autoApplyManager';
import {
  writeProposal,
  loadProposal,
} from '../../../../src/main/evaluation/proposals/proposalStore';
import type { Proposal, ShadowEvalResult } from '../../../../src/main/evaluation/proposals/proposalTypes';

function makeShadowEval(): ShadowEvalResult {
  return {
    evaluatedAt: '2026-04-10T10:00:00Z',
    conflictsWith: [],
    addressesCategories: [{ category: 'loop', hits: 5 }],
    regressionGateDecision: 'pass',
    score: 0.9,
    recommendation: 'apply',
    reason: 'High score.',
  };
}

function sampleProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-20260410-001',
    filePath: '',
    createdAt: '2026-04-10T10:00:00Z',
    status: 'shadow_passed',
    source: 'synthesize',
    type: 'new_l3_experiment',
    hypothesis: 'bash loops should self-break after 3 repeats',
    targetMetric: 'loop deviations = 0 per session',
    rollbackCondition: 'session quality drops by 5pp',
    tags: ['loop', 'bash'],
    sunset: '2026-05-10',
    ruleContent: 'When bash has been called 3 times with identical args, STOP.',
    evidenceKeys: ['s1', 's2', 's3'],
    shadowEval: makeShadowEval(),
    ...overrides,
  };
}

describe('autoApply', () => {
  let proposalsDir: string;
  let experimentsDir: string;

  beforeEach(async () => {
    proposalsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-p-'));
    experimentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-e-'));
  });

  afterEach(async () => {
    await fs.rm(proposalsDir, { recursive: true, force: true });
    await fs.rm(experimentsDir, { recursive: true, force: true });
  });

  it('creates experiment with namespace:auto and rollback_id in frontmatter', async () => {
    const written = await writeProposal(proposalsDir, sampleProposal());
    const result = await autoApply(written.filePath, { experimentsDir });

    expect(result.autoApplied).toBe(true);
    expect(result.namespace).toBe('auto');
    expect(result.rollbackId).toBeTruthy();
    expect(result.experimentId).toMatch(/^exp-\d{3}$/);

    const expContent = await fs.readFile(result.experimentPath, 'utf8');
    expect(expContent).toContain('namespace: auto');
    expect(expContent).toContain('rollback_id:');
    expect(expContent).toContain('applied_at:');
    expect(expContent).toContain('auto_applied: true');
    expect(expContent).toContain('source_proposal: prop-20260410-001');
  });

  it('updates source proposal status to applied', async () => {
    const written = await writeProposal(proposalsDir, sampleProposal());
    await autoApply(written.filePath, { experimentsDir });
    const reloaded = await loadProposal(written.filePath);
    expect(reloaded.status).toBe('applied');
  });

  it('throws when gate check fails (e.g. insufficient evidence)', async () => {
    const written = await writeProposal(
      proposalsDir,
      sampleProposal({ evidenceKeys: [] }),
    );
    await expect(
      autoApply(written.filePath, { experimentsDir }),
    ).rejects.toThrow(/evidence count/);
  });

  it('throws when proposal status is not shadow_passed', async () => {
    const written = await writeProposal(
      proposalsDir,
      sampleProposal({ status: 'pending' }),
    );
    await expect(
      autoApply(written.filePath, { experimentsDir }),
    ).rejects.toThrow(/shadow_passed/);
  });
});

describe('rollbackAutoApplied', () => {
  let experimentsDir: string;

  beforeEach(async () => {
    experimentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-e-'));
  });

  afterEach(async () => {
    await fs.rm(experimentsDir, { recursive: true, force: true });
  });

  it('renames experiment to .reverted.md', async () => {
    const expFile = path.join(experimentsDir, 'exp-001-loop.md');
    await fs.writeFile(
      expFile,
      '---\nid: exp-001\nnamespace: auto\nrollback_id: abc-123\napplied_at: 2026-04-10T10:00:00Z\nsource_proposal: prop-001\n---\n',
    );

    const result = await rollbackAutoApplied('exp-001', 'test rollback', {
      experimentsDir,
    });
    expect(result.reverted).toBe(true);

    // Original file should be gone, reverted file should exist
    const files = await fs.readdir(experimentsDir);
    expect(files).toContain('exp-001-loop.reverted.md');
    expect(files).not.toContain('exp-001-loop.md');
  });

  it('returns reverted=false when experiment not found', async () => {
    const result = await rollbackAutoApplied('exp-999', 'not found', {
      experimentsDir,
    });
    expect(result.reverted).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('returns reverted=false when experiment is not auto-applied', async () => {
    const expFile = path.join(experimentsDir, 'exp-001-manual.md');
    await fs.writeFile(
      expFile,
      '---\nid: exp-001\nstatus: active\n---\n',
    );

    const result = await rollbackAutoApplied('exp-001', 'test', {
      experimentsDir,
    });
    expect(result.reverted).toBe(false);
    expect(result.reason).toContain('not auto-applied');
  });
});

describe('listAutoApplied', () => {
  let experimentsDir: string;

  beforeEach(async () => {
    experimentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'list-e-'));
  });

  afterEach(async () => {
    await fs.rm(experimentsDir, { recursive: true, force: true });
  });

  it('returns only experiments with namespace:auto', async () => {
    await fs.writeFile(
      path.join(experimentsDir, 'exp-001-loop.md'),
      '---\nid: exp-001\nnamespace: auto\nrollback_id: id-1\napplied_at: 2026-04-10T10:00:00Z\nsource_proposal: prop-001\n---\n',
    );
    await fs.writeFile(
      path.join(experimentsDir, 'exp-002-manual.md'),
      '---\nid: exp-002\nstatus: active\n---\n',
    );
    await fs.writeFile(
      path.join(experimentsDir, 'exp-003-auto.md'),
      '---\nid: exp-003\nnamespace: auto\nrollback_id: id-3\napplied_at: 2026-04-10T11:00:00Z\nsource_proposal: prop-003\n---\n',
    );

    const rules = await listAutoApplied({ experimentsDir });
    expect(rules.length).toBe(2);
    expect(rules.map((r) => r.experimentId).sort()).toEqual([
      'exp-001',
      'exp-003',
    ]);
  });

  it('returns empty array for empty dir', async () => {
    const rules = await listAutoApplied({ experimentsDir });
    expect(rules).toEqual([]);
  });

  it('returns empty array for missing dir', async () => {
    const rules = await listAutoApplied({
      experimentsDir: path.join(experimentsDir, 'nope'),
    });
    expect(rules).toEqual([]);
  });

  it('marks .reverted.md files as reverted', async () => {
    await fs.writeFile(
      path.join(experimentsDir, 'exp-001-loop.reverted.md'),
      '---\nid: exp-001\nnamespace: auto\nrollback_id: id-1\napplied_at: 2026-04-10T10:00:00Z\nsource_proposal: prop-001\n---\n',
    );
    const rules = await listAutoApplied({ experimentsDir });
    expect(rules.length).toBe(1);
    expect(rules[0].reverted).toBe(true);
  });
});
