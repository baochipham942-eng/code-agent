// ============================================================================
// detectExternalImportSources 真形（无 mock）单测（N-EXTHISTORY-IMPORT-K1A-FU1-FU1-FU1 验收②）
// ============================================================================
//
// 临时 home 里放真实 .claude/CLAUDE.md，走真 dry-run 管线（splitInstructionRules
// 真拆条，不 mock importers）：
//   - 拆不出规则的用户级文件 → 来源行 instructions 计数 0（旧行为取
//     summary.instructionOnly=1，页面显示「说明 1」而预览头部是 0 条规则）；
//   - 拆出 N 条 → 来源行计数 N，且与预览头部 countImportableRules
//     （renderer 同口径，经 @renderer 别名引入真实现）在同一 home 上相等。
//
// 注：tests/unit 里相对路径引 renderer 的 .tsx 在本 vitest（rolldown-vite）下
// 解析不到，@renderer 别名可用——故计数对照走别名。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';
import { countImportableRules } from '@renderer/components/features/settings/tabs/ExternalImportInstructionRules';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { detectExternalImportSources } from '../../../src/host/externalImport/detectSources';
import { dryRunMemoryHarnessImport } from '../../../src/host/memory/importers';

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

describe('detectExternalImportSources 真形：来源行说明计数只数可导入规则', () => {
  let homeDir: string;
  let dataDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-import-unmocked-home-'));
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-import-unmocked-data-'));
    await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true });
    // detectExternalImportSources 经 getHomeDir()/getUserConfigDir() 读环境变量，
    // 与 dry-run（显式传 homeDir）指到同一个临时 home / 数据目录。
    vi.stubEnv('CODE_AGENT_HOME', homeDir);
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('CLAUDE.md 拆不出规则 → 来源行 instructions 计数 0（而非 summary.instructionOnly 的 1）', async () => {
    // 夹具形状同 instructionRuleImport.test.ts 的 segmentCount 0 用例：只有标题与代码块
    await fs.writeFile(
      path.join(homeDir, '.claude', 'CLAUDE.md'),
      '# 只有标题\n\n```\ncode only\n```\n',
      'utf8',
    );

    const dryRun = await dryRunMemoryHarnessImport(new MemoryDb(), {
      homeDir,
      adapterIds: ['claude-code'],
    });
    // 夹具前提自证：整文件对照项恰好 1 条（旧行为会把这 1 显示到来源行上）
    expect(dryRun.instructions).toHaveLength(1);
    expect(dryRun.instructions[0]).toMatchObject({ reason: 'instruction-file' });
    expect(dryRun.summary.instructionOnly).toBe(1);
    expect(countImportableRules(dryRun.instructions)).toBe(0);

    const result = await detectExternalImportSources(new MemoryDb());
    const claude = result.sources.find((source) => source.sourceId === 'claude-code');
    expect(claude?.detected).toBe(true);
    expect(claude?.categories.find((c) => c.category === 'instructions')).toEqual({
      category: 'instructions',
      count: 0,
    });
  });

  it('CLAUDE.md 拆出 N 条规则 → 来源行计数 N，与 countImportableRules 同一 home 相等', async () => {
    await fs.writeFile(
      path.join(homeDir, '.claude', 'CLAUDE.md'),
      '# Claude 家规\n\n- 回复一律用中文\n- 不要自动推送分支\n先跑门再下结论。\n',
      'utf8',
    );

    const dryRun = await dryRunMemoryHarnessImport(new MemoryDb(), {
      homeDir,
      adapterIds: ['claude-code'],
    });
    const expected = countImportableRules(dryRun.instructions);
    expect(expected).toBeGreaterThan(0);
    expect(dryRun.instructions.every((item) => item.reason === 'directive-confirmation-required')).toBe(true);

    const result = await detectExternalImportSources(new MemoryDb());
    const claude = result.sources.find((source) => source.sourceId === 'claude-code');
    expect(claude?.categories.find((c) => c.category === 'instructions')).toEqual({
      category: 'instructions',
      count: expected,
    });
  });
});
