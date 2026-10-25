// ============================================================================
// Claude legacy skills 持久化开关单测（N-EXTHISTORY-IMPORT-K1A，验收⑤）
// ============================================================================
//
// 拍板 A：Claude 技能原地读取，开关持久化在 <dataDir>/external-import.json，
// 生效优先级 显式 options > 环境变量 > 持久化设置（缺省开）。这里验：
// 1. 偏好文件读写 + 缺省/损坏 fail-open；
// 2. 开关真的改变 discovery 结果（关：~/.claude/skills 技能不出现；开：出现）；
// 3. 环境变量仍压过持久化设置；
// 4. refreshClaudeLegacySkillsInclusion 后同实例重新发现。

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => loggerMocks,
}));

const builtinSkillsFixture = vi.hoisted(() => ({ skills: [] as Array<Record<string, unknown>> }));
const cloudSkillsFixture = vi.hoisted(() => ({ skills: [] as Array<Record<string, unknown>> }));

vi.mock('../../../../src/host/services/skills/builtinSkills', () => ({
  getBuiltinSkills: () => builtinSkillsFixture.skills,
}));

vi.mock('../../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getSkills: () => cloudSkillsFixture.skills }),
}));

vi.mock('../../../../src/host/services/toolSearch', () => ({
  getToolSearchService: () => ({
    clearSkills: vi.fn(),
    registerSkills: vi.fn(),
    registerSkill: vi.fn(),
    unregisterSkill: vi.fn(),
  }),
  CORE_TOOLS: [],
  DEFERRED_TOOLS_META: [],
}));

const repoMocks = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  isSkillEnabled: vi.fn(() => true),
}));

vi.mock('../../../../src/host/services/skills/skillRepositoryService', () => ({
  getSkillRepositoryService: () => repoMocks,
}));

vi.mock('../../../../src/host/security/folderTrustService', () => ({
  isProjectConfigTrusted: async () => true,
  isProjectConfigTrustedSync: vi.fn(() => true),
}));

vi.mock('../../../../src/host/skills/marketplace/installService', () => ({
  getEnabledSkillDescriptors: async () => [],
}));

vi.mock('../../../../src/host/skills/marketplace/installedPluginRescan', () => ({
  rescanStaleInstalledPlugins: vi.fn(async () => ({ rescanned: 0, blocked: [] })),
}));

import {
  readClaudeLegacySkillsPreference,
  writeClaudeLegacySkillsPreference,
} from '../../../../src/host/services/skills/claudeLegacySkillsPreference';
import { SkillDiscoveryService } from '../../../../src/host/services/skills/skillDiscoveryService';

let tmpRoot: string;
let homeDir: string;
let dataDir: string;
let projectDir: string;

async function writeClaudeSkill(name: string): Promise<void> {
  const dir = path.join(homeDir, '.claude', 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${name} description`, '---', '', 'Use it.', ''].join('\n'),
    'utf-8',
  );
}

beforeEach(async () => {
  loggerMocks.warn.mockClear();
  builtinSkillsFixture.skills = [];
  cloudSkillsFixture.skills = [];
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-legacy-pref-'));
  homeDir = path.join(tmpRoot, 'home');
  dataDir = path.join(tmpRoot, 'data');
  projectDir = path.join(tmpRoot, 'project');
  await fs.mkdir(projectDir, { recursive: true });
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('CODE_AGENT_HOME', homeDir);
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
  vi.stubEnv('CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('claudeLegacySkillsPreference 持久化', () => {
  it('缺省（无文件）→ undefined = 默认开；写后可回读', () => {
    expect(readClaudeLegacySkillsPreference()).toBeUndefined();

    writeClaudeLegacySkillsPreference(false);
    expect(readClaudeLegacySkillsPreference()).toBe(false);

    writeClaudeLegacySkillsPreference(true);
    expect(readClaudeLegacySkillsPreference()).toBe(true);
  });

  it('文件损坏 → fail-open 回 undefined 并留痕', async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'external-import.json'), '{not json', 'utf-8');
    expect(readClaudeLegacySkillsPreference()).toBeUndefined();
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
  });
});

describe('开关改变 discovery 结果（验收⑤）', () => {
  it('默认开：~/.claude/skills 技能被发现；关掉后同目录不再出现', async () => {
    await writeClaudeSkill('claude-in-place');

    const withDefault = new SkillDiscoveryService();
    await withDefault.initialize(projectDir);
    expect(withDefault.getSkill('claude-in-place')?.source).toBe('user');

    writeClaudeLegacySkillsPreference(false);
    const withOff = new SkillDiscoveryService();
    await withOff.initialize(projectDir);
    expect(withOff.getSkill('claude-in-place')).toBeUndefined();

    writeClaudeLegacySkillsPreference(true);
    const withOn = new SkillDiscoveryService();
    await withOn.initialize(projectDir);
    expect(withOn.getSkill('claude-in-place')?.source).toBe('user');
  });

  it('环境变量显式设置时压过持久化设置', async () => {
    await writeClaudeSkill('claude-env-wins');
    writeClaudeLegacySkillsPreference(true);
    vi.stubEnv('CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS', 'false');

    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);
    expect(service.getSkill('claude-env-wins')).toBeUndefined();
  });

  it('refreshClaudeLegacySkillsInclusion：长存实例开关后重扫即时生效', async () => {
    await writeClaudeSkill('claude-refresh');
    const service = new SkillDiscoveryService();
    await service.initialize(projectDir);
    expect(service.getSkill('claude-refresh')?.source).toBe('user');

    writeClaudeLegacySkillsPreference(false);
    service.refreshClaudeLegacySkillsInclusion();
    await service.ensureInitialized(projectDir);
    expect(service.getSkill('claude-refresh')).toBeUndefined();

    writeClaudeLegacySkillsPreference(true);
    service.refreshClaudeLegacySkillsInclusion();
    await service.ensureInitialized(projectDir);
    expect(service.getSkill('claude-refresh')?.source).toBe('user');
  });
});
