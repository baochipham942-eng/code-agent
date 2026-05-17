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

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  enablePlugin,
  getEnabledSkillDirs,
  installPlugin,
  listInstalledPlugins,
} from '../../../../src/main/skills/marketplace/installService';

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

    mocks.getMarketplaceInfo.mockResolvedValue({
      rootDir: mocks.marketplaceRoot,
      manifest: {
        name: 'trusted-test',
        plugins: [{
          name: 'demo',
          source: './',
          skills: ['skills/demo'],
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

    const installed = await listInstalledPlugins();
    expect(installed['demo@trusted-test']).toMatchObject({
      plugin: 'demo',
      marketplace: 'trusted-test',
      isEnabled: false,
      skills: ['demo'],
    });
    expect(fsSync.existsSync(path.join(mocks.userConfigDir, 'skills', 'demo', 'SKILL.md'))).toBe(true);
    await expect(getEnabledSkillDirs()).resolves.toEqual([]);

    await enablePlugin('demo@trusted-test');

    await expect(getEnabledSkillDirs()).resolves.toEqual([
      path.join(mocks.userConfigDir, 'skills', 'demo'),
    ]);
    expect(mocks.reloadSkills).toHaveBeenCalledOnce();
  });
});
