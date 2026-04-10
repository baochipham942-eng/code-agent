// ============================================================================
// proposalStore tests — Self-Evolving v2.5 Phase 3
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import {
  loadProposal,
  loadAllProposals,
  writeProposal,
  updateStatus,
  generateProposalId,
  findSimilarProposal,
  appendEvidenceToProposal,
} from '../../../../src/main/evaluation/proposals/proposalStore';
import type { Proposal } from '../../../../src/main/evaluation/proposals/proposalTypes';

async function writeRawProposal(
  dir: string,
  filename: string,
  body: string
): Promise<string> {
  const p = path.join(dir, filename);
  await fs.writeFile(p, body);
  return p;
}

function sampleProposalBody(overrides: Partial<Record<string, string>> = {}): string {
  const fm: Record<string, string> = {
    id: 'prop-20260409-001',
    createdAt: '2026-04-09T10:00:00Z',
    status: 'pending',
    source: 'synthesize',
    type: 'new_l3_experiment',
    hypothesis: 'Claude 应当在 bash 循环 3 次后自我中断',
    target_metric: 'loop deviation < 1 per session',
    rollback_condition: 'session success rate drops by 5pp',
    tags: '[loop, bash, self-correction]',
    ...overrides,
  };
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push('---', '', '## Rule Content', '', 'When bash has been called 3 times with same args, stop and reconsider.', '');
  return lines.join('\n');
}

