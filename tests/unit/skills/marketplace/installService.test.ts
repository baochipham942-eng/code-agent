import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userConfigDir: '',
  projectConfigDir: '',
  marketplaceRoot: '',
  getMarketplaceInfo: vi.fn(),
  listMarketplaces: vi.fn(),
  reloadSkills: vi.fn(),
}));

vi.mock('../../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mocks.userConfigDir,
  getProjectConfigDir: () => mocks.projectConfigDir,
  getCommandsDir: (workingDirectory?: string) => ({
    user: `${mocks.userConfigDir}/commands`,
    ...(workingDirectory ? { project: `${mocks.projectConfigDir}/commands` } : {}),
  }),
}));

vi.mock('../../../../src/main/skills/marketplace/marketplaceService', () => ({
  getMarketplaceInfo: (...args: unknown[]) => mocks.getMarketplaceInfo(...args),
  listMarketplaces: (...args: unknown[]) => mocks.listMarketplaces(...args),
}));

vi.mock('../../../../src/main/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({
    reload: mocks.reloadSkills,
  }),
}));

vi.mock('../../../../src/main/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getPrompts: () => [],
  }),
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  disablePlugin,
  enablePlugin,
  getEnabledSkillDirs,
  installPlugin,
  listInstalledPlugins,
  uninstallPlugin,
} from '../../../../src/main/skills/marketplace/installService';
import { getPromptCommandService } from '../../../../src/main/services/commands/promptCommandService';

