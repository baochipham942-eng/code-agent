import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const state = vi.hoisted(() => ({
  configDir: '',
  entries: new Map<string, any>(),
  skills: new Map<string, any>(),
  install: vi.fn(),
  uninstall: vi.fn(),
  ensure: vi.fn(),
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => state.configDir,
  getAgentsMdDir: () => ({ user: path.join(state.configDir, 'agents') }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/host/services/roleAssets/rolePackRegistryService', () => ({
  getRolePackRegistryService: () => ({
    getEntry: async (id: string) => state.entries.get(id) ?? null,
    fetchEntries: async () => ({ entries: [...state.entries.values()] }),
  }),
}));
vi.mock('../../../../src/host/skills/marketplace/remoteSkillRegistryService', () => ({
  getRemoteSkillRegistryService: () => ({ getEntry: async (name: string) => state.skills.get(name) ?? null }),
}));
vi.mock('../../../../src/host/skills/marketplace/installService', () => ({
  installFromRegistryEntry: (...args: unknown[]) => state.install(...args),
  uninstallPlugin: (...args: unknown[]) => state.uninstall(...args),
}));
vi.mock('../../../../src/host/services/roleAssets/roleAssetService', () => ({
  ensureRoleAssetDirs: (...args: unknown[]) => state.ensure(...args),
}));

import {
  detectRolePackElevation,
  getInstalledRolePackState,
  getRolePackFactoryDefinition,
  installRolePack,
  retryMissingSkills,
  stripRolePackElevation,
  uninstallRolePack,
} from '../../../../src/host/services/roleAssets/rolePackInstallService';
import { parseAgentMd, parseAgentMdVisual } from '../../../../src/host/agent/hybrid/agentMdLoader';

const validAgent = (id: string, skills: string[]) => `---\nname: ${id}\nskills: [${skills.join(', ')}]\n---\nrole`;
const entry = (id = '云专家', skills = ['s1', 's2', 's3']) => ({
  roleId: id, agentMd: validAgent(id, skills), packVersion: '1.0.0', publisher: 'Neo', reviewedAt: '2026-07-22',
  visual: { icon: 'Bot', category: 'research', displayName: id, profession: '专家', tags: ['a'], quickPrompts: ['go'] },
  skills: skills.map((registryName) => ({ registryName })),
});

describe('rolePackInstallService', () => {
  beforeEach(async () => {
    state.configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-pack-install-'));
    state.entries.clear(); state.skills.clear(); vi.clearAllMocks();
    state.ensure.mockResolvedValue(undefined);
    state.uninstall.mockResolvedValue({});
  });
  afterEach(async () => fs.rm(state.configDir, { recursive: true, force: true }));

  it('rolls back when zero skills install successfully', async () => {
    const pack = entry(); state.entries.set(pack.roleId, pack);
    for (const skill of pack.skills) state.skills.set(skill.registryName, { name: skill.registryName });
    state.install.mockRejectedValue(new Error('down'));
    const result = await installRolePack(pack.roleId);
    expect(result.success).toBe(false); expect(result.reason).toBeTruthy();
    await expect(fs.access(path.join(state.configDir, 'agents', `${pack.roleId}.md`))).rejects.toThrow();
    expect(state.uninstall).not.toHaveBeenCalled();
  });

  it('uninstalls skills written by this attempt when another bottom-line check fails', async () => {
    const pack = entry('坏定义', ['s1']); pack.agentMd = 'not frontmatter'; state.entries.set(pack.roleId, pack);
    state.skills.set('s1', { name: 's1' }); state.install.mockResolvedValue({ installedSkills: ['s1'] });
    const result = await installRolePack(pack.roleId);
    expect(result.success).toBe(false);
    expect(state.uninstall).toHaveBeenCalledWith(expect.stringContaining('s1@'), { scope: 'user' });
    await expect(fs.access(path.join(state.configDir, 'agents', `${pack.roleId}.md`))).rejects.toThrow();
  });

  it('installs degraded when one of three skills is unavailable', async () => {
    const pack = entry(); state.entries.set(pack.roleId, pack);
    for (const skill of pack.skills) state.skills.set(skill.registryName, { name: skill.registryName });
    state.install.mockImplementation(async (skill: { name: string }) => {
      if (skill.name === 's3') throw new Error('down');
      return { installedSkills: [skill.name] };
    });
    const result = await installRolePack(pack.roleId);
    expect(result).toMatchObject({ success: true, installState: 'degraded', missingSkills: ['s3'] });
    const saved = await fs.readFile(path.join(state.configDir, 'agents', `${pack.roleId}.md`), 'utf8');
    expect(parseAgentMdVisual(saved)).toEqual(pack.visual);
  });

  it('persists every cloud role visual field into agent frontmatter', async () => {
    const pack = entry('岚析', ['s1']);
    pack.visual = {
      icon: 'ChartNoAxesCombined', category: 'research', displayName: '岚析', profession: '增长分析师',
      tags: ['增长', 'SEO', '留存'], quickPrompts: ['分析本周增长变化', '找出留存下滑原因'],
    };
    state.entries.set(pack.roleId, pack); state.skills.set('s1', { name: 's1' });
    state.install.mockResolvedValue({ installedSkills: ['s1'] });

    await installRolePack(pack.roleId);

    const saved = await fs.readFile(path.join(state.configDir, 'agents', `${pack.roleId}.md`), 'utf8');
    expect(parseAgentMdVisual(saved)).toEqual(pack.visual);
  });

  it('仅 skill 不可解析问题时按 code 退化安装，不拒绝整包', async () => {
    const pack = entry('结构化分类', ['s1', 's2']); state.entries.set(pack.roleId, pack);
    for (const skill of pack.skills) state.skills.set(skill.registryName, { name: skill.registryName });
    state.install.mockImplementation(async (skill: { name: string }) => {
      if (skill.name === 's2') throw new Error('down');
      return { installedSkills: [skill.name] };
    });

    await expect(installRolePack(pack.roleId)).resolves.toMatchObject({
      success: true,
      installState: 'degraded',
      missingSkills: ['s2'],
    });
  });

  it('retries only missing skills and transitions to complete', async () => {
    const pack = entry(); state.entries.set(pack.roleId, pack);
    for (const skill of pack.skills) state.skills.set(skill.registryName, { name: skill.registryName, skills: [skill.registryName] });
    state.install.mockImplementation(async (skill: { name: string }) => {
      if (skill.name === 's3' && state.install.mock.calls.length <= 3) throw new Error('down');
      return { installedSkills: [skill.name] };
    });
    await installRolePack(pack.roleId);
    state.install.mockClear(); state.install.mockResolvedValue({ installedSkills: ['s3'] });
    const result = await retryMissingSkills(pack.roleId);
    expect(result).toMatchObject({ success: true, installState: 'complete', missingSkills: [] });
    expect(state.install).toHaveBeenCalledTimes(1);
  });

  it('writes missing definitions, updates owned definitions, and refuses mutated local definitions', async () => {
    const pack = entry('覆盖专家', ['s1']); state.entries.set(pack.roleId, pack); state.skills.set('s1', { name: 's1' });
    state.install.mockResolvedValue({ installedSkills: ['s1'] });
    await installRolePack(pack.roleId);
    const definitionPath = path.join(state.configDir, 'agents', `${pack.roleId}.md`);
    expect(parseAgentMdVisual(await fs.readFile(definitionPath, 'utf8'))).toEqual(pack.visual);
    pack.agentMd = validAgent(pack.roleId, ['s1']) + '\nupgraded'; pack.packVersion = '2.0.0';
    await installRolePack(pack.roleId);
    expect(parseAgentMdVisual(await fs.readFile(definitionPath, 'utf8'))).toEqual(pack.visual);
    await fs.writeFile(definitionPath, 'user edit', 'utf8');
    pack.agentMd += '\nnew';
    const result = await installRolePack(pack.roleId);
    expect(result).toMatchObject({ success: true, locallyModified: true });
    expect(await fs.readFile(definitionPath, 'utf8')).toBe('user edit');
  });

  it('never deletes role memories and preserves shared skills on uninstall', async () => {
    const first = entry('甲', ['shared']); const second = entry('乙', ['shared']);
    state.entries.set('甲', first); state.entries.set('乙', second); state.skills.set('shared', { name: 'shared' });
    state.install.mockResolvedValue({ installedSkills: ['shared'] });
    await installRolePack('甲'); await installRolePack('乙');
    const memory = path.join(state.configDir, 'roles', '甲', 'memories', 'keep.md');
    await fs.mkdir(path.dirname(memory), { recursive: true }); await fs.writeFile(memory, 'keep');
    await uninstallRolePack('甲');
    await expect(fs.readFile(memory, 'utf8')).resolves.toBe('keep');
    expect(state.uninstall).not.toHaveBeenCalled();
  });

  it('rejects a compiled builtin role id', async () => {
    const result = await installRolePack('数据分析师');
    expect(result).toMatchObject({ success: false });
    expect(state.install).not.toHaveBeenCalled();
  });

  it('does not mark a newly installed visual-enriched definition as locally modified', async () => {
    const pack = entry('视觉哈希', ['s1']);
    state.entries.set(pack.roleId, pack); state.skills.set('s1', { name: 's1' });
    state.install.mockResolvedValue({ installedSkills: ['s1'] });

    await installRolePack(pack.roleId);

    await expect(getInstalledRolePackState(pack.roleId)).resolves.toEqual({ locallyModified: false });
  });
});

describe('云包提权检测（纯函数）', () => {
  const pack = (frontmatter: string) => `---\nname: r\ndescription: d\nmodel: balanced\nmax-iterations: 30\n${frontmatter}---\n正文`;

  it('放手档触发确认', () => {
    expect(detectRolePackElevation(pack('permission-override: ci\n'), 'r')).toEqual({ looseMode: true, bashTool: false });
  });

  it('声明 Bash 工具触发确认', () => {
    expect(detectRolePackElevation(pack('tools:\n  - Read\n  - Bash\n'), 'r')).toEqual({ looseMode: false, bashTool: true });
  });

  it('Write/Edit/联网工具不算提权', () => {
    expect(detectRolePackElevation(pack('tools:\n  - Read\n  - Write\n  - Edit\n  - WebSearch\n'), 'r')).toBeNull();
  });

  it('普通包不触发', () => {
    expect(detectRolePackElevation(pack('tools:\n  - Read\n'), 'r')).toBeNull();
  });

  it('剥离后档位回到跟随通用设置且不含 Bash，正文与其它字段不变', () => {
    const stripped = stripRolePackElevation(pack('permission-override: ci\ntools:\n  - Read\n  - Bash\n'), 'r');
    const parsed = parseAgentMd(stripped, 'r.md');
    expect(parsed?.permissionPreset).toBeUndefined();
    expect(parsed?.tools).toEqual(['Read']);
    expect(parsed?.maxIterations).toBe(30);
    expect(stripped).toContain('正文');
    expect(detectRolePackElevation(stripped, 'r')).toBeNull();
  });
});

describe('提权包安装流程', () => {
  beforeEach(async () => {
    state.configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-pack-elev-'));
    state.entries.clear(); state.skills.clear(); vi.clearAllMocks();
    state.ensure.mockResolvedValue(undefined);
  });
  afterEach(async () => fs.rm(state.configDir, { recursive: true, force: true }));

  // agentMd 显式声明 Bash → 提权；带一个 skill，避免撞「skill 均未安装成功」的兜底拒绝。
  const elevatedPack = (id = '提权专家') => ({
    roleId: id, agentMd: `---\nname: ${id}\nskills: [s1]\ntools:\n  - Read\n  - Bash\n---\nrole`, packVersion: '1.0.0',
    publisher: 'Neo', reviewedAt: '2026-07-22',
    visual: { icon: 'Bot', category: 'research', displayName: id, profession: '专家', tags: ['a'], quickPrompts: ['go'] },
    skills: [{ registryName: 's1' }],
  });
  const seedElevated = (id?: string) => {
    const pack = elevatedPack(id); state.entries.set(pack.roleId, pack); state.skills.set('s1', { name: 's1' });
    state.install.mockResolvedValue({ installedSkills: ['s1'] });
    return pack;
  };
  const installedAgentMd = async (roleId: string) =>
    fs.readFile(path.join(state.configDir, 'agents', `${roleId}.md`), 'utf-8');

  it('未过目时返回 elevation 且不落盘', async () => {
    const pack = seedElevated();
    const result = await installRolePack(pack.roleId);
    expect(result.elevation).toEqual({ looseMode: false, bashTool: true });
    expect(result.success).toBe(false);
    await expect(installedAgentMd(pack.roleId)).rejects.toThrow();
  });

  it('选安全默认（elevationReviewed）装成功且剥掉 Bash', async () => {
    const pack = seedElevated();
    const result = await installRolePack(pack.roleId, { elevationReviewed: true });
    expect(result.success).toBe(true);
    expect(parseAgentMd(await installedAgentMd(pack.roleId), `${pack.roleId}.md`)?.tools).toEqual(['Read']);
    // 还原出厂也必须是剥后版本
    const factory = await getRolePackFactoryDefinition(pack.roleId);
    expect(parseAgentMd(factory?.agentMd ?? '', `${pack.roleId}.md`)?.tools).toEqual(['Read']);
  });

  it('选按声明装（acceptElevation）保留 Bash，还原出厂也保留', async () => {
    const pack = seedElevated();
    const result = await installRolePack(pack.roleId, { acceptElevation: true });
    expect(result.success).toBe(true);
    expect(parseAgentMd(await installedAgentMd(pack.roleId), `${pack.roleId}.md`)?.tools).toEqual(['Read', 'Bash']);
    const factory = await getRolePackFactoryDefinition(pack.roleId);
    expect(parseAgentMd(factory?.agentMd ?? '', `${pack.roleId}.md`)?.tools).toEqual(['Read', 'Bash']);
  });
});
