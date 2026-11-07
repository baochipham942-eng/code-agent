// ============================================================================
// skillsImport 单测（N-EXTHISTORY-IMPORT-K1A）—— 拍板 A 的技能半边
// ============================================================================
//
// 覆盖验收④⑤⑦的落点：Codex/Cursor 技能复制进 Neo 用户技能目录；目标同名一律
// 跳过、绝不覆盖；再导一次零新增。toggle 动作写持久化偏好并要求发现服务重扫。

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const discoveryMocks = vi.hoisted(() => ({
  refreshClaudeLegacySkillsInclusion: vi.fn(),
  throwOnGet: false,
}));

vi.mock('../../../src/host/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => {
    if (discoveryMocks.throwOnGet) throw new Error('discovery unavailable');
    return {
      refreshClaudeLegacySkillsInclusion: discoveryMocks.refreshClaudeLegacySkillsInclusion,
    };
  },
}));

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: loggerMocks.warn, error: vi.fn(), debug: vi.fn() }),
}));

import {
  applyExternalSkillsImport,
  previewExternalSkillsImport,
  setClaudeLegacySkillsEnabled,
} from '../../../src/host/externalImport/skillsImport';

async function writeSkill(dir: string, name: string, body = 'Use it.'): Promise<string> {
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${name} description`, '---', '', body, ''].join('\n'),
    'utf-8',
  );
  return skillDir;
}

let tmpRoot: string;
let homeDir: string;
let dataDir: string;
let userSkillsDir: string;

beforeEach(async () => {
  discoveryMocks.refreshClaudeLegacySkillsInclusion.mockReset();
  discoveryMocks.throwOnGet = false;
  loggerMocks.warn.mockReset();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'external-skills-import-'));
  homeDir = path.join(tmpRoot, 'home');
  dataDir = path.join(tmpRoot, 'data');
  userSkillsDir = path.join(dataDir, 'skills');
  await fs.mkdir(path.join(homeDir, '.codex', 'skills'), { recursive: true });
  await fs.mkdir(path.join(homeDir, '.cursor', 'skills'), { recursive: true });
  vi.stubEnv('CODE_AGENT_HOME', homeDir);
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('previewExternalSkillsImport', () => {
  it('列出 codex/cursor 技能：新技能 copy、目标同名 skip（预览零写入）', async () => {
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'codex-one');
    await writeSkill(path.join(homeDir, '.cursor', 'skills'), 'cursor-one');
    // Neo 里已有同名 → skip
    await writeSkill(userSkillsDir, 'cursor-one', 'existing neo copy');

    const preview = await previewExternalSkillsImport({});

    expect(preview.summary).toEqual({ copy: 1, skip: 1 });
    expect(preview.items).toEqual([
      {
        sourceId: 'codex',
        name: 'codex-one',
        sourcePath: path.join(homeDir, '.codex', 'skills', 'codex-one'),
        disposition: 'copy',
        reason: 'new-skill',
      },
      {
        sourceId: 'cursor',
        name: 'cursor-one',
        sourcePath: path.join(homeDir, '.cursor', 'skills', 'cursor-one'),
        disposition: 'skip',
        reason: 'target-name-exists',
      },
    ]);
    // 预览不落盘
    await expect(fs.stat(path.join(userSkillsDir, 'codex-one'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('无 SKILL.md 的目录不算可复制技能', async () => {
    await fs.mkdir(path.join(homeDir, '.codex', 'skills', 'junk'), { recursive: true });
    const preview = await previewExternalSkillsImport({});
    expect(preview.items).toEqual([]);
  });
});

describe('applyExternalSkillsImport no-overwrite invariant', () => {
  it('复制新技能并保持 SKILL.md 内容；目标已存在的一律跳过、原内容不动', async () => {
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'codex-skill', 'codex body marker');
    await writeSkill(path.join(homeDir, '.cursor', 'skills'), 'clash', 'cursor body');
    // Neo 里已有同名 clash：必须保持 Neo 侧原内容（绝不覆盖）
    await writeSkill(userSkillsDir, 'clash', 'neo body must survive');

    const result = await applyExternalSkillsImport({});

    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.items).toEqual([
      { sourceId: 'codex', name: 'codex-skill', action: 'copied', digest: expect.any(String) },
      { sourceId: 'cursor', name: 'clash', action: 'skipped', reason: 'target-name-exists' },
    ]);
    const copied = await fs.readFile(path.join(userSkillsDir, 'codex-skill', 'SKILL.md'), 'utf-8');
    expect(copied).toContain('codex body marker');
    const survivor = await fs.readFile(path.join(userSkillsDir, 'clash', 'SKILL.md'), 'utf-8');
    expect(survivor).toContain('neo body must survive');
  });

  it('apply 末尾按来源记录导入历史，只保存名称与 copied/skipped', async () => {
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'codex-skill');
    await writeSkill(path.join(homeDir, '.cursor', 'skills'), 'cursor-skill');
    await writeSkill(userSkillsDir, 'cursor-skill', 'existing neo copy');

    await applyExternalSkillsImport({});

    const raw = await fs.readFile(path.join(dataDir, 'external-import-history.json'), 'utf8');
    const ledger = JSON.parse(raw) as {
      entries: Array<{ category: string; source: string; count: number; items: unknown[] }>;
    };
    expect(ledger.entries).toMatchObject([
      { category: 'skills', source: 'codex', count: 1, items: [{ label: 'codex-skill', outcome: 'copied' }] },
      { category: 'skills', source: 'cursor', count: 0, items: [{ label: 'cursor-skill', outcome: 'skipped' }] },
    ]);
    expect(raw).not.toContain(homeDir);
    expect(raw).not.toContain('target-name-exists');
  });

  it('再导一次：全部 target-name-exists，copied=0（导入幂等，零新增）', async () => {
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'codex-skill');

    const first = await applyExternalSkillsImport({});
    expect(first.copied).toBe(1);

    const second = await applyExternalSkillsImport({});
    expect(second.copied).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.items[0]).toMatchObject({
      name: 'codex-skill',
      action: 'skipped',
      reason: 'target-name-exists',
    });
  });

  it('复制成功后触发发现服务重扫（Skills hub 免重启可见）', async () => {
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'codex-skill');

    const result = await applyExternalSkillsImport({});

    expect(result.copied).toBe(1);
    expect(discoveryMocks.refreshClaudeLegacySkillsInclusion).toHaveBeenCalledTimes(1);
  });

  it('零复制（全跳过）不触发重扫', async () => {
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'codex-skill');
    await writeSkill(userSkillsDir, 'codex-skill');

    const result = await applyExternalSkillsImport({});

    expect(result.copied).toBe(0);
    expect(discoveryMocks.refreshClaudeLegacySkillsInclusion).not.toHaveBeenCalled();
  });

  it('copy-failed：结果保留原始 error 字段，logger.warn 带技能名与来源', async () => {
    const sourceDir = path.join(homeDir, '.codex', 'skills');
    await writeSkill(sourceDir, 'locked-skill');
    // 目录收走读权限：hasSkillMd（access）仍过、fs.cp（readdir）EACCES——真失败注入
    await fs.chmod(path.join(sourceDir, 'locked-skill'), 0o111);
    try {
      const result = await applyExternalSkillsImport({});

      expect(result.copied).toBe(0);
      expect(result.items[0]).toMatchObject({
        sourceId: 'codex',
        name: 'locked-skill',
        action: 'skipped',
        reason: 'copy-failed',
      });
      expect(result.items[0].error).toMatch(/EACCES/);
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        expect.stringContaining('copy failed'),
        expect.objectContaining({ sourceId: 'codex', name: 'locked-skill', error: expect.stringContaining('EACCES') }),
      );
      // 复制零成功 → 不重扫
      expect(discoveryMocks.refreshClaudeLegacySkillsInclusion).not.toHaveBeenCalled();
    } finally {
      // afterEach 的 rm -rf 需要读权限回来
      await fs.chmod(path.join(sourceDir, 'locked-skill'), 0o755);
    }
  });

  it('重扫失败只 warn 不抛（fail-open，导入结果照常返回）', async () => {
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'codex-skill');
    discoveryMocks.throwOnGet = true;

    const result = await applyExternalSkillsImport({});

    expect(result.copied).toBe(1);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('rescan failed'),
      expect.objectContaining({ error: 'discovery unavailable' }),
    );
  });
});

describe('setClaudeLegacySkillsEnabled', () => {
  it('写持久化偏好、触发发现服务重扫、回读生效值', async () => {
    const result = await setClaudeLegacySkillsEnabled(false);
    expect(result.enabled).toBe(false);
    expect(discoveryMocks.refreshClaudeLegacySkillsInclusion).toHaveBeenCalledTimes(1);

    const prefFile = path.join(dataDir, 'external-import.json');
    const raw = JSON.parse(await fs.readFile(prefFile, 'utf-8')) as { includeClaudeLegacySkills?: boolean };
    expect(raw.includeClaudeLegacySkills).toBe(false);

    const backOn = await setClaudeLegacySkillsEnabled(true);
    expect(backOn.enabled).toBe(true);
    expect(discoveryMocks.refreshClaudeLegacySkillsInclusion).toHaveBeenCalledTimes(2);
  });
});
