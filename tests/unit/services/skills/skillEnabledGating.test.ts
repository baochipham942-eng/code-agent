// ============================================================================
// Skill 全局启用闸控测试（disabledSkills 黑名单语义）
// ============================================================================

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/services/infra/logger', () => ({
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

vi.mock('../../../../src/host/services/skills/builtinSkills', () => ({
  getBuiltinSkills: () => [],
}));

vi.mock('../../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({
    getSkills: () => [],
  }),
}));

const activeRegisteredSkills = new Set<string>();
const registerSkillMock = vi.fn((name: string) => { activeRegisteredSkills.add(name); });
const unregisterSkillMock = vi.fn((name: string) => activeRegisteredSkills.delete(name));

vi.mock('../../../../src/host/services/toolSearch', () => ({
  getToolSearchService: () => ({
    registerSkill: registerSkillMock,
    unregisterSkill: unregisterSkillMock,
  }),
}));

// 用可控的 mock 替代真实仓库服务，模拟黑名单状态
const disabledSkills = new Set<string>();

vi.mock('../../../../src/host/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isSkillEnabled: (name: string) => !disabledSkills.has(name),
  }),
}));

import { SkillDiscoveryService } from '../../../../src/host/services/skills/skillDiscoveryService';

async function writeSkill(baseDir: string, name: string, applicability: string[] = []): Promise<void> {
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${name} description`,
      'depends: []',
      `provides: [skill:${name}]`,
      ...applicability,
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
    registerSkillMock.mockClear();
    unregisterSkillMock.mockClear();
    activeRegisteredSkills.clear();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-gating-'));
    homeDir = path.join(tmpRoot, 'home');
    projectDir = path.join(tmpRoot, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    vi.stubEnv('HOME', homeDir);
    // 本测试验的是「未设 CODE_AGENT_DATA_DIR ⇒ 回落 $HOME/.code-agent」；globalSetup 已把它指进 run 根，这里显式清空。
    vi.stubEnv('CODE_AGENT_DATA_DIR', '');
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

    const registeredNames = [...activeRegisteredSkills].sort();
    expect(registeredNames).toEqual(['skill-a']);

    // 重新启用后刷新注册表
    disabledSkills.delete('skill-b');
    await service.registerSkillsToToolSearch();

    const reRegisteredNames = [...activeRegisteredSkills].sort();
    expect(reRegisteredNames).toEqual(['skill-a', 'skill-b']);
  });

  it('filters inapplicable skills from resolver and ToolSearch candidates with observable reasons', async () => {
    const skillsDir = path.join(homeDir, '.code-agent', 'skills');
    await writeSkill(skillsDir, 'visible-skill', ['requires_tools: [Read]', 'platforms: [darwin]']);
    await writeSkill(skillsDir, 'missing-tool-skill', ['requires_tools: [ExternalSearch]']);
    await writeSkill(skillsDir, 'wrong-platform-skill', ['platforms: [win32]']);
    await writeSkill(skillsDir, 'hidden-fallback-skill', ['fallback_for_tools: [Read]']);
    await writeSkill(skillsDir, 'visible-fallback-skill', ['fallback_for_tools: [ExternalSearch]']);

    const service = new SkillDiscoveryService({
      applicability: {
        availableToolNames: () => ['Read'],
        platform: 'darwin',
      },
    });
    await service.initialize(projectDir);

    expect(service.getUserInvocableSkills().map((skill) => skill.name).sort()).toEqual([
      'visible-fallback-skill',
      'visible-skill',
    ]);
    const registeredNames = [...activeRegisteredSkills].sort();
    expect(registeredNames).toEqual(['visible-fallback-skill', 'visible-skill']);

    expect(service.getApplicabilityFilterReport().hidden).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillName: 'missing-tool-skill', reason: 'missing_required_tools' }),
      expect.objectContaining({ skillName: 'wrong-platform-skill', reason: 'platform_mismatch' }),
      expect.objectContaining({ skillName: 'hidden-fallback-skill', reason: 'fallback_tool_available' }),
    ]));
  });
});

describe('SkillRepositoryService blacklist semantics', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-repo-config-'));
    vi.stubEnv('HOME', tmpRoot);
    // 本测试验的是「未设 CODE_AGENT_DATA_DIR ⇒ 回落 $HOME/.code-agent」；globalSetup 已把它指进 run 根，这里显式清空。
    vi.stubEnv('CODE_AGENT_DATA_DIR', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('defaults all skills to enabled and persists disabled list', async () => {
    // 动态导入真实仓库服务（绕开上面的 mock）
    const { SkillRepositoryService } = await vi.importActual<
      typeof import('../../../../src/host/services/skills/skillRepositoryService')
    >('../../../../src/host/services/skills/skillRepositoryService');

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
