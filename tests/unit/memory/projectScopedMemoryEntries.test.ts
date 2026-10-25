// ============================================================================
// Project Scoped Memory Entries Tests — 设置 > 记忆页的项目层记忆 overlay（FB-413）
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  deleteProjectScopedMemoryEntry,
  isProjectScopedEntryId,
  overlayProjectScopedEntries,
  updateProjectScopedMemoryEntry,
} from '../../../src/host/memory/projectScopedMemoryEntries';
import { getProjectKey } from '../../../src/host/services/roleAssets/roleAssetPaths';
import { writeScopedMemory } from '../../../src/host/services/roleAssets/roleAssetService';
import { listUnifiedMemoryEntries, packMemoryEntries } from '../../../src/host/memory/memoryEntryRuntime';
import { ROLE_ASSETS } from '../../../src/shared/constants';
import type { MemoryEntry, MemoryEntryListResult } from '../../../src/shared/contract/memory';

const WORKSPACE = path.join(os.tmpdir(), 'proj-mem-fixture-workspace');

function memoriesDirFor(projectKey: string): string {
  return path.join(mockConfigDir.dir, ROLE_ASSETS.PROJECTS_DIR, projectKey, 'memory', ROLE_ASSETS.MEMORIES_SUBDIR);
}

function indexPathFor(projectKey: string): string {
  return path.join(mockConfigDir.dir, ROLE_ASSETS.PROJECTS_DIR, projectKey, 'memory', ROLE_ASSETS.INDEX_FILENAME);
}

/** 与 writeScopedMemory 落盘同构的夹具文件（含 status 行则加上） */
async function seedProjectMemory(projectKey: string, filename: string, options: { status?: string; meta?: boolean } = {}): Promise<string> {
  const dir = memoriesDirFor(projectKey);
  await fs.mkdir(dir, { recursive: true });
  const statusLine = options.status ? `status: ${options.status}\n` : '';
  const content = `---
name: pnpm workspaces
description: This project uses pnpm, never npm install
scope: project
created: 2026-10-01
${statusLine}---

This project uses pnpm workspaces. Run installs with pnpm only.
`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content, 'utf-8');
  if (options.meta !== false) {
    const projectDir = path.dirname(path.dirname(dir));
    await fs.writeFile(
      path.join(projectDir, ROLE_ASSETS.META_FILENAME),
      JSON.stringify({ workspacePath: WORKSPACE, createdAt: '2026-10-01T00:00:00.000Z', schemaVersion: 1 }, null, 2),
      'utf-8',
    );
  }
  const indexPath = indexPathFor(projectKey);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, `# 项目记忆索引\n\n- [${filename}](${ROLE_ASSETS.MEMORIES_SUBDIR}/${filename}) — This project uses pnpm, never npm install\n`, 'utf-8');
  return filePath;
}

function listResult(entries: MemoryEntry[]): MemoryEntryListResult {
  return {
    entries,
    sourceCounts: { light_file: entries.filter((entry) => entry.source.sourceOfTruth === 'light_file').length, db_memory: 0 },
  };
}

/** 页面同款入口：空底表 + overlay = 纯项目层条目列表 */
async function listOverlayEntries(): Promise<MemoryEntry[]> {
  return (await overlayProjectScopedEntries({ entries: [], sourceCounts: { light_file: 0, db_memory: 0 } })).entries;
}

