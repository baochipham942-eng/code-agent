import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';
import type { CanUseToolFn, Logger, ToolContext } from '../../../src/host/protocol/tools';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const mockDb = vi.hoisted(() => ({ current: null as MemoryDb | null }));

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

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => {
    if (!mockDb.current) throw new Error('test database is not ready');
    return mockDb.current;
  },
}));

import { proposeProjectMemoryModule } from '../../../src/host/tools/modules/lightMemory/proposeProjectMemory';
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
      createdAt: 1000,
      updatedAt: 1000,
    };
    this.records.push(record);
    return record;
  }

  updateMemory(id: string, updates: Partial<MemoryRecord>): MemoryRecord | null {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) return null;
    this.records[index] = { ...this.records[index], ...updates, updatedAt: 2000 };
    return this.records[index];
  }
}

const allow: CanUseToolFn = async () => ({ allow: true });

function toolContext(workingDir: string): ToolContext {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    sessionId: 'test-session',
    workingDir,
    abortSignal: new AbortController().signal,
    logger,
  } as ToolContext;
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

describe('ProposeProjectMemory', () => {
  let configDir: string;
  let projectDir: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-memory-neo-'));
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-memory-src-'));
    mockConfigDir.dir = configDir;
    mockDb.current = new MemoryDb();
    await write(path.join(projectDir, 'notes.md'), 'Household expense notes.\n');
  });

  afterEach(async () => {
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('writes a candidate and never an active memory', async () => {
    const handler = await proposeProjectMemoryModule.createHandler();
    const result = await handler.execute({
      topic: 'purpose',
      summary: 'Household expense notes',
      content: 'This folder tracks household expenses in plain notes.',
      sources: ['notes.md'],
    }, toolContext(projectDir), allow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('status: candidate');
    expect(result.output).not.toContain('status: active');
    expect(result.meta).toMatchObject({ outcome: 'written', status: 'candidate', topic: 'purpose' });

    const files = await draftFiles();
    expect(files).toHaveLength(1);
    const raw = await fs.readFile(path.join(configDir, 'memory', files[0]), 'utf8');
    expect(raw).toContain('status: candidate');
    expect(raw).not.toContain('status: active');
    expect(raw).toContain('This folder tracks household expenses in plain notes.');

    const db = mockDb.current!;
    expect(db.records).toHaveLength(1);
    expect(db.records[0].status).toBe('candidate');
    const unified = await listUnifiedMemoryEntries(db);
    const drafted = unified.entries.filter((entry) => entry.id.startsWith('initmem_'));
    expect(drafted).toHaveLength(1);
    expect(drafted[0].status).toBe('candidate');
    expect(drafted[0].kind).toBe('project');
    expect(drafted[0].scope).toBe('project');
  });

  it('writes the light-file candidate when the host database is not initialized', async () => {
    const db = mockDb.current!;
    db.listMemories = () => {
      throw new Error('Database not initialized');
    };
    const handler = await proposeProjectMemoryModule.createHandler();
    const result = await handler.execute({
      topic: 'purpose',
      summary: 'Household expense notes',
      content: 'This folder tracks household expenses in plain notes.',
      sources: ['notes.md'],
    }, toolContext(projectDir), allow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('status: candidate');
    const files = await draftFiles();
    expect(files).toHaveLength(1);
    const raw = await fs.readFile(path.join(configDir, 'memory', files[0]), 'utf8');
    expect(raw).toContain('status: candidate');
    expect(raw).not.toContain('status: active');
    expect(db.records).toHaveLength(0);

    const again = await handler.execute({
      topic: 'purpose',
      summary: 'replacement',
      content: 'This replacement must not be stored.',
      sources: ['notes.md'],
    }, toolContext(projectDir), allow);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.output).toContain('exists, not overwritten');
    expect(again.output).toContain('This folder tracks household expenses in plain notes.');
    expect(again.output).not.toContain('This replacement must not be stored.');
  });

  it('returns the existing content on the same key and leaves the file unchanged', async () => {
    const handler = await proposeProjectMemoryModule.createHandler();
    const first = await handler.execute({
      topic: 'key-files',
      summary: 'Notes file',
      content: 'notes.md — household expense notes.',
      sources: ['./notes.md'],
    }, toolContext(projectDir), allow);
    expect(first.ok).toBe(true);

    const files = await draftFiles();
    expect(files).toHaveLength(1);
    const filePath = path.join(configDir, 'memory', files[0]);
    const before = await fs.readFile(filePath);
    const recordsBefore = JSON.stringify(mockDb.current!.records);

    const second = await handler.execute({
      topic: 'key-files',
      summary: 'A different summary',
      content: 'This replacement must not be stored.',
      sources: ['notes.md'],
    }, toolContext(projectDir), allow);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.output).toContain('exists, not overwritten');
    expect(second.output).toContain('notes.md — household expense notes.');
    expect(second.output).not.toContain('This replacement must not be stored.');
    expect(await fs.readFile(filePath)).toEqual(before);
    expect(JSON.stringify(mockDb.current!.records)).toBe(recordsBefore);
    expect(await draftFiles()).toEqual(files);
  });

  it('does not overwrite a same-key entry that was already confirmed active', async () => {
    const handler = await proposeProjectMemoryModule.createHandler();
    await handler.execute({
      topic: 'conventions',
      summary: 'Plain sentences',
      content: 'Write amounts in plain sentences.',
      sources: ['notes.md'],
    }, toolContext(projectDir), allow);

    const filePath = path.join(configDir, 'memory', (await draftFiles())[0]);
    const edited = (await fs.readFile(filePath, 'utf8')).replace('status: candidate', 'status: active');
    await fs.writeFile(filePath, edited);

    const second = await handler.execute({
      topic: 'conventions',
      summary: 'Overwrite attempt',
      content: 'Must not replace the confirmed note.',
      sources: ['notes.md'],
    }, toolContext(projectDir), allow);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.output).toContain('exists, not overwritten');
    expect(second.output).toContain('status: active');
    expect(second.output).toContain('Write amounts in plain sentences.');
    const after = await fs.readFile(filePath, 'utf8');
    expect(after).toContain('status: active');
    expect(after).toContain('Write amounts in plain sentences.');
    expect(after).not.toContain('Must not replace the confirmed note.');
  });

  it('rejects a source outside the working folder and writes nothing', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-memory-out-'));
    try {
      await write(path.join(outsideDir, 'secret.md'), 'outside\n');
      await fs.symlink(path.join(outsideDir, 'secret.md'), path.join(projectDir, 'linked.md'));
      const handler = await proposeProjectMemoryModule.createHandler();

      const escaped = await handler.execute({
        topic: 'purpose',
        summary: 'Should not save',
        content: 'Leaked from outside the folder.',
        sources: ['../secret.md'],
      }, toolContext(projectDir), allow);
      expect(escaped.ok).toBe(false);
      if (!escaped.ok) expect(escaped.error).toContain('outside the working folder');

      const absolute = await handler.execute({
        topic: 'purpose',
        summary: 'Should not save',
        content: 'Leaked from an absolute path.',
        sources: [path.join(outsideDir, 'secret.md')],
      }, toolContext(projectDir), allow);
      expect(absolute.ok).toBe(false);

      const linked = await handler.execute({
        topic: 'purpose',
        summary: 'Should not save',
        content: 'Leaked through a symlink.',
        sources: ['linked.md'],
      }, toolContext(projectDir), allow);
      expect(linked.ok).toBe(false);

      await expect(fs.readdir(path.join(configDir, 'memory'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(mockDb.current!.records).toHaveLength(0);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects empty content', async () => {
    const handler = await proposeProjectMemoryModule.createHandler();
    const result = await handler.execute({
      topic: 'purpose',
      summary: 'Empty body',
      content: '   \n',
      sources: ['notes.md'],
    }, toolContext(projectDir), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('content is required');
    await expect(fs.readdir(path.join(configDir, 'memory'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
