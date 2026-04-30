import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/services/infra/logger', () => ({
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

vi.mock('../../../../src/main/services/toolSearch', () => ({
  getToolSearchService: () => ({
    clearSkills: vi.fn(),
    registerSkills: vi.fn(),
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

describe('SkillDiscoveryService Claude legacy isolation', () => {
  let tmpRoot: string;
  let homeDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-discovery-'));
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

  it('does not scan user or project Claude legacy skill directories by default', async () => {
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'user-claude');
    await writeSkill(path.join(projectDir, '.claude', 'skills'), 'project-claude');
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'user-code-agent');
    await writeSkill(path.join(projectDir, '.code-agent', 'skills'), 'project-code-agent');

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);

    const skillNames = service.getAllSkills().map((skill) => skill.name).sort();
    expect(skillNames).toEqual(['project-code-agent', 'user-code-agent']);
  });

  it('scans Claude legacy skill directories when explicitly configured', async () => {
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'user-claude');
    await writeSkill(path.join(projectDir, '.claude', 'skills'), 'project-claude');
    await writeSkill(path.join(homeDir, '.code-agent', 'skills'), 'user-code-agent');
    await writeSkill(path.join(projectDir, '.code-agent', 'skills'), 'project-code-agent');

    const service = new SkillDiscoveryService({ includeClaudeLegacySkills: true });
    await service.initialize(projectDir);

    const skillNames = service.getAllSkills().map((skill) => skill.name).sort();
    expect(skillNames).toEqual([
      'project-claude',
      'project-code-agent',
      'user-claude',
      'user-code-agent',
    ]);
  });

  it('treats CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS as an explicit opt-in', async () => {
    vi.stubEnv('CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS', 'true');
    await writeSkill(path.join(homeDir, '.claude', 'skills'), 'user-claude');

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);

    expect(service.getSkill('user-claude')?.source).toBe('user');
  });
});
