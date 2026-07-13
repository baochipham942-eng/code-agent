// ============================================================================
// 项目级 skill 启停覆盖 —— discovery 解析层验收
// 覆盖：项目覆盖 > 全局；无覆盖回落全局；切换工作目录跟随新目录配置。
// ============================================================================

import { promises as fs } from 'fs';
import { writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../../src/host/services/skills/builtinSkills', () => ({
  getBuiltinSkills: () => [],
}));

vi.mock('../../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getSkills: () => [] }),
}));

vi.mock('../../../../src/host/services/toolSearch', () => ({
  getToolSearchService: () => ({ clearSkills: vi.fn(), registerSkills: vi.fn() }),
}));

// 全局黑名单：默认全开，可控禁用
const globalDisabled = new Set<string>();
vi.mock('../../../../src/host/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isSkillEnabled: (name: string) => !globalDisabled.has(name),
  }),
}));

import { SkillDiscoveryService } from '../../../../src/host/services/skills/skillDiscoveryService';
import { resetProjectSkillPreferenceCache } from '../../../../src/host/services/skills/projectSkillPreferenceService';

async function writeSkill(baseDir: string, name: string): Promise<void> {
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${name} description`, '---', '', 'Use it.', ''].join('\n'),
    'utf-8',
  );
}

/** 在项目目录写入 skill-preferences.json 覆盖 */
function writeProjectOverride(projectDir: string, overrides: Record<string, boolean>): void {
  const dir = path.join(projectDir, '.code-agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'skill-preferences.json'),
    JSON.stringify({ version: 1, overrides }, null, 2),
    'utf-8',
  );
}

describe('项目级 skill 覆盖解析（项目 > 全局）', () => {
  let tmpRoot: string;
  let homeDir: string;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    globalDisabled.clear();
    resetProjectSkillPreferenceCache();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-skill-override-'));
    homeDir = path.join(tmpRoot, 'home');
    projectA = path.join(tmpRoot, 'projectA');
    projectB = path.join(tmpRoot, 'projectB');
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });
    // 用户级 skill，两个项目共享同一个 skill 定义
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'shared-skill');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('验收 #1：同一 skill 在项目 A 禁用、项目 B 启用，解析分别正确', async () => {
    // 全局启用；A 覆盖禁用，B 覆盖启用（B 冗余但验证覆盖生效）
    writeProjectOverride(projectA, { 'shared-skill': false });
    writeProjectOverride(projectB, { 'shared-skill': true });

    const service = new SkillDiscoveryService();

    await service.initialize(projectA);
    expect(service.isSkillEnabled('shared-skill')).toBe(false);
    expect(service.getUserInvocableSkills().map((s) => s.name)).toEqual([]);

    await service.initialize(projectB);
    expect(service.isSkillEnabled('shared-skill')).toBe(true);
    expect(service.getUserInvocableSkills().map((s) => s.name)).toEqual(['shared-skill']);
  });

  it('验收 #1b：项目覆盖启用可翻转全局禁用', async () => {
    globalDisabled.add('shared-skill'); // 全局禁用
    writeProjectOverride(projectA, { 'shared-skill': true }); // 项目强制启用

    const service = new SkillDiscoveryService();
    await service.initialize(projectA);
    expect(service.isSkillEnabled('shared-skill')).toBe(true);
  });

  it('验收 #2：无项目覆盖时回落全局语义（回归保护）', async () => {
    // 无 skill-preferences.json
    const service = new SkillDiscoveryService();

    await service.initialize(projectA);
    expect(service.isSkillEnabled('shared-skill')).toBe(true); // 全局默认开

    globalDisabled.add('shared-skill');
    // 重新初始化触发重新解析全局
    await service.initialize(projectB);
    expect(service.isSkillEnabled('shared-skill')).toBe(false); // 跟随全局禁用
  });

  it('验收 #4：切换工作目录后启停跟随新目录的配置', async () => {
    writeProjectOverride(projectA, { 'shared-skill': false }); // A 禁用
    // B 无覆盖 → 跟随全局（默认开）

    const service = new SkillDiscoveryService();

    await service.initialize(projectA);
    expect(service.isSkillEnabled('shared-skill')).toBe(false);

    // 切到 B：不再受 A 覆盖影响
    await service.initialize(projectB);
    expect(service.isSkillEnabled('shared-skill')).toBe(true);

    // 切回 A：覆盖仍生效
    await service.initialize(projectA);
    expect(service.isSkillEnabled('shared-skill')).toBe(false);
  });
});
