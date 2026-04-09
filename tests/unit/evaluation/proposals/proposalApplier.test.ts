// ============================================================================
// proposalApplier tests — Self-Evolving v2.5 Phase 3
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { applyProposal } from '../../../../src/main/evaluation/proposals/proposalApplier';
import { writeProposal, loadProposal } from '../../../../src/main/evaluation/proposals/proposalStore';
import type { Proposal } from '../../../../src/main/evaluation/proposals/proposalTypes';

function sampleProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-20260409-001',
    filePath: '',
    createdAt: '2026-04-09T10:00:00Z',
    status: 'shadow_passed',
    source: 'synthesize',
    type: 'new_l3_experiment',
    hypothesis: 'bash loops should self-break after 3 repeats',
    targetMetric: 'loop deviations = 0 per session',
    rollbackCondition: 'session quality drops by 5pp',
    tags: ['loop', 'bash'],
    sunset: '2026-05-09',
    ruleContent: 'When bash has been called 3 times with identical args, STOP.',
    ...overrides,
  };
}

describe('applyProposal', () => {
  let proposalsDir: string;
  let experimentsDir: string;

  beforeEach(async () => {
    proposalsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apply-p-'));
    experimentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apply-e-'));
  });

  afterEach(async () => {
    await fs.rm(proposalsDir, { recursive: true, force: true });
    await fs.rm(experimentsDir, { recursive: true, force: true });
  });

  it('writes an experiment file with exp-001 when target dir is empty', async () => {
    const written = await writeProposal(proposalsDir, sampleProposal());
    const result = await applyProposal(written.filePath, { experimentsDir });
    expect(result.experimentId).toBe('exp-001');
    expect(result.experimentPath).toMatch(/exp-001-/);

    const expContent = await fs.readFile(result.experimentPath, 'utf8');
    expect(expContent).toContain('id: exp-001');
    expect(expContent).toContain('hypothesis');
    expect(expContent).toContain('bash loops should self-break');
    expect(expContent).toContain('When bash has been called 3 times');
  });

  it('increments exp number based on existing files', async () => {
    await fs.writeFile(path.join(experimentsDir, 'exp-001-foo.md'), '---\nid: exp-001\n---\n');
    await fs.writeFile(path.join(experimentsDir, 'exp-007-bar.md'), '---\nid: exp-007\n---\n');
    const written = await writeProposal(proposalsDir, sampleProposal());
    const result = await applyProposal(written.filePath, { experimentsDir });
    expect(result.experimentId).toBe('exp-008');
  });

  it('updates source proposal status to applied', async () => {
    const written = await writeProposal(proposalsDir, sampleProposal());
    await applyProposal(written.filePath, { experimentsDir });
    const reloaded = await loadProposal(written.filePath);
    expect(reloaded.status).toBe('applied');
  });

  it('refuses to apply a proposal not in shadow_passed or needs_human', async () => {
    const written = await writeProposal(
      proposalsDir,
      sampleProposal({ status: 'shadow_failed' })
    );
    await expect(
      applyProposal(written.filePath, { experimentsDir })
    ).rejects.toThrow(/shadow_failed/);
  });

  it('generates slug from tags for experiment filename', async () => {
    const written = await writeProposal(proposalsDir, sampleProposal());
    const result = await applyProposal(written.filePath, { experimentsDir });
    expect(path.basename(result.experimentPath)).toMatch(/^exp-001-[a-z0-9-]+\.md$/);
  });
});