describe('projectScopedMemoryEntries', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-scoped-memory-'));
    mockConfigDir.dir = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('isProjectScopedEntryId', () => {
    it('recognizes the project: prefix only', () => {
      expect(isProjectScopedEntryId(`project:${'a'.repeat(16)}:pnpm.md`)).toBe(true);
      expect(isProjectScopedEntryId('light:pnpm.md')).toBe(false);
      expect(isProjectScopedEntryId('db:mem-1')).toBe(false);
      expect(isProjectScopedEntryId('mem_entry_abc')).toBe(false);
    });
  });

  describe('project entry listing (via the page overlay path)', () => {
    it('returns a project memory with scope=project, projectPath from meta.json and a real-path label', async () => {
      const key = getProjectKey(WORKSPACE);
      await seedProjectMemory(key, 'pnpm.md');

      const entries = await listOverlayEntries();

      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.id).toBe(`project:${key}:pnpm.md`);
      expect(entry.scope).toBe('project');
      expect(entry.kind).toBe('project');
      expect(entry.status).toBe('active');
      expect(entry.title).toBe('pnpm workspaces');
      expect(entry.summary).toBe('This project uses pnpm, never npm install');
      expect(entry.content).toContain('pnpm workspaces');
      expect(entry.projectPath).toBe(WORKSPACE);
      expect(entry.source.sourceOfTruth).toBe('light_file');
      expect(entry.source.filePath).toBe('pnpm.md');
      // label 显示真实路径（夹具在 home 之外，displayPath 原样给绝对路径）
      expect(entry.source.label).toBe(path.join(memoriesDirFor(key), 'pnpm.md'));
    });

    it('reads status from frontmatter and falls back to null projectPath without meta.json', async () => {
      const key = getProjectKey(WORKSPACE);
      await seedProjectMemory(key, 'legacy.md', { status: 'archived', meta: false });

      const entries = await listOverlayEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe('archived');
      expect(entries[0].projectPath).toBeNull();
    });

    it('skips unreadable entries without throwing (warn with reason)', async () => {
      const key = getProjectKey(WORKSPACE);
      await seedProjectMemory(key, 'good.md');
      // 目录冒充 .md 文件：readFile 必失败，列表不能连坐
      await fs.mkdir(path.join(memoriesDirFor(key), 'trap.md'), { recursive: true });

      const entries = await listOverlayEntries();

      expect(entries.map((entry) => entry.source.filePath)).toEqual(['good.md']);
    });

    it('returns empty when no projects root exists', async () => {
      await expect(listOverlayEntries()).resolves.toEqual([]);
    });
  });

  describe('overlayProjectScopedEntries', () => {
    it('appends project entries, counts them as light_file and keeps updatedAt order', async () => {
      const key = getProjectKey(WORKSPACE);
      await seedProjectMemory(key, 'pnpm.md');
      const projectEntries = await listOverlayEntries();
      const baseEntry: MemoryEntry = {
        ...projectEntries[0],
        id: 'light:global.md',
        updatedAt: projectEntries[0].updatedAt + 5_000,
      };
      const base = listResult([baseEntry]);
      expect(base.entries).toHaveLength(1);

      const overlaid = await overlayProjectScopedEntries(base);

      expect(overlaid.entries).toHaveLength(2);
      expect(overlaid.sourceCounts.light_file).toBe(base.sourceCounts.light_file + 1);
      expect(overlaid.entries.map((entry) => entry.id)).toEqual(['light:global.md', `project:${key}:pnpm.md`]);
    });

    it('returns the input result untouched when there is no project memory', async () => {
      const base = listResult([]);
      await expect(overlayProjectScopedEntries(base)).resolves.toBe(base);
    });
  });

  describe('updateProjectScopedMemoryEntry', () => {
    it('rewrites name/description/body in the same file and keeps other frontmatter lines', async () => {
      const key = getProjectKey(WORKSPACE);
      const filePath = await seedProjectMemory(key, 'pnpm.md');
      const before = await fs.readFile(filePath, 'utf-8');

      const result = await updateProjectScopedMemoryEntry({
        entryId: `project:${key}:pnpm.md`,
        title: 'pnpm only',
        summary: 'Installs must go through pnpm',
        content: 'Installs must go through pnpm, never npm.',
        projectPath: '/somewhere/else',
      });

      const after = await fs.readFile(filePath, 'utf-8');
      expect(after).toContain('name: pnpm only');
      expect(after).toContain('description: Installs must go through pnpm');
      expect(after).toContain('scope: project');
      expect(after).toContain('created: 2026-10-01');
      expect(after).toContain('Installs must go through pnpm, never npm.');
      expect(after).not.toBe(before);
      // projectPath 编辑被忽略：meta.json 不动，归属仍由目录决定
      expect(result.entry.projectPath).toBe(WORKSPACE);
      expect(result.entry.title).toBe('pnpm only');
      const index = await fs.readFile(indexPathFor(key), 'utf-8');
      expect(index).toContain('- [pnpm.md]');
      expect(index).toContain('Installs must go through pnpm');
    });

    it('archives out of the injection index when status is set to archived', async () => {
      const key = getProjectKey(WORKSPACE);
      await seedProjectMemory(key, 'pnpm.md');

      const result = await updateProjectScopedMemoryEntry({
        entryId: `project:${key}:pnpm.md`,
        status: 'archived',
      });

      expect(result.entry.status).toBe('archived');
      const file = await fs.readFile(path.join(memoriesDirFor(key), 'pnpm.md'), 'utf-8');
      expect(file).toContain('status: archived');
      expect(file).toContain('scope: project');
      const index = await fs.readFile(indexPathFor(key), 'utf-8');
      expect(index).not.toContain('- [pnpm.md]');
    });

    it('re-adds to the injection index when an archived entry is reactivated', async () => {
      const key = getProjectKey(WORKSPACE);
      await seedProjectMemory(key, 'pnpm.md', { status: 'archived' });
      await fs.writeFile(indexPathFor(key), '# 项目记忆索引\n', 'utf-8');

      const result = await updateProjectScopedMemoryEntry({
        entryId: `project:${key}:pnpm.md`,
        status: 'active',
      });

      expect(result.entry.status).toBe('active');
      const index = await fs.readFile(indexPathFor(key), 'utf-8');
      expect(index).toContain('- [pnpm.md]');
    });

    it('throws a clear error when the file is gone', async () => {
      const key = getProjectKey(WORKSPACE);
      await expect(updateProjectScopedMemoryEntry({ entryId: `project:${key}:ghost.md`, title: 'x' }))
        .rejects.toThrow(/Project memory file not found: .*ghost\.md/);
    });

    it('rejects traversal ids', async () => {
      await expect(updateProjectScopedMemoryEntry({ entryId: 'project:../..:evil.md' }))
        .rejects.toThrow('Invalid project memory entry id: project:../..:evil.md');
      await expect(updateProjectScopedMemoryEntry({ entryId: 'project:key:../evil.md' }))
        .rejects.toThrow('Invalid project memory entry id: project:key:../evil.md');
      await expect(updateProjectScopedMemoryEntry({ entryId: 'project:key:not-md.txt' }))
        .rejects.toThrow('Invalid project memory entry id: project:key:not-md.txt');
      await expect(updateProjectScopedMemoryEntry({ entryId: 'project:key:a:b.md' }))
        .rejects.toThrow('Invalid project memory entry id: project:key:a:b.md');
    });
  });

  describe('deleteProjectScopedMemoryEntry', () => {
    it('soft-archives the file and removes it from the project index', async () => {
      const key = getProjectKey(WORKSPACE);
      await seedProjectMemory(key, 'pnpm.md');

      const result = await deleteProjectScopedMemoryEntry({ entryId: `project:${key}:pnpm.md` });

      expect(result.deleted).toBe(true);
      expect(result.sourceOfTruth).toBe('light_file');
      const file = await fs.readFile(path.join(memoriesDirFor(key), 'pnpm.md'), 'utf-8');
      expect(file).toContain('status: archived');
      expect(file).toContain('pnpm workspaces'); // 正文保留
      const index = await fs.readFile(indexPathFor(key), 'utf-8');
      expect(index).not.toContain('- [pnpm.md]');
    });

    it('reports deleted=false and still cleans the index when the file is already gone', async () => {
      const key = getProjectKey(WORKSPACE);
      await seedProjectMemory(key, 'ghost.md');
      await fs.rm(path.join(memoriesDirFor(key), 'ghost.md'));

      const result = await deleteProjectScopedMemoryEntry({ entryId: `project:${key}:ghost.md` });

      expect(result.deleted).toBe(false);
      const index = await fs.readFile(indexPathFor(key), 'utf-8');
      expect(index).not.toContain('- [ghost.md]');
    });

    it('rejects traversal ids', async () => {
      await expect(deleteProjectScopedMemoryEntry({ entryId: 'project:..:evil.md' }))
        .rejects.toThrow('Invalid project memory entry id: project:..:evil.md');
    });
  });

  describe('shared memory paths stay untouched (no double injection / export pollution)', () => {
    it('listUnifiedMemoryEntries and packMemoryEntries do not include the project entry', async () => {
      const key = getProjectKey(WORKSPACE);
      await seedProjectMemory(key, 'pnpm.md');

      const unified = await listUnifiedMemoryEntries();
      expect(unified.entries.some((entry) => entry.id.startsWith('project:'))).toBe(false);
      expect(unified.sourceCounts.light_file).toBe(0);

      const packed = await packMemoryEntries({ query: 'pnpm' });
      expect(packed.items.some((item) => item.entryId.startsWith('project:'))).toBe(false);
    });
  });

  describe('round-trip with the real writer', () => {
    it('lists what writeScopedMemory writes, then update and delete operate on that file', async () => {
      await writeScopedMemory(
        { scope: 'project', workspacePath: WORKSPACE },
        {
          filename: 'conventions.md',
          name: 'Conventions',
          description: 'Commit style for this repo',
          content: 'Use conventional commits.',
        },
      );
      const key = getProjectKey(WORKSPACE);
      const entryId = `project:${key}:conventions.md`;

      const listed = await listOverlayEntries();
      expect(listed.map((entry) => entry.id)).toEqual([entryId]);
      expect(listed[0].status).toBe('active');

      await updateProjectScopedMemoryEntry({ entryId, content: 'Use conventional commits, always signed.' });
      const file = await fs.readFile(path.join(memoriesDirFor(key), 'conventions.md'), 'utf-8');
      expect(file).toContain('Use conventional commits, always signed.');
      expect(file).toContain('name: Conventions');

      const deleted = await deleteProjectScopedMemoryEntry({ entryId });
      expect(deleted.deleted).toBe(true);
      const after = await listOverlayEntries();
      expect(after[0].status).toBe('archived');
      const index = await fs.readFile(indexPathFor(key), 'utf-8');
      expect(index).not.toContain('- [conventions.md]');
    });
  });
});
