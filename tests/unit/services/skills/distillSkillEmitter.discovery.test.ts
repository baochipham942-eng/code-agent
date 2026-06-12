import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';

const mockPaths = vi.hoisted(() => ({
  userConfigDir: '',
}));

function skillsDirs(workingDirectory?: string) {
  return {
    user: {
      new: path.join(mockPaths.userConfigDir, 'skills'),
      legacy: path.join(mockPaths.userConfigDir, 'legacy-skills'),
    },
    project: workingDirectory
      ? {
          new: path.join(workingDirectory, '.code-agent', 'skills'),
          legacy: path.join(workingDirectory, '.claude', 'skills'),
        }
      : undefined,
  };
}

vi.mock('../../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mockPaths.userConfigDir,
  getSkillsDir: (workingDirectory?: string) => skillsDirs(workingDirectory),
}));

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

vi.mock('../../../../src/main/services/toolSearch', () => ({
  getToolSearchService: () => ({
    clearSkills: vi.fn(),
    registerSkills: vi.fn(),
  }),
}));

vi.mock('../../../../src/main/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isSkillEnabled: () => true,
  }),
}));

import { emitSkillAsset } from '../../../../src/main/services/skills/distillSkillEmitter';
import {
  getSkillDiscoveryService,
  resetSkillDiscoveryService,
} from '../../../../src/main/services/skills/skillDiscoveryService';

const NOW = Date.UTC(2026, 5, 12, 9, 0, 0);

describe('distillSkillEmitter → SkillDiscoveryService', () => {
  let tmpRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'distill-skill-discovery-'));
    mockPaths.userConfigDir = path.join(tmpRoot, 'home-code-agent');
    projectDir = path.join(tmpRoot, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    resetSkillDiscoveryService();
  });

  afterEach(async () => {
    resetSkillDiscoveryService();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('manual skill emit 写入后立即刷新 discovery，/skill 可被发现', async () => {
    const discovery = getSkillDiscoveryService();
    await discovery.initialize(projectDir);
    expect(discovery.getSkill('weekly-report')).toBeUndefined();

    const result = await emitSkillAsset(
      {
        name: 'weekly-report',
        description: '每周报告',
        body: '## 步骤\n- 汇总本周完成项\n- 输出下周风险',
      },
      { draft: false, workingDirectory: projectDir, now: NOW },
    );

    expect(result.activated).toBe(true);
    expect(result.location).toBe(path.join(mockPaths.userConfigDir, 'skills', 'weekly-report', 'SKILL.md'));

    const skill = discovery.getSkill('weekly-report');
    expect(skill).toMatchObject({
      name: 'weekly-report',
      source: 'user',
      userInvocable: true,
      basePath: path.join(mockPaths.userConfigDir, 'skills', 'weekly-report'),
    });
    expect(discovery.getUserInvocableSkills().map((item) => item.name)).toContain('weekly-report');
  });
});
