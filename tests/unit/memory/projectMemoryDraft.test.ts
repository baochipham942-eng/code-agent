import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';
import type { ProjectMemoryDraftResult } from '../../../src/shared/contract/memory';

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

import { draftProjectMemory } from '../../../src/host/memory/projectMemoryDraft';
import { listUnifiedMemoryEntries } from '../../../src/host/memory/memoryEntryRuntime';

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

async function draftFiles(): Promise<string[]> {
  return (await fs.readdir(path.join(mockConfigDir.dir, 'memory')))
    .filter((file) => file.startsWith('initmem-') && file.endsWith('.md'))
    .sort();
}

function entryContents(result: ProjectMemoryDraftResult): string {
  return result.entries.map((entry) => `${entry.title}\n${entry.summary}\n${entry.content}`).join('\n');
}

describe('project memory draft', () => {
  let homeDir: string;
  let configDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-draft-home-'));
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-draft-neo-'));
    mockConfigDir.dir = configDir;
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('drafts the fixed topic set from a fake project and never reads .env', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-draft-src-'));
    try {
      await write(path.join(projectDir, 'package.json'), JSON.stringify({
        name: 'fake-app',
        version: '0.1.0',
        scripts: { build: 'tsc -p .', test: 'vitest run' },
        dependencies: { react: '^19.0.0' },
        devDependencies: { typescript: '~5.5.0' },
      }));
      await write(path.join(projectDir, 'README.md'), '# Fake App\n\n[![ci](https://example.invalid/badge.svg)](https://example.invalid)\n\nA deterministic scanner fixture for project memory drafts.\n');
      await fs.mkdir(path.join(projectDir, 'src'));
      await fs.mkdir(path.join(projectDir, 'tests'));
      await fs.mkdir(path.join(projectDir, 'node_modules'));
      await write(path.join(projectDir, '.env'), 'API_TOKEN=SUPER-SECRET-TOKEN-XYZ\n');

      const db = new MemoryDb();
      const result = await draftProjectMemory(db, { projectDir, now: 1000 });

      expect(result.written).toBe(4);
      expect(result.skipped).toEqual([]);
      expect(result.entries.map((entry) => entry.kind)).toEqual(['project', 'project', 'project', 'project']);
      expect(result.entries.every((entry) => entry.scope === 'project')).toBe(true);
      expect(result.entries.every((entry) => entry.status === 'candidate')).toBe(true);
      expect(result.entries.every((entry) => entry.projectPath === path.resolve(projectDir))).toBe(true);
      expect(result.entries.every((entry) => entry.id.startsWith('initmem_'))).toBe(true);
      expect(result.entries.map((entry) => entry.title).sort()).toEqual([
        '常用命令（init-memory 草稿）',
        '目录结构（init-memory 草稿）',
        '技术栈（init-memory 草稿）',
        '项目定位（init-memory 草稿）',
      ].sort());

      const byTitle = new Map(result.entries.map((entry) => [entry.title, entry]));
      expect(byTitle.get('技术栈（init-memory 草稿）')!.content).toContain('Node.js 项目：fake-app@0.1.0');
      expect(byTitle.get('技术栈（init-memory 草稿）')!.content).toContain('react@^19.0.0');
      expect(byTitle.get('常用命令（init-memory 草稿）')!.content).toContain('npm run build — tsc -p .');
      expect(byTitle.get('目录结构（init-memory 草稿）')!.content).toContain('src、tests');
      expect(byTitle.get('目录结构（init-memory 草稿）')!.content).not.toContain('node_modules');
      expect(byTitle.get('项目定位（init-memory 草稿）')!.content)
        .toContain('README 定位：A deterministic scanner fixture for project memory drafts.');

      // .env 与 node_modules 都不在任何草稿正文/摘要里出现
      expect(entryContents(result)).not.toContain('SUPER-SECRET');
      expect(entryContents(result)).not.toContain('.env');

      // 落盘 + DB 镜像：candidate 状态、kind=project、带稳定 entry_id
      expect(await draftFiles()).toHaveLength(4);
      expect(db.records).toHaveLength(4);
      expect(db.records.every((record) => record.status === 'candidate')).toBe(true);
      const unified = await listUnifiedMemoryEntries(db);
      expect(unified.entries.filter((entry) => entry.id.startsWith('initmem_'))).toHaveLength(4);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second run writes nothing and reports every topic skipped', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-draft-idem-'));
    try {
      await write(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'idem', scripts: { test: 'node --test' } }));
      await fs.mkdir(path.join(projectDir, 'src'));
      const db = new MemoryDb();

      const first = await draftProjectMemory(db, { projectDir, now: 1000 });
      expect(first.written).toBe(3); // tech-stack + common-commands + directory-layout（无 README）
      const filesAfterFirst = await draftFiles();
      expect(filesAfterFirst).toHaveLength(3);

      const second = await draftProjectMemory(db, { projectDir, now: 2000 });
      expect(second.written).toBe(0);
      expect(second.entries).toEqual([]);
      expect(second.skipped).toEqual([
        { topic: 'tech-stack', reason: 'existing-key' },
        { topic: 'directory-layout', reason: 'existing-key' },
        { topic: 'common-commands', reason: 'existing-key' },
        { topic: 'readme-purpose', reason: 'source-absent' },
      ]);
      expect(await draftFiles()).toEqual(filesAfterFirst);
      expect(db.records).toHaveLength(3);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('leaves a pre-existing same-key entry untouched (any status)', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-draft-key-'));
    try {
      await write(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'keyed' }));
      await fs.mkdir(path.join(projectDir, 'src'));
      const db = new MemoryDb();

      const first = await draftProjectMemory(db, { projectDir, now: 1000 });
      const stackEntry = first.entries.find((entry) => entry.title.includes('技术栈'))!;

      // 把已落盘的同键条目改成人工编辑过的正文 + active 状态（模拟用户已确认/改写）
      const fileName = stackEntry.source.filePath!;
      const filePath = path.join(configDir, 'memory', fileName);
      const edited = (await fs.readFile(filePath, 'utf8')).replace('Node.js 项目：keyed', 'Node.js 项目：keyed（人工改写）');
      await write(filePath, edited.replace('status: candidate', 'status: active'));

      const second = await draftProjectMemory(db, { projectDir, now: 3000 });
      expect(second.written).toBe(0);
      expect(second.skipped).toContainEqual({ topic: 'tech-stack', reason: 'existing-key' });

      const after = await fs.readFile(filePath, 'utf8');
      expect(after).toContain('人工改写');
      expect(after).toContain('status: active');
      expect((await draftFiles()).length).toBe(first.written);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('skips every topic with source-absent for an empty directory', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-draft-empty-'));
    try {
      const db = new MemoryDb();
      const result = await draftProjectMemory(db, { projectDir, now: 1000 });
      expect(result.written).toBe(0);
      expect(result.skipped).toHaveLength(4);
      expect(result.skipped.every((item) => item.reason === 'source-absent')).toBe(true);
      expect(db.records).toHaveLength(0);
      await expect(fs.readdir(path.join(configDir, 'memory'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('reads Makefile targets and non-node ecosystems, and refuses symlinked manifests', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-draft-mixed-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-draft-outside-'));
    try {
      await write(path.join(projectDir, 'Makefile'), 'build:\n\techo build\n\n.PHONY: build\ntest-unit:\n\techo test\n');
      await write(path.join(projectDir, 'go.mod'), 'module example.invalid/mixed\n\ngo 1.24\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n\tgithub.com/baz/qux v0.4.0 // indirect\n)\n');
      await write(path.join(projectDir, 'Cargo.toml'), '[package]\nname = "mixed"\nversion = "0.2.0"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n');
      await fs.mkdir(path.join(projectDir, 'docs'));
      // 指向 projectDir 外的符号链接清单：必须当不存在处理，绝不跟随读出界
      await write(path.join(outsideDir, 'package.json'), JSON.stringify({ name: 'outside-project' }));
      await fs.symlink(path.join(outsideDir, 'package.json'), path.join(projectDir, 'package.json'));

      const db = new MemoryDb();
      const result = await draftProjectMemory(db, { projectDir, now: 1000 });

      expect(result.written).toBe(3);
      const joined = entryContents(result);
      expect(joined).toContain('Go 项目：module example.invalid/mixed');
      expect(joined).toContain('github.com/foo/bar@v1.2.3');
      expect(joined).toContain('Rust 项目：mixed@0.2.0');
      expect(joined).toContain('make build');
      expect(joined).toContain('make test-unit');
      expect(joined).not.toContain('.PHONY');
      expect(joined).not.toContain('outside-project'); // 符号链接未被跟随
      expect(result.skipped).toEqual([
        { topic: 'readme-purpose', reason: 'source-absent' },
      ]);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
