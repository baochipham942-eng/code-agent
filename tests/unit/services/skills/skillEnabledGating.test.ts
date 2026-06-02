// ============================================================================
// Skill 全局启用闸控测试（disabledSkills 黑名单语义）
// ============================================================================

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../../src/main/services/skills/builtinSkills', () => ({
  getBuiltinSkills: () => [],
}));

vi.mock('../../../../src/main/services/cloud', () => ({
  getCloudConfigService: () => ({
    getSkills: () => [],
  }),
}));

const registerSkillsMock = vi.fn();
const clearSkillsMock = vi.fn();

vi.mock('../../../../src/main/services/toolSearch', () => ({
  getToolSearchService: () => ({
    clearSkills: clearSkillsMock,
    registerSkills: registerSkillsMock,
  }),
}));

// 用可控的 mock 替代真实仓库服务，模拟黑名单状态
const disabledSkills = new Set<string>();

vi.mock('../../../../src/main/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isSkillEnabled: (name: string) => !disabledSkills.has(name),
  }),
}));

import { SkillDiscoveryService } from '../../../../src/main/services/skills/skillDiscoveryService';

async function writeSkill(baseDir: string, name: string): Promise<void> {
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${name} description`,
      '---',
      '',
      'Use this skill.',
      '',
    ].join('\n'),
    'utf-8',
  );
}

describe('Skill enabled gating (disabledSkills blacklist)', () => {
  let tmpRoot: string;
  let homeDir: string;
  let projectDir: string;

  beforeEach(async () => {
    disabledSkills.clear();
    registerSkillsMock.mockClear();
    clearSkillsMock.mockClear();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-gating-'));
    homeDir = path.join(tmpRoot, 'home');
    projectDir = path.join(tmpRoot, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('filters disabled skills from getUserInvocableSkills and getSkillsForContext', async () => {
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'enabled-skill');
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'disabled-skill');

    disabledSkills.add('disabled-skill');

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);

    // getAllSkills 保留全量（给管理 UI 用）
    expect(service.getAllSkills().map((s) => s.name).sort()).toEqual([
      'disabled-skill',
      'enabled-skill',
    ]);

    // 调用路径过滤被禁用的 skill
    expect(service.getUserInvocableSkills().map((s) => s.name)).toEqual(['enabled-skill']);
    expect(service.getSkillsForContext().map((s) => s.name)).toEqual(['enabled-skill']);
    expect(service.isSkillEnabled('disabled-skill')).toBe(false);
    expect(service.isSkillEnabled('enabled-skill')).toBe(true);
  });

  it('excludes disabled skills from ToolSearch registration and re-syncs after toggle', async () => {
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'skill-a');
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'skill-b');

    disabledSkills.add('skill-b');

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);

    const registeredNames = (registerSkillsMock.mock.calls.at(-1)?.[0] as Array<{ name: string }>).map(
      (s) => s.name,
    );
    expect(registeredNames).toEqual(['skill-a']);

    // 重新启用后刷新注册表
    disabledSkills.delete('skill-b');
    service.registerSkillsToToolSearch();

    const reRegisteredNames = (registerSkillsMock.mock.calls.at(-1)?.[0] as Array<{ name: string }>)
      .map((s) => s.name)
      .sort();
    expect(reRegisteredNames).toEqual(['skill-a', 'skill-b']);
  });
});

describe('SkillRepositoryService blacklist semantics', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-repo-config-'));
    vi.stubEnv('HOME', tmpRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('defaults all skills to enabled and persists disabled list', async () => {
    // 动态导入真实仓库服务（绕开上面的 mock）
    const { SkillRepositoryService } = await vi.importActual<
      typeof import('../../../../src/main/services/skills/skillRepositoryService')
    >('../../../../src/main/services/skills/skillRepositoryService');

    const service = new SkillRepositoryService();
    await service.initialize();

    // 默认全开
    expect(service.isSkillEnabled('any-skill')).toBe(true);

    // 禁用进黑名单
    service.disableSkill('any-skill');
    expect(service.isSkillEnabled('any-skill')).toBe(false);
    expect(service.getDisabledSkills()).toEqual(['any-skill']);

    // 重复禁用幂等
    service.disableSkill('any-skill');
    expect(service.getDisabledSkills()).toEqual(['any-skill']);

    // 启用 = 移出黑名单
    service.enableSkill('any-skill');
    expect(service.isSkillEnabled('any-skill')).toBe(true);
    expect(service.getDisabledSkills()).toEqual([]);
  });
});