describe('marketplace install service trust defaults', () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-marketplace-'));
    mocks.userConfigDir = path.join(tempRoot, 'user-config');
    mocks.projectConfigDir = path.join(tempRoot, 'project-config');
    mocks.marketplaceRoot = path.join(tempRoot, 'marketplace');

    const skillDir = path.join(mocks.marketplaceRoot, 'skills', 'demo');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\n---\n', 'utf8');
    const commandsDir = path.join(mocks.marketplaceRoot, 'commands');
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(
      path.join(commandsDir, 'inspect.md'),
      '---\ndescription: Inspect current context\n---\nInspect $ARGUMENTS',
      'utf8',
    );

    mocks.getMarketplaceInfo.mockResolvedValue({
      rootDir: mocks.marketplaceRoot,
      manifest: {
        name: 'trusted-test',
        plugins: [{
          name: 'demo',
          source: './',
          skills: ['skills/demo'],
          commands: ['commands/inspect.md'],
        }],
      },
    });
    mocks.listMarketplaces.mockResolvedValue({
      'trusted-test': {
        source: { source: 'directory', path: mocks.marketplaceRoot },
        installLocation: mocks.marketplaceRoot,
        lastUpdated: '2026-05-17T00:00:00.000Z',
      },
    });
    mocks.reloadSkills.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('installs marketplace plugins as disabled until explicitly enabled', async () => {
    await installPlugin('demo@trusted-test');
    const commandPath = path.join(mocks.userConfigDir, 'commands', 'inspect.md');

    const installed = await listInstalledPlugins();
    expect(installed['demo@trusted-test']).toMatchObject({
      plugin: 'demo',
      marketplace: 'trusted-test',
      isEnabled: false,
      skills: ['demo'],
      skillPaths: ['skills/demo'],
      commands: ['inspect'],
      commandPaths: ['commands/inspect.md'],
    });
    const pluginRoot = installed['demo@trusted-test']!.pluginRoot!;
    expect(fsSync.existsSync(path.join(pluginRoot, 'skills', 'demo', 'SKILL.md'))).toBe(true);
    expect(fsSync.existsSync(path.join(mocks.userConfigDir, 'skills', 'demo', 'SKILL.md'))).toBe(false);
    expect(fsSync.existsSync(commandPath)).toBe(false);
    await expect(getEnabledSkillDirs()).resolves.toEqual([]);

    await enablePlugin('demo@trusted-test');

    await expect(getEnabledSkillDirs()).resolves.toEqual([
      path.join(pluginRoot, 'skills', 'demo'),
    ]);
    expect(fsSync.existsSync(commandPath)).toBe(true);
    await expect(getPromptCommandService().listCommands()).resolves.toEqual([
      expect.objectContaining({
        name: 'inspect',
        description: 'Inspect current context',
        scope: 'user',
      }),
    ]);
    await expect(enablePlugin('demo@trusted-test')).resolves.toBeUndefined();

    await disablePlugin('demo@trusted-test');

    await expect(getEnabledSkillDirs()).resolves.toEqual([]);
    expect(fsSync.existsSync(commandPath)).toBe(false);
    expect(mocks.reloadSkills).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite an existing prompt command when enabling a plugin', async () => {
    await installPlugin('demo@trusted-test');
    const commandPath = path.join(mocks.userConfigDir, 'commands', 'inspect.md');
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, 'user-owned command', 'utf8');

    await expect(enablePlugin('demo@trusted-test')).rejects.toThrow('Command destination already exists');

    const installed = await listInstalledPlugins();
    expect(installed['demo@trusted-test']?.isEnabled).toBe(false);
    await expect(fs.readFile(commandPath, 'utf8')).resolves.toBe('user-owned command');
  });

  it('installs provider theme and UI plugin assets without exposing skills or commands', async () => {
    const uiDir = path.join(mocks.marketplaceRoot, 'plugins', 'token-counter');
    const themeDir = path.join(mocks.marketplaceRoot, 'plugins', 'catppuccin-theme');
    const providerDir = path.join(mocks.marketplaceRoot, 'plugins', 'openai-codex-auth');
    await fs.mkdir(uiDir, { recursive: true });
    await fs.mkdir(themeDir, { recursive: true });
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(path.join(uiDir, 'plugin.json'), '{"id":"token-counter"}', 'utf8');
    await fs.writeFile(path.join(themeDir, 'theme.json'), '{"id":"catppuccin-theme"}', 'utf8');
    await fs.writeFile(path.join(providerDir, 'provider.json'), '{"id":"openai-codex-auth"}', 'utf8');

    mocks.getMarketplaceInfo.mockResolvedValue({
      rootDir: mocks.marketplaceRoot,
      manifest: {
        name: 'trusted-test',
        plugins: [
          {
            name: 'token-counter',
            source: 'plugins/token-counter',
            types: ['ui'],
          },
          {
            name: 'catppuccin-theme',
            source: 'plugins/catppuccin-theme',
            types: ['theme'],
          },
          {
            name: 'openai-codex-auth',
            source: 'plugins/openai-codex-auth',
            types: ['provider'],
          },
        ],
      },
    });

    const result = await installPlugin('openai-codex-auth@trusted-test');
    const installed = await listInstalledPlugins();
    const record = installed['openai-codex-auth@trusted-test'];

    expect(result).toMatchObject({
      pluginSpec: 'openai-codex-auth@trusted-test',
      installedSkills: [],
      installedCommands: [],
    });
    expect(record).toMatchObject({
      plugin: 'openai-codex-auth',
      marketplace: 'trusted-test',
      isEnabled: false,
      types: ['provider'],
      skills: [],
      commands: [],
    });
    expect(record?.pluginRoot).toContain('openai-codex-auth__trusted-test');
    expect(fsSync.existsSync(path.join(record!.pluginRoot!, 'provider.json'))).toBe(true);
    await expect(getEnabledSkillDirs()).resolves.toEqual([]);

    await enablePlugin('openai-codex-auth@trusted-test');
    expect((await listInstalledPlugins())['openai-codex-auth@trusted-test']?.isEnabled).toBe(true);
    await expect(getEnabledSkillDirs()).resolves.toEqual([]);

    await disablePlugin('openai-codex-auth@trusted-test');
    expect((await listInstalledPlugins())['openai-codex-auth@trusted-test']?.isEnabled).toBe(false);

    const uninstallResult = await uninstallPlugin('openai-codex-auth@trusted-test');
    expect(uninstallResult.removedPluginRoot).toBe(record?.pluginRoot);
    expect(fsSync.existsSync(record!.pluginRoot!)).toBe(false);
  });
});
