import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userConfigDir: '',
  projectConfigDir: '',
  marketplaceRoot: '',
  getMarketplaceInfo: vi.fn(),
  listMarketplaces: vi.fn(),
  reloadSkills: vi.fn(),
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mocks.userConfigDir,
  getProjectConfigDir: () => mocks.projectConfigDir,
  getCommandsDir: (workingDirectory?: string) => ({
    user: `${mocks.userConfigDir}/commands`,
    ...(workingDirectory ? { project: `${mocks.projectConfigDir}/commands` } : {}),
  }),
}));

vi.mock('../../../../src/host/skills/marketplace/marketplaceService', () => ({
  getMarketplaceInfo: (...args: unknown[]) => mocks.getMarketplaceInfo(...args),
  listMarketplaces: (...args: unknown[]) => mocks.listMarketplaces(...args),
}));

vi.mock('../../../../src/host/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({
    reload: mocks.reloadSkills,
  }),
}));

vi.mock('../../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getPrompts: () => [],
  }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import crypto from 'crypto';
import {
  disablePlugin,
  enablePlugin,
  getEnabledSkillDirs,
  installFromRegistryEntry,
  installPlugin,
  listInstalledPlugins,
  uninstallPlugin,
} from '../../../../src/host/skills/marketplace/installService';
import { getPromptCommandService } from '../../../../src/host/services/commands/promptCommandService';

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
    vi.unstubAllGlobals();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function makeRemoteZip(content: string, unsafeEntry?: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('remote-repo/plugins/remote-demo/SKILL.md', content);
    if (unsafeEntry) zip.file(unsafeEntry, 'owned');
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  function useRemotePlugin(): void {
    mocks.getMarketplaceInfo.mockResolvedValue({
      rootDir: mocks.marketplaceRoot,
      manifest: {
        name: 'trusted-test',
        plugins: [{
          name: 'remote-demo',
          source: 'plugins/remote-demo',
          repository: 'owner/remote-repo',
          skills: ['.'],
        }],
      },
    });
  }

  function mockGitHubInstall(commit: string, zip: Buffer): void {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ sha: commit }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(new Uint8Array(zip), {
        status: 200,
        headers: { 'content-length': String(zip.byteLength) },
      });
    }));
  }

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
      // listCommands 合并内置兜底命令（project > user > mcp > builtin），用户命令之后追加 builtin。
      expect.objectContaining({
        name: 'init',
        source: 'builtin',
      }),
    ]);
    await expect(enablePlugin('demo@trusted-test')).resolves.toBeUndefined();

    await disablePlugin('demo@trusted-test');

    await expect(getEnabledSkillDirs()).resolves.toEqual([]);
    expect(fsSync.existsSync(commandPath)).toBe(false);
    expect(mocks.reloadSkills).toHaveBeenCalledTimes(2);
  });

  it('pins a GitHub commit and preserves the same content hash across reinstall', async () => {
    useRemotePlugin();
    const commit = 'a'.repeat(40);
    const zip = await makeRemoteZip('---\nname: remote-demo\n---\nfixed\n');
    mockGitHubInstall(commit, zip);

    await installPlugin('remote-demo@trusted-test');
    const first = (await listInstalledPlugins())['remote-demo@trusted-test']!;
    await installPlugin('remote-demo@trusted-test', { force: true });
    const second = (await listInstalledPlugins())['remote-demo@trusted-test']!;

    expect(first.pinnedCommit).toBe(commit);
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.contentHash).toBe(first.contentHash);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `https://codeload.github.com/owner/remote-repo/zip/${commit}`,
    );
  });

  it('detects upstream branch drift during reinstall and preserves the installed record', async () => {
    useRemotePlugin();
    const firstCommit = 'a'.repeat(40);
    mockGitHubInstall(firstCommit, await makeRemoteZip('first'));
    await installPlugin('remote-demo@trusted-test');
    const first = (await listInstalledPlugins())['remote-demo@trusted-test']!;

    const secondCommit = 'b'.repeat(40);
    mockGitHubInstall(secondCommit, await makeRemoteZip('changed'));
    await expect(
      installPlugin('remote-demo@trusted-test', { force: true }),
    ).rejects.toThrow('Plugin content drift detected');

    const retained = (await listInstalledPlugins())['remote-demo@trusted-test']!;
    expect(retained.pinnedCommit).toBe(firstCommit);
    expect(retained.contentHash).toBe(first.contentHash);
    expect(fsSync.existsSync(retained.pluginRoot!)).toBe(true);
  });

  it('rejects a GitHub archive over the 50 MB limit with a clear error', async () => {
    useRemotePlugin();
    const commit = 'c'.repeat(40);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      if (String(input).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ sha: commit }), { status: 200 });
      }
      return new Response('small-body', {
        status: 200,
        headers: { 'content-length': String(50 * 1024 * 1024 + 1) },
      });
    }));

    await expect(installPlugin('remote-demo@trusted-test')).rejects.toThrow(
      'exceeds the 50 MB download limit',
    );
  });

  it.each(['../evil', '/absolute/evil'])('rejects zip-slip entry %s', async (entry) => {
    useRemotePlugin();
    mockGitHubInstall('d'.repeat(40), await makeRemoteZip('safe', entry));

    await expect(installPlugin('remote-demo@trusted-test')).rejects.toThrow(
      'Unsafe zip entry path rejected:',
    );
  });

  it('fails closed with a retryable error when GitHub branch resolution fails', async () => {
    useRemotePlugin();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));

    await expect(installPlugin('remote-demo@trusted-test')).rejects.toThrow(
      'Unable to resolve an immutable GitHub commit for owner/remote-repo; retry the installation',
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith('https://api.github.com/'))).toBe(true);
  });

  it('reads and rewrites legacy installed records without pin or hash fields', async () => {
    await fs.mkdir(mocks.userConfigDir, { recursive: true });
    const legacyRecord = {
      plugin: 'legacy',
      marketplace: 'old-market',
      scope: 'user',
      isEnabled: false,
      installedAt: '2025-01-01T00:00:00.000Z',
      skills: [],
      sourceMarketplacePath: '/legacy/path',
    };
    await fs.writeFile(
      path.join(mocks.userConfigDir, 'installed-plugins.json'),
      JSON.stringify({ 'legacy@old-market': legacyRecord }),
      'utf8',
    );

    expect((await listInstalledPlugins())['legacy@old-market']).toEqual(legacyRecord);
    await installPlugin('demo@trusted-test');
    const rewritten = JSON.parse(
      await fs.readFile(path.join(mocks.userConfigDir, 'installed-plugins.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(rewritten['legacy@old-market']).toEqual(legacyRecord);
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

describe('installFromRegistryEntry (官方 registry 可验证分发)', () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-registry-'));
    mocks.userConfigDir = path.join(tempRoot, 'user-config');
    mocks.projectConfigDir = path.join(tempRoot, 'project-config');
    mocks.reloadSkills.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function makeRegistryZip(content: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('remote-repo/plugins/remote-demo/SKILL.md', content);
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  function sha256(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  function registryEntry(pinnedCommit: string, contentHash: string) {
    return {
      name: 'remote-demo',
      repository: 'owner/remote-repo',
      path: 'plugins/remote-demo',
      pinnedCommit,
      contentHash,
      skills: ['.'],
      publisher: 'Agent Neo',
      reviewedAt: '2026-07-13',
    };
  }

  function mockCodeload(zip: Buffer): void {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(zip), {
      status: 200,
      headers: { 'content-length': String(zip.byteLength) },
    })));
  }

  it('installs by the registry pin without resolving branch heads', async () => {
    const commit = 'e'.repeat(40);
    const zip = await makeRegistryZip('---\nname: remote-demo\n---\nregistry\n');
    mockCodeload(zip);

    await installFromRegistryEntry(registryEntry(commit, sha256(zip)), { enableAfterInstall: true });

    const record = (await listInstalledPlugins())['remote-demo@official-registry']!;
    expect(record).toMatchObject({
      plugin: 'remote-demo',
      marketplace: 'official-registry',
      isEnabled: true,
      pinnedCommit: commit,
      contentHash: sha256(zip),
    });
    const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(calls).toEqual([`https://codeload.github.com/owner/remote-repo/zip/${commit}`]);
  });

  it('fails closed when the archive hash does not match the registry entry', async () => {
    const commit = 'e'.repeat(40);
    mockCodeload(await makeRegistryZip('tampered'));

    await expect(
      installFromRegistryEntry(registryEntry(commit, 'f'.repeat(64))),
    ).rejects.toThrow('Registry content hash mismatch');
    expect((await listInstalledPlugins())['remote-demo@official-registry']).toBeUndefined();
  });

  it('upgrades to a new registry pin without tripping the TOFU drift assertion', async () => {
    const firstZip = await makeRegistryZip('v1');
    mockCodeload(firstZip);
    await installFromRegistryEntry(registryEntry('a'.repeat(40), sha256(firstZip)));

    const secondZip = await makeRegistryZip('v2');
    mockCodeload(secondZip);
    await installFromRegistryEntry(registryEntry('b'.repeat(40), sha256(secondZip)), { force: true });

    const record = (await listInstalledPlugins())['remote-demo@official-registry']!;
    expect(record.pinnedCommit).toBe('b'.repeat(40));
    expect(record.contentHash).toBe(sha256(secondZip));
  });

  it('preserves the installed plugin when a force upgrade fails after asset staging', async () => {
    const firstZip = await makeRegistryZip('v1');
    mockCodeload(firstZip);
    await installFromRegistryEntry(registryEntry('a'.repeat(40), sha256(firstZip)));
    const firstRecord = (await listInstalledPlugins())['remote-demo@official-registry']!;
    const firstSkillPath = path.join(firstRecord.pluginRoot!, 'SKILL.md');

    const secondZip = await makeRegistryZip('v2');
    mockCodeload(secondZip);
    await expect(
      installFromRegistryEntry({
        ...registryEntry('b'.repeat(40), sha256(secondZip)),
        skills: ['missing-skill'],
      }, { force: true }),
    ).rejects.toThrow('Skill path not found');

    const retainedRecord = (await listInstalledPlugins())['remote-demo@official-registry']!;
    expect(retainedRecord).toEqual(firstRecord);
    expect(retainedRecord.pinnedCommit).toBe('a'.repeat(40));
    expect(retainedRecord.contentHash).toBe(sha256(firstZip));
    expect(retainedRecord.pluginRoot).toBe(firstRecord.pluginRoot);
    await expect(fs.readFile(firstSkillPath, 'utf8')).resolves.toBe('v1');
  });
});
