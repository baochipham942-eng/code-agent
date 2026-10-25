// ============================================================================
// detectExternalImportSources 单测（N-EXTHISTORY-IMPORT-K1A）
// ============================================================================
//
// 覆盖验收①的前半：检测按 home 目录存在性给出来源与三类别计数；记忆/指令计数
// 复用 harness dry-run（mock 掉 DB 侧）；无来源时 anyDetected=false（页面与
// 记忆页链接都不出现）；adapter 显式选中仍抛错 → 来源剔除并记录原因。

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dryRunMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/memory/importers', () => ({
  dryRunMemoryHarnessImport: dryRunMock,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { detectExternalImportSources } from '../../../src/host/externalImport/detectSources';

async function writeSkill(dir: string, name: string): Promise<void> {
  await fs.mkdir(path.join(dir, name), { recursive: true });
  await fs.writeFile(
    path.join(dir, name, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${name} description`, '---', '', 'Use it.', ''].join('\n'),
    'utf-8',
  );
}

let tmpRoot: string;
let homeDir: string;
let dataDir: string;

beforeEach(async () => {
  dryRunMock.mockReset();
  dryRunMock.mockResolvedValue({
    summary: { discoveredMemory: 0, readyToImport: 0, duplicates: 0, instructionOnly: 0, archived: 0 },
  });
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'external-import-detect-'));
  homeDir = path.join(tmpRoot, 'home');
  dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  vi.stubEnv('CODE_AGENT_HOME', homeDir);
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('detectExternalImportSources', () => {
  it('无任何来源目录 → sources 全未检测、anyDetected=false', async () => {
    const result = await detectExternalImportSources({} as never);
    expect(result.anyDetected).toBe(false);
    expect(result.sources.every((source) => source.detected === false)).toBe(true);
    expect(dryRunMock).not.toHaveBeenCalled();
  });

  it('codex 来源：记忆/指令计数来自 harness dry-run，技能数只数含 SKILL.md 的目录', async () => {
    await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true });
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'codex-skill');
    // 无 SKILL.md 的目录不算技能
    await fs.mkdir(path.join(homeDir, '.codex', 'skills', 'not-a-skill'), { recursive: true });
    dryRunMock.mockResolvedValue({
      summary: { discoveredMemory: 3, readyToImport: 3, duplicates: 0, instructionOnly: 1, archived: 0 },
    });

    const result = await detectExternalImportSources({} as never);
    const codex = result.sources.find((source) => source.sourceId === 'codex');

    expect(codex?.detected).toBe(true);
    expect(codex?.adapterId).toBe('codex-local-custom');
    expect(codex?.categories).toEqual([
      { category: 'instructions', count: 1 },
      { category: 'memories', count: 3 },
      { category: 'skills', count: 1 },
    ]);
    expect(result.anyDetected).toBe(true);
    // 计数走的是既有 dry-run 管线（零写入），单来源单次调用
    expect(dryRunMock).toHaveBeenCalledTimes(1);
    expect(dryRunMock).toHaveBeenCalledWith(expect.anything(), {
      adapterIds: ['codex-local-custom'],
      homeDir,
    });
  });

  it('cursor 只有技能类别（无记忆 adapter）；claude 技能类别标只读', async () => {
    await fs.mkdir(path.join(homeDir, '.cursor'), { recursive: true });
    await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true });
    await writeSkill(path.join(homeDir, '.cursor', 'skills'), 'cursor-skill');
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'claude-skill');
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'claude-skill-2');

    const result = await detectExternalImportSources({} as never);
    const cursor = result.sources.find((source) => source.sourceId === 'cursor');
    const claude = result.sources.find((source) => source.sourceId === 'claude-code');

    expect(cursor?.detected).toBe(true);
    expect(cursor?.adapterId).toBeUndefined();
    expect(cursor?.categories).toEqual([{ category: 'skills', count: 1 }]);

    expect(claude?.categories.find((c) => c.category === 'skills')).toEqual({
      category: 'skills',
      count: 2,
      readOnly: true,
    });
    // claude 的记忆计数仍走 dry-run
    expect(dryRunMock).toHaveBeenCalledWith(expect.anything(), {
      adapterIds: ['claude-code'],
      homeDir,
    });
    expect(result.claudeLegacySkills.count).toBe(2);
    expect(result.claudeLegacySkills.enabled).toBe(true);
  });

  it('adapter 显式选中仍抛错 → 来源剔除并记录原因，不让整页检测崩掉', async () => {
    await fs.mkdir(path.join(homeDir, '.gemini'), { recursive: true });
    dryRunMock.mockRejectedValue(new Error('phase p1 adapter unavailable'));

    const result = await detectExternalImportSources({} as never);
    const gemini = result.sources.find((source) => source.sourceId === 'gemini-cli');

    expect(gemini?.detected).toBe(false);
    expect(gemini?.excludedReason).toContain('adapter-unavailable');
    expect(gemini?.excludedReason).toContain('phase p1 adapter unavailable');
    expect(result.sources.find((source) => source.sourceId === 'claude-code')?.detected).toBe(false);
  });
});
