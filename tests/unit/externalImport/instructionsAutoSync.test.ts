import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';

const bridge = vi.hoisted(() => ({ database: null as unknown }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => bridge.database,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  confirmInstructionsSyncItem,
  getInstructionsSyncState,
  runInstructionsAutoSync,
  setInstructionsSyncMode,
} from '../../../src/host/externalImport/instructionsAutoSync';
import { listImportHistory } from '../../../src/host/externalImport/importHistory';
import {
  readInstructionsSyncStored,
  writeInstructionsSyncStored,
} from '../../../src/host/externalImport/instructionsSyncPreference';
import { undoImportHistoryEntry } from '../../../src/host/externalImport/undoImport';
import { readMemoryFile, writeLightMemoryFile } from '../../../src/host/lightMemory/lightMemoryIpc';
import { confirmMemoryHarnessDirective, dryRunMemoryHarnessImport } from '../../../src/host/memory/importers';

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

let root: string;
let homeDir: string;
let dataDir: string;
let agentsFile: string;
let db: MemoryDb;

async function writeRules(...rules: string[]): Promise<void> {
  await fs.mkdir(path.dirname(agentsFile), { recursive: true });
  await fs.writeFile(agentsFile, `# Rules\n\n${rules.map((rule) => `- ${rule}`).join('\n')}\n`, 'utf8');
}

async function manuallyImportRule(content: string): Promise<void> {
  const preview = await dryRunMemoryHarnessImport(db, {
    homeDir,
    adapterIds: ['codex-local-custom'],
  });
  const target = preview.instructions.find((item) => item.content === content);
  expect(target).toBeDefined();
  await confirmMemoryHarnessDirective(db, target!.id, {
    homeDir,
    adapterIds: ['codex-local-custom'],
    confirmDirective: async () => ({ confirmed: true }),
  });
}

async function memoryMarkdownFiles(): Promise<string[]> {
  return fs.readdir(path.join(dataDir, 'memory')).then(
    (files) => files.filter((file) => file.endsWith('.md') && file !== 'INDEX.md'),
    () => [],
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'instructions-auto-sync-'));
  homeDir = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  agentsFile = path.join(homeDir, '.codex', 'AGENTS.md');
  db = new MemoryDb();
  bridge.database = db;
  vi.stubEnv('CODE_AGENT_HOME', homeDir);
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('instructionsAutoSync', () => {
  it('① defaults off: a fresh data directory writes no memory, preference, or history', async () => {
    await writeRules('fresh source rule');
    await runInstructionsAutoSync({ db, homeDir });

    expect(await getInstructionsSyncState({ db, homeDir })).toEqual({
      mode: 'off',
      available: false,
      pending: [],
    });
    expect(await memoryMarkdownFiles()).toEqual([]);
    expect(await listImportHistory()).toEqual([]);
    await expect(fs.stat(path.join(dataDir, 'external-instructions-sync.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('② reports a new rule without writing until the existing per-item confirmation gate confirms it', async () => {
    await writeRules('manual bootstrap');
    await manuallyImportRule('manual bootstrap');
    await writeRules('manual bootstrap', 'SYNC_GATE_CODEWORD');
    const filesBefore = await memoryMarkdownFiles();

    const enabled = await setInstructionsSyncMode('on', { db, homeDir, now: () => 10 });
    expect(enabled.available).toBe(true);
    expect(enabled.pending.map((item) => item.content)).toEqual(['SYNC_GATE_CODEWORD']);
    expect(await memoryMarkdownFiles()).toEqual(filesBefore);
    expect(await listImportHistory()).toEqual([]);

    const confirmer = vi.fn(async () => ({ confirmed: true }));
    const confirmed = await confirmInstructionsSyncItem(enabled.pending[0]!.instructionId, {
      db,
      homeDir,
      now: () => 20,
      confirmDirective: confirmer,
    });
    expect(confirmer).toHaveBeenCalledWith({ content: 'SYNC_GATE_CODEWORD', category: 'import' });
    expect(confirmed.confirmation).toMatchObject({ confirmed: true, imported: true });
    expect(await memoryMarkdownFiles()).toHaveLength(filesBefore.length + 1);
    expect(readInstructionsSyncStored().handled).toContain(enabled.pending[0]!.contentHash);
    expect(await listImportHistory()).toMatchObject([{
      trigger: 'confirm',
      category: 'instructions',
      source: 'codex',
      count: 1,
      items: [{
        label: 'SYNC_GATE_CODEWORD',
        outcome: 'imported',
        memoryFilename: expect.any(String),
        contentHash: enabled.pending[0]!.contentHash,
      }],
    }]);
  });

  it('③ conflict protection keeps an edited Neo rule, marks it handled once, and never proposes it', async () => {
    await writeRules('keep neo version');
    await manuallyImportRule('keep neo version');
    const [filename] = await memoryMarkdownFiles();
    const current = await readMemoryFile(filename!);
    expect(current).not.toBeNull();
    await writeLightMemoryFile({
      ...current!,
      content: 'Neo edited content',
      directiveConfirmedByUser: true,
    });

    const enabled = await setInstructionsSyncMode('on', { db, homeDir, now: () => 30 });
    expect(enabled.pending).toEqual([]);
    expect(enabled.lastRun).toMatchObject({ pending: 0, keptNeo: 1 });
    expect((await readMemoryFile(filename!))?.content).toBe('Neo edited content');
    expect(readInstructionsSyncStored().handled).toHaveLength(1);

    await runInstructionsAutoSync({ db, homeDir, now: () => 40 });
    expect((await getInstructionsSyncState({ db, homeDir })).lastRun)
      .toMatchObject({ pending: 0, keptNeo: 0 });
  });

  it('④ confirmed history is undoable and the handled ledger prevents restart backflow', async () => {
    await writeRules('manual bootstrap');
    await manuallyImportRule('manual bootstrap');
    await writeRules('manual bootstrap', 'undo me once');
    const enabled = await setInstructionsSyncMode('on', { db, homeDir });
    const item = enabled.pending[0]!;
    await confirmInstructionsSyncItem(item.instructionId, {
      db,
      homeDir,
      confirmDirective: async () => ({ confirmed: true }),
    });
    const [history] = await listImportHistory();

    const undone = await undoImportHistoryEntry(history.id);
    expect(undone.undone).toMatchObject({ removed: 1, kept: [] });
    const importedFile = await readMemoryFile(history.items[0]!.memoryFilename!);
    expect(importedFile?.status).toBe('archived');

    await runInstructionsAutoSync({ db, homeDir });
    expect((await getInstructionsSyncState({ db, homeDir })).pending).toEqual([]);
    expect(readInstructionsSyncStored().handled).toContain(item.contentHash);
  });

  it('undo keeps a confirmed instruction when its Neo content was edited', async () => {
    await writeRules('manual bootstrap');
    await manuallyImportRule('manual bootstrap');
    await writeRules('manual bootstrap', 'edit before undo');
    const enabled = await setInstructionsSyncMode('on', { db, homeDir });
    await confirmInstructionsSyncItem(enabled.pending[0]!.instructionId, {
      db,
      homeDir,
      confirmDirective: async () => ({ confirmed: true }),
    });
    const [history] = await listImportHistory();
    const filename = history.items[0]!.memoryFilename!;
    const current = await readMemoryFile(filename);
    await writeLightMemoryFile({
      ...current!,
      content: 'user changed this in Neo',
      directiveConfirmedByUser: true,
    });

    const undone = await undoImportHistoryEntry(history.id);
    expect(undone.undone).toMatchObject({
      removed: 0,
      kept: [{ label: 'edit before undo', reason: 'edited' }],
    });
    expect((await readMemoryFile(filename))?.status).toBe('active');
  });

  it('decline and timeout are handled once, while headless-no-ui remains pending for an attached renderer', async () => {
    await writeRules('manual bootstrap');
    await manuallyImportRule('manual bootstrap');
    await writeRules('manual bootstrap', 'decline me', 'retry in app');
    const enabled = await setInstructionsSyncMode('on', { db, homeDir });
    const decline = enabled.pending.find((item) => item.content === 'decline me')!;
    const retry = enabled.pending.find((item) => item.content === 'retry in app')!;

    await confirmInstructionsSyncItem(decline.instructionId, {
      db,
      homeDir,
      confirmDirective: async () => ({ confirmed: false, timedOut: true }),
    });
    await confirmInstructionsSyncItem(retry.instructionId, {
      db,
      homeDir,
      confirmDirective: async () => ({ confirmed: false, headlessNoUi: true }),
    });

    const state = await getInstructionsSyncState({ db, homeDir });
    expect(state.pending.map((item) => item.content)).toEqual(['retry in app']);
    expect(readInstructionsSyncStored().handled).toContain(decline.contentHash);
    expect(readInstructionsSyncStored().handled).not.toContain(retry.contentHash);
  });

  it('unavailable state cannot be enabled even if a caller bypasses the disabled UI', async () => {
    await writeRules('not manually imported');
    writeInstructionsSyncStored({ mode: 'off', handled: [] });
    const state = await setInstructionsSyncMode('on', { db, homeDir });
    expect(state).toMatchObject({ mode: 'off', available: false, pending: [] });
    expect(readInstructionsSyncStored().mode).toBe('off');
  });
});
