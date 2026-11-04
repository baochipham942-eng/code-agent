// ============================================================================
// 用户级说明文件单条规则导入（N-EXTHISTORY-IMPORT-K1A-FU1 验收②）
// ============================================================================
//
// 真形夹具（临时 home 里的 .codex/AGENTS.md 与 .claude/CLAUDE.md）验证：
//   - dry-run 把规则列为 directive-confirmation-required（带 segmentOf/segmentIndex），
//     且不再发整文件 compare-only 项；
//   - 确认一条只写一条 active 指令（注入的 confirmer 走既有确认门），
//     再跑 dry-run 该条报 directive-already-imported；
//   - 拒绝确认时零写入；
//   - 项目级文件（gemini 项目目录 GEMINI.md）不产规则候选，仍整文件只供对照。

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
  confirmMemoryHarnessDirective,
  dryRunMemoryHarnessImport,
} from '../../../src/host/memory/importers';
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

const CODEX_AGENTS = `---
name: codex rules
---

# 工作规矩

- 每条回复结尾都带一行 —— 已收到
- 不要自动推送分支
先跑门再下结论。结论要附路径与行号。
`;

const CLAUDE_MD = `# Claude 家规

- 回复一律用中文
`;

describe('instruction rule import（用户级说明文件拆条）', () => {
  let homeDir: string;
  let configDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'instruction-rules-home-'));
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'instruction-rules-neo-'));
    mockConfigDir.dir = configDir;
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('dry-run：规则逐条列为 directive-confirmation-required，不再发整文件 compare-only 项', async () => {
    await write(path.join(homeDir, '.codex/AGENTS.md'), CODEX_AGENTS);
    await write(path.join(homeDir, '.claude/CLAUDE.md'), CLAUDE_MD);

    const result = await dryRunMemoryHarnessImport(new MemoryDb(), {
      homeDir,
      adapterIds: ['codex-local-custom', 'claude-code'],
    });

    expect(result.candidates).toEqual([]);
    const codexRules = result.instructions.filter((item) => item.sourcePath.endsWith('AGENTS.md'));
    expect(codexRules.map((item) => item.content)).toEqual([
      '每条回复结尾都带一行 —— 已收到',
      '不要自动推送分支',
      '先跑门再下结论。',
      '结论要附路径与行号。',
    ]);
    for (const item of codexRules) {
      expect(item.reason).toBe('directive-confirmation-required');
      expect(item.sourceMetadata).toMatchObject({ segmentCount: 4 });
      expect(typeof item.sourceMetadata.segmentIndex).toBe('number');
      expect(typeof item.sourceMetadata.segmentOf).toBe('string');
    }
    // 同一文件拆出的条目共享 segmentOf，segmentIndex 从 0 连续递增
    const segmentOf = codexRules[0]?.sourceMetadata.segmentOf;
    expect(codexRules.map((item) => item.sourceMetadata.segmentIndex)).toEqual([0, 1, 2, 3]);
    expect(codexRules.every((item) => item.sourceMetadata.segmentOf === segmentOf)).toBe(true);

    const claudeRules = result.instructions.filter((item) => item.sourcePath.endsWith('CLAUDE.md'));
    expect(claudeRules.map((item) => item.content)).toEqual(['回复一律用中文']);

    // 拆得出规则时，整文件 compare-only 项一个都不发
    expect(result.instructions.some((item) => item.reason === 'instruction-file')).toBe(false);
  });

  it('拆不出规则的用户级文件回落整文件对照项（segmentCount 0）', async () => {
    await write(path.join(homeDir, '.codex/AGENTS.md'), '# 只有标题\n\n```\ncode only\n```\n');

    const result = await dryRunMemoryHarnessImport(new MemoryDb(), {
      homeDir,
      adapterIds: ['codex-local-custom'],
    });

    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0]).toMatchObject({
      reason: 'instruction-file',
      title: 'AGENTS.md',
      sourceMetadata: { segmentCount: 0 },
    });
  });

  it('确认一条只写一条 active 指令；再跑 dry-run 该条报 directive-already-imported', async () => {
    await write(path.join(homeDir, '.codex/AGENTS.md'), CODEX_AGENTS);
    const db = new MemoryDb();
    const confirmer = vi.fn(async () => ({ confirmed: true }));

    const preview = await dryRunMemoryHarnessImport(db, { homeDir, adapterIds: ['codex-local-custom'] });
    expect(preview.instructions).toHaveLength(4);

    const target = preview.instructions.find(
      (item) => item.content === '每条回复结尾都带一行 —— 已收到',
    )!;
    const confirmed = await confirmMemoryHarnessDirective(db, target.id, {
      homeDir,
      adapterIds: ['codex-local-custom'],
      confirmDirective: confirmer,
    });

    expect(confirmer).toHaveBeenCalledTimes(1);
    expect(confirmer).toHaveBeenCalledWith({ content: '每条回复结尾都带一行 —— 已收到', category: 'import' });
    expect(confirmed).toMatchObject({
      instructionId: target.id,
      confirmed: true,
      imported: true,
      entry: {
        kind: 'directive',
        status: 'active',
        scope: 'global',
        content: '每条回复结尾都带一行 —— 已收到',
      },
    });
    // 只写一条：DB 镜像 + light 文件各一，其余三条规则不动
    expect(db.records).toHaveLength(1);
    const files = await fs.readdir(path.join(configDir, 'memory'));
    expect(files.filter((file) => file.startsWith('import-'))).toHaveLength(1);
    expect((await listUnifiedMemoryEntries(db)).entries).toHaveLength(1);

    const rerun = await dryRunMemoryHarnessImport(db, { homeDir, adapterIds: ['codex-local-custom'] });
    expect(rerun.instructions.map((item) => item.content)).not.toContain('每条回复结尾都带一行 —— 已收到');
    expect(rerun.skipped).toContainEqual({
      adapterId: 'codex-local-custom',
      sourcePath: path.join(homeDir, '.codex', 'AGENTS.md'),
      reason: 'directive-already-imported',
    });
    expect(rerun.instructions).toHaveLength(3);
  });

  it('拒绝确认时零写入（DB 与 light 目录都不动）', async () => {
    await write(path.join(homeDir, '.codex/AGENTS.md'), CODEX_AGENTS);
    const db = new MemoryDb();

    const preview = await dryRunMemoryHarnessImport(db, { homeDir, adapterIds: ['codex-local-custom'] });
    const target = preview.instructions[0]!;
    const declined = await confirmMemoryHarnessDirective(db, target.id, {
      homeDir,
      adapterIds: ['codex-local-custom'],
      confirmDirective: vi.fn(async () => ({ confirmed: false })),
    });

    expect(declined).toMatchObject({ instructionId: target.id, confirmed: false, imported: false });
    expect(db.records).toHaveLength(0);
    await expect(fs.readdir(path.join(configDir, 'memory'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('headless 无界面：confirm 结果带 notConfirmedReason=headless-no-ui，零写入', async () => {
    await write(path.join(homeDir, '.codex/AGENTS.md'), CODEX_AGENTS);
    const db = new MemoryDb();

    const preview = await dryRunMemoryHarnessImport(db, { homeDir, adapterIds: ['codex-local-custom'] });
    const result = await confirmMemoryHarnessDirective(db, preview.instructions[0]!.id, {
      homeDir,
      adapterIds: ['codex-local-custom'],
      confirmDirective: vi.fn(async () => ({ confirmed: false, headlessNoUi: true })),
    });

    expect(result).toMatchObject({ confirmed: false, imported: false, notConfirmedReason: 'headless-no-ui' });
    expect(db.records).toHaveLength(0);
  });

  it('项目级文件（gemini 项目目录 GEMINI.md）不产规则候选，确认门照旧拒绝整文件项', async () => {
    await write(path.join(homeDir, '.gemini/tmp/repo-one/memory/GEMINI.md'), '# 项目规则\n\n- 项目里别动构建脚本\n');
    await write(path.join(homeDir, '.gemini/GEMINI.md'), '# 全局规则\n\n- 全局回复用中文\n');
    const db = new MemoryDb();

    const result = await dryRunMemoryHarnessImport(db, { homeDir, adapterIds: ['gemini-cli'] });
    // 精确路径定位：CI（Linux）的 os.tmpdir() 是 /tmp，substring 'tmp' 会把全局文件也命中
    const projectFile = result.instructions.find(
      (item) => item.sourcePath === path.join(homeDir, '.gemini', 'tmp', 'repo-one', 'memory', 'GEMINI.md'),
    );
    const globalFile = result.instructions.find(
      (item) => item.sourcePath === path.join(homeDir, '.gemini', 'GEMINI.md'),
    );

    expect(projectFile?.reason).toBe('instruction-file');
    expect(projectFile?.sourceMetadata).toEqual({});
    expect(globalFile?.reason).toBe('directive-confirmation-required');
    expect(globalFile?.content).toBe('全局回复用中文');

    await expect(confirmMemoryHarnessDirective(db, projectFile!.id, {
      homeDir,
      adapterIds: ['gemini-cli'],
      confirmDirective: vi.fn(async () => ({ confirmed: true })),
    })).rejects.toThrow('instruction file');
  });

  it('确认写入的指令进新会话注入：packMemoryEntries 能按 directive+active 拿到该规则原文', async () => {
    await write(path.join(homeDir, '.codex/AGENTS.md'), CODEX_AGENTS);
    const db = new MemoryDb();

    const preview = await dryRunMemoryHarnessImport(db, { homeDir, adapterIds: ['codex-local-custom'] });
    const target = preview.instructions.find(
      (item) => item.content === '每条回复结尾都带一行 —— 已收到',
    )!;
    await confirmMemoryHarnessDirective(db, target.id, {
      homeDir,
      adapterIds: ['codex-local-custom'],
      confirmDirective: vi.fn(async () => ({ confirmed: true })),
    });

    const { packMemoryEntries } = await import('../../../src/host/memory/memoryEntryRuntime');
    const packed = await packMemoryEntries({
      kinds: ['directive'],
      statuses: ['active'],
      maxItems: 10,
      perItemCharLimit: 120,
      totalCharBudget: 800,
    }, db);
    expect(packed.items).toHaveLength(1);
    expect(packed.items[0]?.content).toBe('每条回复结尾都带一行 —— 已收到');
    expect(packed.block).toContain('每条回复结尾都带一行 —— 已收到');
  });
});
