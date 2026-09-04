import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/services/infra/logger', () => ({
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

vi.mock('../../../../src/host/services/toolSearch', () => ({
  getToolSearchService: () => ({
    clearSkills: vi.fn(),
    registerSkills: vi.fn(),
    registerSkill: vi.fn(),
    unregisterSkill: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isSkillEnabled: () => true,
  }),
}));

vi.mock('../../../../src/host/security/folderTrustService', () => ({
  isProjectConfigTrusted: async () => true,
  isProjectConfigTrustedSync: () => true,
}));

const marketplaceSkillDirs = vi.hoisted(() => new Set<string>());

vi.mock('../../../../src/host/skills/marketplace/installService', () => ({
  getEnabledSkillDirs: async () => [...marketplaceSkillDirs],
}));

import { SkillDiscoveryService } from '../../../../src/host/services/skills/skillDiscoveryService';

async function writeSkill(baseDir: string, name: string): Promise<void> {
  const skillDir = path.join(baseDir, name);
  await writeSkillMd(skillDir, name);
}

async function writeSkillMd(skillDir: string, name: string): Promise<void> {
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${name} description`,
      'depends: []',
      `provides: [skill:${name}]`,
      '---',
      '',
      'Use this skill.',
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function writeLibraryMeta(libraryDir: string, skillsPath: string): Promise<void> {
  await fs.mkdir(libraryDir, { recursive: true });
  await fs.writeFile(
    path.join(libraryDir, '.meta.json'),
    JSON.stringify({
      repoId: path.basename(libraryDir),
      repoName: `fixture/${path.basename(libraryDir)}`,
      skillsPath,
    }),
    'utf-8',
  );
}

describe('SkillDiscoveryService discovery', () => {
  let tmpRoot: string;
  let homeDir: string;
  let projectDir: string;

  beforeEach(async () => {
    marketplaceSkillDirs.clear();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-discovery-'));
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

  it('scans user and project Claude legacy skill directories by default', async () => {
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'user-claude');
    await writeSkill(path.join(projectDir, '.claude', 'skills'), 'project-claude');
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'user-code-agent');
    await writeSkill(path.join(projectDir, '.code-agent', 'skills'), 'project-code-agent');

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);

    const skillNames = service.getAllSkills().map((skill) => skill.name).sort();
    expect(skillNames).toEqual([
      'project-claude',
      'project-code-agent',
      'user-claude',
      'user-code-agent',
    ]);
  });

  it('rebuilds stale pre-declaration metadata instead of replaying missing depends', async () => {
    const names = ['dream', 'lark-sheets', 'e2e-cdp', 'deploy-tauri-app'];
    const entries: Record<string, unknown> = {};
    for (const name of names) {
      const skillDir = path.join(homeDir, '.code-agent', 'skills', name);
      await fs.mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, 'SKILL.md');
      await fs.writeFile(
        skillPath,
        ['---', `name: ${name}`, `description: ${name} legacy fixture`, '---', '', 'Use this skill.'].join('\n'),
        'utf-8',
      );
      const stat = await fs.stat(skillPath);
      entries[`user:${skillPath}`] = {
        source: 'user',
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        skill: {
          name,
          description: `${name} stale cache fixture`,
          promptContent: '',
          basePath: skillDir,
          allowedTools: [],
          disableModelInvocation: false,
          userInvocable: true,
          executionContext: 'inline',
          source: 'user',
          loaded: false,
        },
      };
    }
    const cacheDir = path.join(homeDir, '.code-agent', 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'skill-metadata-index-v3.json'),
      JSON.stringify({ version: 3, entries }),
      'utf-8',
    );

    const service = new SkillDiscoveryService({ includeClaudeLegacySkills: false });
    await expect(service.initialize(projectDir)).resolves.toBeUndefined();

    for (const name of names) {
      expect(service.getSkill(name)).toMatchObject({
        name,
        depends: [],
        provides: [`skill:${name}`],
      });
    }
  });

  it('can skip Claude legacy skill directories when explicitly configured', async () => {
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'user-claude');
    await writeSkill(path.join(projectDir, '.claude', 'skills'), 'project-claude');
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'user-code-agent');
    await writeSkill(path.join(projectDir, '.code-agent', 'skills'), 'project-code-agent');

    const service = new SkillDiscoveryService({ includeClaudeLegacySkills: false });
    await service.initialize(projectDir);

    const skillNames = service.getAllSkills().map((skill) => skill.name).sort();
    expect(skillNames).toEqual(['project-code-agent', 'user-code-agent']);
  });

  it('exposes exactly the run-level skill set', async () => {
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'visible-skill');
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'hidden-skill');

    const service = new SkillDiscoveryService({
      includeClaudeLegacySkills: false,
      skillNames: ['visible-skill'],
    });
    await service.initialize(projectDir);

    expect(service.getAllSkills().map((skill) => skill.name)).toEqual(['visible-skill']);
    expect(service.getSkill('visible-skill')?.name).toBe('visible-skill');
    expect(service.getSkill('hidden-skill')).toBeUndefined();
  });

  it('does not scan machine skills when the run-level set is empty', async () => {
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'machine-only-skill');

    const service = new SkillDiscoveryService({ skillNames: [] });
    await service.initialize(projectDir);

    expect(service.getAllSkills()).toEqual([]);
    expect(service.getSkill('machine-only-skill')).toBeUndefined();
  });

  it('keeps CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS=true compatible', async () => {
    vi.stubEnv('CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS', 'true');
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'user-claude');

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);

    expect(service.getSkill('user-claude')?.source).toBe('user');
  });

  it('treats CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS=false as an explicit opt-out', async () => {
    vi.stubEnv('CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS', 'false');
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'user-claude');
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'user-code-agent');

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);

    expect(service.getAllSkills().map((skill) => skill.name).sort()).toEqual(['user-code-agent']);
  });

  it('loads only enabled marketplace plugin skill directories as plugin skills', async () => {
    await writeSkill(path.join(homeDir, '.code-agent', 'plugins', 'enabled-demo', 'skills'), 'plugin-demo');
    await writeSkill(path.join(homeDir, '.code-agent', 'plugins', 'disabled-demo', 'skills'), 'hidden-demo');
    marketplaceSkillDirs.add(path.join(homeDir, '.code-agent', 'plugins', 'enabled-demo', 'skills', 'plugin-demo'));

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);

    expect(service.getSkill('plugin-demo')?.source).toBe('plugin');
    expect(service.getSkill('hidden-demo')).toBeUndefined();
  });

  it('discovers a single-skill library whose SKILL.md is at skillsPath "."', async () => {
    const libraryDir = path.join(homeDir, '.code-agent', 'skills', 'single-skill-library');
    await writeSkillMd(libraryDir, 'single-library-skill');
    await writeLibraryMeta(libraryDir, '.');

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);

    expect(service.getAllSkills()).toEqual([
      expect.objectContaining({
        name: 'single-library-skill',
        source: 'library',
        basePath: libraryDir,
      }),
    ]);
  });

  it('does not hijack meta-less user skill directories as single-skill libraries', async () => {
    // 蒸馏/用户手写 skill 与下载库共用 ~/.code-agent/skills；无 .meta.json 的
    // 根 SKILL.md 目录必须留给 user 扫描，不得按 library 加载
    const userSkillDir = path.join(homeDir, '.code-agent', 'skills', 'weekly-report');
    await writeSkillMd(userSkillDir, 'weekly-report');

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);

    expect(
      service.getAllSkills().filter((skill) => skill.source === 'library')
    ).toEqual([]);
  });

  it('keeps discovering multi-skill libraries through child directories', async () => {
    const libraryDir = path.join(homeDir, '.code-agent', 'skills', 'multi-skill-library');
    await writeSkill(path.join(libraryDir, 'skills'), 'first-library-skill');
    await writeSkill(path.join(libraryDir, 'skills'), 'second-library-skill');
    await writeLibraryMeta(libraryDir, 'skills');

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);

    expect(service.getAllSkills().map((skill) => ({
      name: skill.name,
      source: skill.source,
    })).sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      { name: 'first-library-skill', source: 'library' },
      { name: 'second-library-skill', source: 'library' },
    ]);
  });

  it('reuses cached metadata on the next initialize without rereading unchanged SKILL.md files', async () => {
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'user-claude');
    await writeSkill(path.join(projectDir, '.code-agent', 'skills'), 'project-code-agent');

    const firstService = new SkillDiscoveryService({ includeClaudeLegacySkills: true });
    await firstService.initialize(projectDir);

    const cachePath = path.join(
      homeDir,
      '.code-agent',
      'cache',
      'skill-metadata-index-v4.json',
    );
    const cacheContent = await fs.readFile(cachePath, 'utf-8');
    expect(cacheContent).toContain('user-claude');
    expect(cacheContent).toContain('project-code-agent');

    const legacySkillPath = path.join(homeDir, '.claude', 'skills', 'user-claude', 'SKILL.md');
    const projectSkillPath = path.join(projectDir, '.code-agent', 'skills', 'project-code-agent', 'SKILL.md');
    await fs.chmod(legacySkillPath, 0o000);
    await fs.chmod(projectSkillPath, 0o000);

    const secondService = new SkillDiscoveryService({ includeClaudeLegacySkills: true });
    try {
      await secondService.initialize(projectDir);

      expect(secondService.getAllSkills().map((skill) => skill.name).sort()).toEqual([
        'project-code-agent',
        'user-claude',
      ]);
    } finally {
      await fs.chmod(legacySkillPath, 0o600);
      await fs.chmod(projectSkillPath, 0o600);
    }
  });
});
