import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';

const mocks = vi.hoisted(() => ({
  configDir: '',
  memoryTask: vi.fn(),
}));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mocks.configDir,
}));

vi.mock('../../../src/host/model/quickModel', () => ({
  memoryTask: mocks.memoryTask,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { MEMORY_CONSOLIDATION } from '../../../src/shared/constants/memory';
import { consolidateLightMemory } from '../../../src/host/lightMemory/consolidation';
import { readMemoryFile } from '../../../src/host/lightMemory/lightMemoryIpc';

class FakeMemoryDb {
  records: MemoryRecord[] = [];

  listMemories(): MemoryRecord[] {
    return this.records;
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

function memoryFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ntype: project\nstatus: active\n---\n\n${body}\n`;
}

describe('Light Memory consolidation live contract', () => {
  let root: string;
  let memoryDir: string;
  let instructionsPath: string;
  let instructions: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-consolidation-'));
    mocks.configDir = path.join(root, 'data');
    memoryDir = path.join(mocks.configDir, 'memory');
    instructionsPath = path.join(root, 'AGENTS.md');
    instructions = '# Rules\n\n- Never push code automatically.\n';
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(instructionsPath, instructions, 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'alpha.md'), memoryFile(
      'Shared release notes',
      'Release facts',
      'Alpha original fact: release requires tests.',
    ), 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'beta.md'), memoryFile(
      'Shared release notes',
      'Release facts',
      'Beta original fact: release requires approval.',
    ), 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'conflict.md'), memoryFile(
      'Old automation rule',
      'Unsafe old rule',
      'Always push code automatically after edits.',
    ), 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'INDEX.md'), [
      '# Memory Index',
      '',
      'Owner prose must survive consolidation.',
      '',
      '- [alpha.md](alpha.md) — Release facts',
      '- [beta.md](beta.md) — Release facts',
      '- [conflict.md](conflict.md) — Unsafe old rule',
      '',
    ].join('\n'), 'utf-8');

    mocks.memoryTask.mockReset();
    mocks.memoryTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        actions: [{
          kind: 'merge',
          sources: ['alpha.md', 'beta.md'],
          result: {
            filename: 'release-governance',
            name: 'Release governance',
            description: 'Merged release facts',
            type: 'project',
            content: 'Alpha original fact: release requires tests. Beta original fact: release requires approval.',
          },
          reason: 'The two cards cover the same release topic.',
        }],
        conflicts: [{
          source: 'conflict.md',
          status: 'archived',
          reason: 'AGENTS.md says code must never be pushed automatically.',
        }],
      }),
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps dry-run strictly read-only', async () => {
    const beforeIndex = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    const beforeAlpha = await fs.readFile(path.join(memoryDir, 'alpha.md'), 'utf-8');

    const report = await consolidateLightMemory({
      dryRun: true,
      force: true,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });

    expect(report.dryRun).toBe(true);
    expect(report.applied).toBe(false);
    expect(report.actions).toHaveLength(1);
    expect(report.conflicts).toHaveLength(1);
    expect(mocks.memoryTask.mock.calls[0][0]).toContain('Never push code automatically.');
    expect(await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8')).toBe(beforeIndex);
    expect(await fs.readFile(path.join(memoryDir, 'alpha.md'), 'utf-8')).toBe(beforeAlpha);
    await expect(fs.stat(path.join(memoryDir, 'release-governance.md'))).rejects.toThrow();
    await expect(fs.stat(path.join(memoryDir, MEMORY_CONSOLIDATION.AUDIT_FILENAME))).rejects.toThrow();
    expect(await fs.readFile(instructionsPath, 'utf-8')).toBe(instructions);
  });

  it('creates a new card, soft-archives originals in both ledgers, and audits instruction reconciliation', async () => {
    const db = new FakeMemoryDb();

    const report = await consolidateLightMemory({
      dryRun: false,
      force: true,
      db,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });

    expect(report.applied).toBe(true);
    expect(await fs.readFile(instructionsPath, 'utf-8')).toBe(instructions);
    const result = await readMemoryFile('release-governance.md');
    const alpha = await readMemoryFile('alpha.md');
    const beta = await readMemoryFile('beta.md');
    const conflict = await readMemoryFile('conflict.md');
    expect(result?.status).toBe('active');
    expect(result?.entryId).toMatch(/^mem_entry_consolidated_/);
    expect(alpha).toMatchObject({ status: 'archived', deprecatedBy: result?.entryId });
    expect(beta).toMatchObject({ status: 'archived', deprecatedBy: result?.entryId });
    expect(alpha?.content).toContain('Alpha original fact: release requires tests.');
    expect(beta?.content).toContain('Beta original fact: release requires approval.');
    expect(conflict?.status).toBe('archived');
    expect(conflict?.content).toContain('Always push code automatically after edits.');
    expect(conflict?.content).toContain('contradicts 指令层——verify');

    const index = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    expect(index).toContain('Owner prose must survive consolidation.');
    expect(index).toContain('release-governance.md');
    expect(index).not.toContain('alpha.md');
    expect(index).not.toContain('beta.md');
    expect(index).not.toContain('conflict.md');

    const byEntryId = new Map(db.records.map((record) => [
      (record.metadata.memoryEntry as { id: string }).id,
      record,
    ]));
    expect(byEntryId.get('light:alpha.md')).toMatchObject({
      status: 'archived',
      deprecatedBy: result?.entryId,
      content: 'Alpha original fact: release requires tests.',
    });
    expect(byEntryId.get('light:beta.md')).toMatchObject({ status: 'archived', deprecatedBy: result?.entryId });
    expect(byEntryId.get('light:conflict.md')).toMatchObject({ status: 'archived' });
    expect(byEntryId.get(result!.entryId!)).toMatchObject({ status: 'active' });

    const auditLines = (await fs.readFile(
      path.join(memoryDir, MEMORY_CONSOLIDATION.AUDIT_FILENAME),
      'utf-8',
    )).trim().split('\n');
    expect(auditLines).toHaveLength(1);
    const audit = JSON.parse(auditLines[0]) as Record<string, unknown>;
    expect(audit).toMatchObject({
      outcome: 'applied',
      instructionLayerUnchanged: true,
    });
    expect(JSON.stringify(audit)).toContain('alpha.md');
    expect(JSON.stringify(audit)).toContain('release-governance.md');
    expect(JSON.stringify(audit)).toContain('conflict.md');
  });

  it('writes a replayable no-op audit row for every live run', async () => {
    mocks.memoryTask.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({ actions: [], conflicts: [] }),
    });

    const report = await consolidateLightMemory({
      dryRun: false,
      force: true,
      db: new FakeMemoryDb(),
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });

    expect(report.applied).toBe(false);
    expect(report.auditId).toMatch(/^mem_consolidation_/);
    const audit = JSON.parse((await fs.readFile(
      path.join(memoryDir, MEMORY_CONSOLIDATION.AUDIT_FILENAME),
      'utf-8',
    )).trim()) as Record<string, unknown>;
    expect(audit).toMatchObject({ outcome: 'no-op', merges: [], conflicts: [] });
  });
});
