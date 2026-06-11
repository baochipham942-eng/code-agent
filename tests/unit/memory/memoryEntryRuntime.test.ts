import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { MemoryRecord } from '../../../src/main/services/core/repositories';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  applyImportMemoryBundleV2,
  buildActiveMemoryEntryFromInbox,
  dryRunImportMemoryBundleV2,
  exportMemoryBundleV2,
  deleteMemoryEntry,
  listUnifiedMemoryEntries,
  packMemoryEntries,
  rebuildMemoryMirrorFromLightFiles,
  updateMemoryEntry,
  writeActiveEntryToLightMemory,
} from '../../../src/main/memory/memoryEntryRuntime';

function record(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'mem-default',
    type: 'project_knowledge',
    category: 'flush_decision',
    content: 'Default',
    summary: 'Default',
    source: 'user_defined',
    projectPath: undefined,
    sessionId: undefined,
    confidence: 1,
    metadata: {},
    accessCount: 0,
    createdAt: 1778664000000,
    updatedAt: 1778664000000,
    ...overrides,
  };
}

describe('memoryEntryRuntime', () => {
  let tmpDir: string;
  let memDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-entry-runtime-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes approved inbox entries as active Light Memory source files', async () => {
    const entry = buildActiveMemoryEntryFromInbox({
      candidateId: 'flush:mem-2',
      content: 'Knowledge Inbox 采纳后进入稳定项目知识',
      title: 'Inbox 采纳闭环',
      source: '压缩前提取',
      reason: '用户确认后沉淀',
      kind: '候选项目知识',
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
      now: 1778666000000,
    });

    const file = await writeActiveEntryToLightMemory(entry);

    expect(file).toMatchObject({
      entryId: entry.id,
      status: 'active',
      source: 'knowledge_inbox',
      schemaVersion: 2,
      type: 'project',
      content: 'Knowledge Inbox 采纳后进入稳定项目知识',
    });

    const index = await fs.readFile(path.join(memDir, 'INDEX.md'), 'utf-8');
    expect(index).toContain(`[${file.filename}](${file.filename})`);
    expect(index).toContain('用户确认后沉淀');
  });

  it('rebuilds DB mirror records from Light Memory files without making DB the source of truth', async () => {
    await fs.writeFile(path.join(memDir, 'project-rule.md'), `---
name: Project Rule
description: Follow current project patterns
type: project
entry_id: mem_entry_project
status: active
source: knowledge_inbox
schema_version: 2
---

Use current project patterns.
`, 'utf-8');

    const created: MemoryRecord[] = [];
    const db = {
      listMemories: vi.fn(() => [] as MemoryRecord[]),
      createMemory: vi.fn((data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>) => {
        const next = record({
          id: `mem-created-${created.length + 1}`,
          ...data,
          accessCount: 0,
          createdAt: 1778666100000,
          updatedAt: 1778666100000,
        });
        created.push(next);
        return next;
      }),
      updateMemory: vi.fn(),
    };

    const result = await rebuildMemoryMirrorFromLightFiles(db);

    expect(result).toEqual({
      totalLightFiles: 1,
      mirrored: 1,
      created: 1,
      updated: 0,
      skipped: [],
    });
    expect(db.createMemory).toHaveBeenCalledWith(expect.objectContaining({
      type: 'project_knowledge',
      category: 'flush_decision',
      content: 'Use current project patterns.',
      source: 'user_defined',
      metadata: expect.objectContaining({
        memoryEntry: expect.objectContaining({
          id: 'mem_entry_project',
          status: 'active',
          sourceOfTruth: 'light_file',
          filePath: 'project-rule.md',
        }),
      }),
    }));

    const listed = await listUnifiedMemoryEntries(db);
    expect(listed.entries.map((entry) => entry.id)).toEqual(['mem_entry_project']);
    expect(listed.sourceCounts).toEqual({ light_file: 1, db_memory: 0 });
  });

  it('updates Light Memory entries and refreshes the DB mirror', async () => {
    await fs.writeFile(path.join(memDir, 'project-rule.md'), `---
name: Project Rule
description: Follow current project patterns
type: project
entry_id: mem_entry_project
status: active
source: knowledge_inbox
schema_version: 2
---

Use current project patterns.
`, 'utf-8');

    const mirror = record({
      id: 'mem-mirror',
      content: 'Use current project patterns.',
      summary: 'Project Rule',
      metadata: {
        memoryEntry: {
          schemaVersion: 2,
          id: 'mem_entry_project',
          status: 'active',
          kind: 'project',
          scope: 'project',
          sourceOfTruth: 'light_file',
          filePath: 'project-rule.md',
          evidence: [{ filePath: 'project-rule.md' }],
        },
      },
    });
    const db = {
      listMemories: vi.fn(() => [mirror] as MemoryRecord[]),
      createMemory: vi.fn(),
      updateMemory: vi.fn((id: string, updates: Partial<MemoryRecord>) => record({
        ...mirror,
        id,
        ...updates,
        updatedAt: 1778667000000,
      })),
    };

    const result = await updateMemoryEntry(db, {
      entryId: 'mem_entry_project',
      title: 'Updated Rule',
      summary: 'Updated summary',
      content: 'Updated memory body.',
      status: 'archived',
      kind: 'feedback',
    });

    expect(result.entry).toMatchObject({
      id: 'mem_entry_project',
      title: 'Updated Rule',
      status: 'archived',
      kind: 'feedback',
    });
    expect(result.mirrorRebuild).toMatchObject({ mirrored: 1, updated: 1 });
    const raw = await fs.readFile(path.join(memDir, 'project-rule.md'), 'utf-8');
    expect(raw).toContain('name: Updated Rule');
    expect(raw).toContain('type: feedback');
    expect(raw).toContain('status: archived');
    expect(raw).toContain('Updated memory body.');
    expect(db.updateMemory).toHaveBeenCalledWith('mem-mirror', expect.objectContaining({
      content: 'Updated memory body.',
      summary: 'Updated Rule',
      category: 'user_requirement',
      metadata: expect.objectContaining({
        memoryEntry: expect.objectContaining({
          id: 'mem_entry_project',
          sourceOfTruth: 'light_file',
          status: 'archived',
          kind: 'feedback',
        }),
      }),
    }));
  });

  it('updates DB memory entries without creating Light Memory files', async () => {
    const dbRecord = record({
      id: 'mem-db',
      content: 'Original DB content.',
      summary: 'Original DB memory',
      metadata: {
        memoryEntry: {
          schemaVersion: 2,
          id: 'mem_entry_db',
          status: 'active',
          kind: 'project',
          scope: 'project',
          sourceOfTruth: 'db_memory',
          evidence: [{ memoryId: 'mem-db' }],
        },
      },
    });
    const db = {
      listMemories: vi.fn(() => [dbRecord] as MemoryRecord[]),
      createMemory: vi.fn(),
      updateMemory: vi.fn((id: string, updates: Partial<MemoryRecord>) => record({
        ...dbRecord,
        id,
        ...updates,
        updatedAt: 1778667100000,
      })),
    };

    const result = await updateMemoryEntry(db, {
      entryId: 'mem_entry_db',
      title: 'Updated DB Rule',
      content: 'Updated DB content.',
      status: 'archived',
      kind: 'pattern',
    });

    expect(result.entry).toMatchObject({
      id: 'mem_entry_db',
      status: 'archived',
      kind: 'pattern',
      content: 'Updated DB content.',
      source: expect.objectContaining({ sourceOfTruth: 'db_memory', memoryId: 'mem-db' }),
    });
    expect(db.updateMemory).toHaveBeenCalledWith('mem-db', expect.objectContaining({
      category: 'pattern',
      content: 'Updated DB content.',
      summary: 'Updated DB Rule',
      metadata: expect.objectContaining({
        memoryEntry: expect.objectContaining({
          id: 'mem_entry_db',
          sourceOfTruth: 'db_memory',
          status: 'archived',
          kind: 'pattern',
        }),
      }),
    }));
    await expect(fs.readdir(memDir)).resolves.not.toContain('memory-db.md');
  });

  it('deletes Light Memory entries and removes their DB mirror', async () => {
    await fs.writeFile(path.join(memDir, 'project-rule.md'), `---
name: Project Rule
description: Follow current project patterns
type: project
entry_id: mem_entry_project
status: active
source: knowledge_inbox
schema_version: 2
---

Use current project patterns.
`, 'utf-8');
    await fs.writeFile(path.join(memDir, 'INDEX.md'), '# Memory Index\n\n- [project-rule.md](project-rule.md) — Project Rule\n', 'utf-8');

    const mirror = record({
      id: 'mem-mirror',
      metadata: {
        memoryEntry: {
          schemaVersion: 2,
          id: 'mem_entry_project',
          status: 'active',
          kind: 'project',
          scope: 'project',
          sourceOfTruth: 'light_file',
          filePath: 'project-rule.md',
          evidence: [{ filePath: 'project-rule.md' }],
        },
      },
    });
    const db = {
      listMemories: vi.fn(() => [mirror] as MemoryRecord[]),
      createMemory: vi.fn(),
      updateMemory: vi.fn(),
      deleteMemory: vi.fn(() => true),
    };

    const result = await deleteMemoryEntry(db, { entryId: 'mem_entry_project' });

    expect(result).toMatchObject({
      deleted: true,
      sourceOfTruth: 'light_file',
      mirrorRebuild: expect.objectContaining({ totalLightFiles: 0 }),
    });
    await expect(fs.stat(path.join(memDir, 'project-rule.md'))).rejects.toThrow();
    expect(db.deleteMemory).toHaveBeenCalledWith('mem-mirror');
  });

  it('packs query-aware memory without vectors and keeps top evidence at the edges', async () => {
    await fs.writeFile(path.join(memDir, 'left-menu.md'), `---
name: Left Menu Rule
description: Keep common actions in the left menu
type: project
entry_id: mem_entry_left_menu
status: active
source: knowledge_inbox
schema_version: 2
---

The left menu should keep common daily actions visible.
`, 'utf-8');

    const db = {
      listMemories: vi.fn(() => [
        record({
          id: 'mem-project-match',
          content: 'Settings work should prioritize menu clarity and memory audit trace.',
          summary: 'Settings memory menu clarity',
          projectPath: '/repo/code-agent',
          metadata: {
            memoryEntry: {
              schemaVersion: 2,
              id: 'mem_entry_project_match',
              status: 'active',
              kind: 'project',
              scope: 'project',
              sourceOfTruth: 'db_memory',
              evidence: [{ memoryId: 'mem-project-match' }],
            },
          },
        }),
        record({
          id: 'mem-old-session',
          content: 'Unrelated archived conversation.',
          source: 'session_extracted',
          metadata: {},
        }),
      ] as MemoryRecord[]),
      createMemory: vi.fn(),
      updateMemory: vi.fn(),
    };

    const packed = await packMemoryEntries({
      query: 'menu memory',
      projectPath: '/repo/code-agent',
      maxItems: 3,
      perItemCharLimit: 80,
      totalCharBudget: 180,
    }, db);

    expect(packed.totalCandidates).toBe(2);
    expect(packed.selectedCount).toBe(2);
    expect(packed.items.map((item) => item.entryId)).toContain('mem_entry_left_menu');
    expect(packed.items.every((item) => item.status === 'active')).toBe(true);
    expect(packed.items[0].scoreReasons.some((reason) => reason.startsWith('query-match'))).toBe(true);
    expect(packed.block).toContain('<memory-pack>');
    expect(packed.totalChars).toBeLessThanOrEqual(180);
  });

  it('merges BM25 recall beyond the recent-window into pack candidates (roadmap 2.5)', async () => {
    // listMemories（最近窗口）只返回不相关条目；相关的老条目只能靠
    // searchMemories 的 FTS/BM25 通道召回 → 必须进入 pack 候选
    const oldRelevant = record({
      id: 'mem-old-relevant',
      content: 'Cassowary incident: the deploy pipeline failed on missing proxy env.',
      summary: 'cassowary deploy fix',
      metadata: {},
    });
    const db = {
      listMemories: vi.fn(() => [
        record({ id: 'mem-recent-noise', content: 'Unrelated recent note.', metadata: {} }),
      ] as MemoryRecord[]),
      searchMemories: vi.fn(() => [oldRelevant] as MemoryRecord[]),
      createMemory: vi.fn(),
      updateMemory: vi.fn(),
    };

    const packed = await packMemoryEntries({
      query: 'cassowary deploy',
      maxItems: 5,
      perItemCharLimit: 200,
      totalCharBudget: 600,
    }, db);

    expect(db.searchMemories).toHaveBeenCalled();
    expect(packed.items.map((item) => item.entryId)).toContain('db:mem-old-relevant');
  });

  it('does not duplicate pack candidates already present in the recent window', async () => {
    const shared = record({
      id: 'mem-shared',
      content: 'Numbat caching strategy details for repeated lookups.',
      summary: 'numbat caching',
      metadata: {},
    });
    const db = {
      listMemories: vi.fn(() => [shared] as MemoryRecord[]),
      searchMemories: vi.fn(() => [shared] as MemoryRecord[]),
      createMemory: vi.fn(),
      updateMemory: vi.fn(),
    };

    const packed = await packMemoryEntries({
      query: 'numbat caching',
      maxItems: 5,
      perItemCharLimit: 200,
      totalCharBudget: 600,
    }, db);

    const ids = packed.items.map((item) => item.entryId);
    expect(ids.filter((id) => id === 'db:mem-shared').length).toBe(1);
  });

  it('skips BM25 recall when there is no query', async () => {
    const db = {
      listMemories: vi.fn(() => [] as MemoryRecord[]),
      searchMemories: vi.fn(() => [] as MemoryRecord[]),
      createMemory: vi.fn(),
      updateMemory: vi.fn(),
    };

    await packMemoryEntries({ maxItems: 3 }, db);
    expect(db.searchMemories).not.toHaveBeenCalled();
  });

  it('exports v2 bundles and dry-runs import diffs before writing anything', async () => {
    await fs.writeFile(path.join(memDir, 'project-rule.md'), `---
name: Project Rule
description: Follow current project patterns
type: project
entry_id: mem_entry_project
status: active
source: knowledge_inbox
schema_version: 2
---

Use current project patterns.
`, 'utf-8');
    await fs.writeFile(path.join(memDir, 'INDEX.md'), '# Memory Index\n\n- [project-rule.md](project-rule.md) — Follow current project patterns\n', 'utf-8');

    const db = {
      listMemories: vi.fn(() => [] as MemoryRecord[]),
      createMemory: vi.fn(),
      updateMemory: vi.fn(),
    };

    const bundle = await exportMemoryBundleV2(db);
    expect(bundle).toMatchObject({
      schemaVersion: 2,
      entries: [expect.objectContaining({ id: 'mem_entry_project' })],
      index: expect.objectContaining({
        content: expect.stringContaining('project-rule.md'),
      }),
      evidenceManifest: [
        expect.objectContaining({
          entryId: 'mem_entry_project',
        }),
      ],
    });

    const same = await dryRunImportMemoryBundleV2(bundle, db);
    expect(same).toMatchObject({
      incomingCount: 1,
      existingCount: 1,
      added: 0,
      updated: 0,
      conflicted: 0,
      skipped: 1,
    });

    const changedDbSource = {
      ...bundle,
      entries: [
        {
          ...bundle.entries[0],
          content: 'Imported DB memory wants to replace local file.',
          source: {
            ...bundle.entries[0].source,
            kind: 'db_memory' as const,
            sourceOfTruth: 'db_memory' as const,
          },
        },
        {
          ...bundle.entries[0],
          id: 'mem_entry_new',
          title: 'New Imported Memory',
          content: 'A new imported memory.',
        },
      ],
    };

    const dryRun = await dryRunImportMemoryBundleV2(changedDbSource, db);
    expect(dryRun).toMatchObject({
      added: 1,
      conflicted: 1,
      skipped: 0,
    });
    expect(dryRun.items).toEqual([
      expect.objectContaining({ entryId: 'mem_entry_project', status: 'conflict' }),
      expect.objectContaining({ entryId: 'mem_entry_new', status: 'add' }),
    ]);
  });

  it('applies safe v2 imports by writing Light Memory files and rebuilding mirrors', async () => {
    const created: MemoryRecord[] = [];
    const db = {
      listMemories: vi.fn(() => [] as MemoryRecord[]),
      createMemory: vi.fn((data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>) => {
        const next = record({
          id: `mem-created-${created.length + 1}`,
          ...data,
          accessCount: 0,
          createdAt: 1778666200000,
          updatedAt: 1778666200000,
        });
        created.push(next);
        return next;
      }),
      updateMemory: vi.fn(),
    };
    const bundle = {
      schemaVersion: 2 as const,
      exportedAt: 1778666200000,
      entries: [
        {
          id: 'mem_entry_imported',
          schemaVersion: 2 as const,
          status: 'active' as const,
          kind: 'project' as const,
          scope: 'project' as const,
          title: 'Imported Project Rule',
          summary: 'Imported through v2 apply',
          content: 'Imported memory content.',
          source: {
            kind: 'import' as const,
            sourceOfTruth: 'light_file' as const,
            filePath: 'imported-project-rule.md',
            label: 'test bundle',
          },
          evidence: [{ source: 'test bundle' }],
          projectPath: '/repo/code-agent',
          sessionId: null,
          confidence: 1,
          createdAt: 1778666200000,
          updatedAt: 1778666200000,
        },
      ],
      index: { path: '/tmp/INDEX.md', content: null },
      evidenceManifest: [],
      sourceCounts: { light_file: 1, db_memory: 0 },
    };

    const result = await applyImportMemoryBundleV2(bundle, db);

    expect(result).toMatchObject({
      incomingCount: 1,
      added: 1,
      applied: 1,
      created: 1,
      updatedApplied: 0,
      skippedApply: 0,
      writtenFiles: ['imported-project-rule.md'],
      mirrorRebuild: expect.objectContaining({
        created: 1,
        updated: 0,
      }),
    });
    const raw = await fs.readFile(path.join(memDir, 'imported-project-rule.md'), 'utf-8');
    expect(raw).toContain('entry_id: mem_entry_imported');
    expect(raw).toContain('Imported memory content.');
    expect(db.createMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Imported memory content.',
      metadata: expect.objectContaining({
        memoryEntry: expect.objectContaining({
          id: 'mem_entry_imported',
          sourceOfTruth: 'light_file',
        }),
      }),
    }));
  });
});