describe('proposalStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prop-store-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('parses a well-formed proposal file', async () => {
    const file = await writeRawProposal(tmpDir, 'prop-20260409-001.md', sampleProposalBody());
    const loaded = await loadProposal(file);
    expect(loaded.id).toBe('prop-20260409-001');
    expect(loaded.status).toBe('pending');
    expect(loaded.source).toBe('synthesize');
    expect(loaded.type).toBe('new_l3_experiment');
    expect(loaded.hypothesis).toContain('bash 循环');
    expect(loaded.targetMetric).toContain('loop deviation');
    expect(loaded.rollbackCondition).toContain('success rate');
    expect(loaded.tags).toEqual(['loop', 'bash', 'self-correction']);
    expect(loaded.ruleContent).toContain('When bash has been called 3 times');
  });

  it('throws when required fields are missing', async () => {
    const body = sampleProposalBody({ hypothesis: '' });
    // write with hypothesis line removed entirely
    const cleaned = body
      .split('\n')
      .filter((l) => !l.startsWith('hypothesis:'))
      .join('\n');
    const file = await writeRawProposal(tmpDir, 'prop-bad.md', cleaned);
    await expect(loadProposal(file)).rejects.toThrow(/hypothesis/);
  });

  it('writes a proposal and round-trips', async () => {
    const proposal: Proposal = {
      id: 'prop-20260409-002',
      filePath: '', // writer fills this
      createdAt: '2026-04-09T11:00:00Z',
      status: 'pending',
      source: 'synthesize',
      type: 'new_l3_experiment',
      hypothesis: 'h',
      targetMetric: 'm',
      rollbackCondition: 'r',
      tags: ['a', 'b'],
      ruleContent: 'Body content here',
    };
    const written = await writeProposal(tmpDir, proposal);
    expect(written.filePath).toContain(tmpDir);
    const loaded = await loadProposal(written.filePath);
    expect(loaded.id).toBe('prop-20260409-002');
    expect(loaded.ruleContent).toContain('Body content here');
  });

  it('updateStatus rewrites frontmatter without touching body', async () => {
    const file = await writeRawProposal(tmpDir, 'prop-upd.md', sampleProposalBody());
    await updateStatus(file, 'applied', { shadowEval: undefined });
    const loaded = await loadProposal(file);
    expect(loaded.status).toBe('applied');
    expect(loaded.ruleContent).toContain('When bash has been called 3 times');
  });

  it('loadAllProposals returns ids sorted by createdAt desc', async () => {
    await writeRawProposal(
      tmpDir,
      'prop-1.md',
      sampleProposalBody({ id: 'prop-20260408-001', createdAt: '2026-04-08T08:00:00Z' })
    );
    await writeRawProposal(
      tmpDir,
      'prop-2.md',
      sampleProposalBody({ id: 'prop-20260409-001', createdAt: '2026-04-09T08:00:00Z' })
    );
    const all = await loadAllProposals(tmpDir);
    expect(all.map((p) => p.id)).toEqual(['prop-20260409-001', 'prop-20260408-001']);
  });

  it('loadAllProposals returns [] for missing directory', async () => {
    const result = await loadAllProposals(path.join(tmpDir, 'does-not-exist'));
    expect(result).toEqual([]);
  });

  it('generateProposalId returns monotonically increasing ids for same day', async () => {
    const id1 = await generateProposalId(tmpDir, new Date('2026-04-09T10:00:00Z'));
    expect(id1).toMatch(/^prop-20260409-001$/);
    // Write one to increment sequence
    await writeRawProposal(tmpDir, `${id1}.md`, sampleProposalBody({ id: id1 }));
    const id2 = await generateProposalId(tmpDir, new Date('2026-04-09T12:00:00Z'));
    expect(id2).toBe('prop-20260409-002');
  });

  // ---- Phase 5: dedup / merge ----

  it('round-trips evidence_keys in frontmatter', async () => {
    const proposal: Proposal = {
      id: 'prop-20260409-010',
      filePath: '',
      createdAt: '2026-04-09T11:00:00Z',
      status: 'pending',
      source: 'synthesize',
      type: 'new_l3_experiment',
      hypothesis: 'h',
      targetMetric: 'm',
      rollbackCondition: 'r',
      tags: ['loop', 'auto-generated'],
      evidenceKeys: ['sess-aaa', 'sess-bbb'],
      ruleContent: 'body',
    };
    const written = await writeProposal(tmpDir, proposal);
    const loaded = await loadProposal(written.filePath);
    expect(loaded.evidenceKeys).toEqual(['sess-aaa', 'sess-bbb']);
  });

  it('findSimilarProposal returns most recent open proposal in the same category', async () => {
    // Older shadow_passed in loop category
    await writeRawProposal(
      tmpDir,
      'prop-old.md',
      sampleProposalBody({
        id: 'prop-20260405-001',
        createdAt: '2026-04-05T10:00:00Z',
        status: 'shadow_passed',
        tags: '[loop, auto-generated]',
      })
    );
    // Newer pending in loop category
    await writeRawProposal(
      tmpDir,
      'prop-new.md',
      sampleProposalBody({
        id: 'prop-20260408-001',
        createdAt: '2026-04-08T10:00:00Z',
        status: 'pending',
        tags: '[loop, auto-generated]',
      })
    );
    // Unrelated category
    await writeRawProposal(
      tmpDir,
      'prop-other.md',
      sampleProposalBody({
        id: 'prop-20260408-002',
        createdAt: '2026-04-08T11:00:00Z',
        status: 'pending',
        tags: '[tool_error]',
      })
    );

    const match = await findSimilarProposal(tmpDir, 'loop');
    expect(match?.id).toBe('prop-20260408-001');
  });

  it('findSimilarProposal skips closed (applied / rejected) proposals', async () => {
    await writeRawProposal(
      tmpDir,
      'prop-applied.md',
      sampleProposalBody({
        id: 'prop-20260408-003',
        status: 'applied',
        tags: '[loop]',
      })
    );
    await writeRawProposal(
      tmpDir,
      'prop-rejected.md',
      sampleProposalBody({
        id: 'prop-20260408-004',
        status: 'rejected',
        tags: '[loop]',
      })
    );
    const match = await findSimilarProposal(tmpDir, 'loop');
    expect(match).toBeNull();
  });

  it('findSimilarProposal matches needs_human status as still open', async () => {
    await writeRawProposal(
      tmpDir,
      'prop-nh.md',
      sampleProposalBody({
        id: 'prop-20260408-005',
        status: 'needs_human',
        tags: '[env_failure]',
      })
    );
    const match = await findSimilarProposal(tmpDir, 'env_failure');
    expect(match?.id).toBe('prop-20260408-005');
  });

  it('appendEvidenceToProposal adds only new keys and appends a dated section', async () => {
    const proposal: Proposal = {
      id: 'prop-20260409-020',
      filePath: '',
      createdAt: '2026-04-09T10:00:00Z',
      status: 'pending',
      source: 'synthesize',
      type: 'new_l3_experiment',
      hypothesis: 'h',
      targetMetric: 'm',
      rollbackCondition: 'r',
      tags: ['loop'],
      evidenceKeys: ['sess-a', 'sess-b'],
      ruleContent: '## 防循环规则\n\n- 原有规则',
    };
    const written = await writeProposal(tmpDir, proposal);

    const { addedKeys } = await appendEvidenceToProposal(
      written.filePath,
      [
        { key: 'sess-b', summary: 'dup existing' },
        { key: 'sess-c', summary: 'new summary one' },
        { key: 'sess-d', summary: 'new summary two' },
      ],
      new Date('2026-04-10T00:00:00Z')
    );
    expect(addedKeys).toEqual(['sess-c', 'sess-d']);

    const reloaded = await loadProposal(written.filePath);
    expect(reloaded.evidenceKeys).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-d']);
    expect(reloaded.ruleContent).toContain('原有规则');
    expect(reloaded.ruleContent).toContain('## 追加证据 (2026-04-10)');
    expect(reloaded.ruleContent).toContain('new summary one');
    expect(reloaded.ruleContent).toContain('new summary two');
    // The summary of the already-present sess-b must NOT appear in the new section.
    expect(reloaded.ruleContent).not.toContain('dup existing');
  });

  it('appendEvidenceToProposal is a no-op when all keys already present', async () => {
    const proposal: Proposal = {
      id: 'prop-20260409-021',
      filePath: '',
      createdAt: '2026-04-09T10:00:00Z',
      status: 'pending',
      source: 'synthesize',
      type: 'new_l3_experiment',
      hypothesis: 'h',
      targetMetric: 'm',
      rollbackCondition: 'r',
      tags: ['loop'],
      evidenceKeys: ['sess-x', 'sess-y'],
      ruleContent: '## 原有内容',
    };
    const written = await writeProposal(tmpDir, proposal);
    const beforeRaw = await fs.readFile(written.filePath, 'utf8');

    const { addedKeys } = await appendEvidenceToProposal(written.filePath, [
      { key: 'sess-x', summary: 'dup' },
      { key: 'sess-y', summary: 'dup' },
    ]);
    expect(addedKeys).toEqual([]);

    // File must not have changed.
    const afterRaw = await fs.readFile(written.filePath, 'utf8');
    expect(afterRaw).toBe(beforeRaw);
  });
});
