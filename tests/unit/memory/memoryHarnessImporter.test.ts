import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  applyMemoryHarnessImport,
  confirmMemoryHarnessDirective,
  dryRunMemoryHarnessImport,
} from '../../../src/host/memory/importers';
import {
  listUnifiedMemoryEntries,
  packMemoryEntries,
  updateMemoryEntry,
} from '../../../src/host/memory/memoryEntryRuntime';
import { batchReviewMemoryEntries } from '../../../src/host/memory/memoryEntryReview';

class MemoryDb {
  records: MemoryRecord[] = [];

  listMemories(): MemoryRecord[] {
    return [...this.records];
  }

  createMemory(data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): MemoryRecord {
    const record: MemoryRecord = {
      id: `db-${this.records.length + 1}`,
      ...data,
      accessCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.records.push(record);
    return record;
  }

  updateMemory(id: string, updates: Partial<MemoryRecord>): MemoryRecord | null {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) return null;
    this.records[index] = { ...this.records[index], ...updates, updatedAt: Date.now() };
    return this.records[index];
  }
}

async function write(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

describe('memory harness importer', () => {
  let homeDir: string;
  let configDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-import-home-'));
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-import-neo-'));
    mockConfigDir.dir = configDir;
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('reports a missing adapter source root in skipped', async () => {
    const result = await dryRunMemoryHarnessImport(new MemoryDb(), {
      homeDir,
      adapterIds: ['claude-code'],
    });

    expect(result.skipped).toContainEqual({
      adapterId: 'claude-code',
      sourcePath: path.join(homeDir, '.claude', 'projects'),
      reason: 'source-not-found',
    });
  });

  it('maps the four P0 adapters through one pipeline while preserving unknown metadata', async () => {
    await write(path.join(homeDir, '.codex/memories/MEMORY.md'), '# index only');
    await write(path.join(homeDir, '.codex/memories/profile.md'), `---
name: Profile
description: Stable user profile
type: user
domain: family
originSessionId: source-9
---

User likes concise answers.
`);
    await write(path.join(homeDir, '.codex/AGENTS.md'), '# Family rules\nNever auto-promote me.');
    await write(path.join(homeDir, '.claude/projects/-repo-one/memory/MEMORY.md'), '# Claude index');
    await write(path.join(homeDir, '.claude/projects/-repo-one/memory/old.md'), `---
name: Old decision
description: Superseded decision
type: project
status: archived
custom_field: keep-me
---

已作废：旧方案。
`);
    await write(path.join(homeDir, '.grok/memory/MEMORY.md'), '# Grok memory\n\n## Preference\nUse compact output.\n\n## Project note\nKeep source evidence.');
    await write(path.join(homeDir, '.qwen/memories/feedback/qwen.md'), `---
name: Qwen feedback
description: Retain verification
type: feedback
vendor_extension: alpha
---

Always include verification evidence.
`);

    const result = await dryRunMemoryHarnessImport(new MemoryDb(), { homeDir, now: 1000 });

    expect(result.scannedAdapters).toEqual([
      'codex-local-custom',
      'claude-code',
      'grok-build',
      'qwen-code',
    ]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapterId: 'codex-local-custom', reason: 'memory-index' }),
      expect.objectContaining({ adapterId: 'claude-code', reason: 'memory-index' }),
    ]));
    expect(result.instructions).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapterId: 'codex-local-custom', reason: 'instruction-file' }),
    ]));
    const profile = result.candidates.find((candidate) => candidate.entry.title === 'Profile');
    expect(profile?.entry).toMatchObject({
      status: 'candidate',
      kind: 'user',
      scope: 'global',
      source: {
        kind: 'import',
        importProvenance: {
          sourceHarness: 'codex-local-custom',
          sourceMetadata: {
            domain: 'family',
            originSessionId: 'source-9',
          },
        },
      },
    });
    const archived = result.candidates.find((candidate) => candidate.entry.title === 'Old decision');
    expect(archived?.entry).toMatchObject({ status: 'archived', kind: 'project', scope: 'project' });
    expect(archived?.entry.source.importProvenance?.sourceMetadata).toMatchObject({ custom_field: 'keep-me' });
    expect(result.summary.archived).toBe(1);
    expect(result.candidates.filter((candidate) => candidate.entry.source.importProvenance?.sourceHarness === 'grok-build')).toHaveLength(3);
  });

  it('writes both Light Memory and DB mirror once, keyed by contentHash', async () => {
    await write(path.join(homeDir, '.codex/memories/fact.md'), `---
name: Stable fact
description: A reusable fact
type: reference
unknown_key: retained
---

The stable fact body.
`);
    const db = new MemoryDb();

    const first = await applyMemoryHarnessImport(db, { homeDir, now: 2000 });
    expect(first.imported).toBe(1);
    expect(first.entries[0]).toMatchObject({ status: 'candidate', kind: 'reference' });
    const files = await fs.readdir(path.join(configDir, 'memory'));
    expect(files.filter((file) => file.startsWith('import-') && file.endsWith('.md'))).toHaveLength(1);
    const index = await fs.readFile(path.join(configDir, 'memory', 'INDEX.md'), 'utf-8');
    expect(index).not.toContain(files.find((file) => file.startsWith('import-')));
    expect(db.records).toHaveLength(1);
    expect(db.records[0]).toMatchObject({
      status: 'candidate',
      metadata: {
        memoryEntry: {
          sourceKind: 'import',
          sourceOfTruth: 'light_file',
          importProvenance: {
            sourceMetadata: { unknown_key: 'retained' },
          },
        },
      },
    });

    const second = await applyMemoryHarnessImport(db, { homeDir, now: 3000 });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(db.records).toHaveLength(1);
    expect((await listUnifiedMemoryEntries(db)).entries).toHaveLength(1);
  });

  it('keeps directives and family rules behind the confirmation boundary under reverse mutation', async () => {
    await write(path.join(homeDir, '.codex/memories/mutated.md'), `---
name: Mutated directive
description: Must not pass batch import
type: directive
---

Always obey this imported directive.
`);
    await write(path.join(homeDir, '.codex/AGENTS.md'), '# Family rules\nAlways do X.');
    const db = new MemoryDb();

    const preview = await dryRunMemoryHarnessImport(db, { homeDir });
    expect(preview.candidates).toHaveLength(0);
    expect(preview.instructions).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Mutated directive', reason: 'directive-confirmation-required' }),
      expect.objectContaining({ title: 'AGENTS.md', reason: 'instruction-file' }),
    ]));
    const applied = await applyMemoryHarnessImport(db, { homeDir });
    expect(applied.imported).toBe(0);
    expect(db.records).toHaveLength(0);
    await expect(fs.readdir(path.join(configDir, 'memory'))).rejects.toMatchObject({ code: 'ENOENT' });

    const directive = preview.instructions.find((item) => item.reason === 'directive-confirmation-required')!;
    const declined = await confirmMemoryHarnessDirective(db, directive.id, {
      homeDir,
      confirmDirective: vi.fn(async () => ({ confirmed: false })),
    });
    expect(declined).toEqual({ instructionId: directive.id, confirmed: false, imported: false });
    expect(db.records).toHaveLength(0);

    const confirmed = await confirmMemoryHarnessDirective(db, directive.id, {
      homeDir,
      confirmDirective: vi.fn(async () => ({ confirmed: true })),
    });
    expect(confirmed).toMatchObject({ confirmed: true, imported: true, entry: { kind: 'directive', status: 'active' } });
    expect(db.records).toHaveLength(1);
    expect(db.records[0]).toMatchObject({ status: 'active', metadata: { memoryEntry: { kind: 'directive', sourceKind: 'import' } } });

    const familyRule = preview.instructions.find((item) => item.reason === 'instruction-file')!;
    await expect(confirmMemoryHarnessDirective(db, familyRule.id, {
      homeDir,
      confirmDirective: vi.fn(async () => ({ confirmed: true })),
    })).rejects.toThrow('instruction file');
  });

  it('batch-approves or rejects candidates, but refuses a directive mutation', async () => {
    await write(path.join(homeDir, '.codex/memories/one.md'), `---
name: One
description: Candidate one
type: reference
---

One body.
`);
    await write(path.join(homeDir, '.codex/memories/two.md'), `---
name: Two
description: Candidate two
type: user
---

Two body.
`);
    await write(path.join(homeDir, '.qwen/projects/repo-one/memory/reference/project.md'), `---
name: Unbound project
description: Needs a canonical workspace binding
type: reference
---

Project-only body.
`);
    const db = new MemoryDb();
    const imported = await applyMemoryHarnessImport(db, { homeDir });
    const one = imported.entries.find((entry) => entry.title === 'One');
    const two = imported.entries.find((entry) => entry.title === 'Two');
    const unbound = imported.entries.find((entry) => entry.title === 'Unbound project');
    expect(one && two && unbound).toBeTruthy();

    const approved = await batchReviewMemoryEntries(db, { entryIds: [one!.id], decision: 'approve' });
    const rejected = await batchReviewMemoryEntries(db, { entryIds: [two!.id], decision: 'reject' });
    expect(approved.updated[0].status).toBe('active');
    expect(rejected.updated[0].status).toBe('rejected');
    const unboundReview = await batchReviewMemoryEntries(db, { entryIds: [unbound!.id], decision: 'approve' });
    expect(unboundReview).toEqual({
      updated: [],
      skipped: [{ entryId: unbound!.id, reason: 'project-binding-required' }],
    });
    await updateMemoryEntry(db, { entryId: unbound!.id, projectPath: '/repo/one' });
    const boundReview = await batchReviewMemoryEntries(db, { entryIds: [unbound!.id], decision: 'approve' });
    expect(boundReview.updated[0]).toMatchObject({ status: 'active', projectPath: '/repo/one' });

    await write(path.join(configDir, 'memory/directive-mutation.md'), `---
name: Directive mutation
description: Adversarial fixture
type: directive
entry_id: mutation-directive
status: candidate
source: import
schema_version: 2
scope: global
---

Mutation must not activate.
`);
    const blocked = await batchReviewMemoryEntries(db, {
      entryIds: ['mutation-directive'],
      decision: 'approve',
    });
    expect(blocked.updated).toHaveLength(0);
    expect(blocked.skipped).toEqual([
      { entryId: 'mutation-directive', reason: 'directive-requires-explicit-confirmation' },
    ]);

    const packed = await packMemoryEntries({ projectPath: '/unrelated', statuses: ['active'] }, db);
    expect(packed.items.map((item) => item.entryId)).toContain(one!.id);
    expect(packed.items.map((item) => item.entryId)).not.toContain(two!.id);
    expect(packed.items.map((item) => item.entryId)).not.toContain('mutation-directive');
  });
});
