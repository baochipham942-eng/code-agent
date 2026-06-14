import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userConfigDir: '',
}));

vi.mock('../../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mocks.userConfigDir,
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
  addMarketplace,
  listAllPlugins,
} from '../../../../src/main/skills/marketplace/marketplaceService';

describe('marketplace service registry normalization', () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-marketplace-service-'));
    mocks.userConfigDir = path.join(tempRoot, 'config');
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('normalizes Alma plugin registry shape into installable marketplace entries', async () => {
    const sourceRoot = path.join(tempRoot, 'alma-source');
    await fs.mkdir(path.join(sourceRoot, '.code-agent-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, '.code-agent-plugin', 'marketplace.json'),
      JSON.stringify({
        version: '1.0.0',
        plugins: [
          {
            id: 'token-counter',
            name: 'Token Counter',
            type: ['ui'],
            author: { name: 'Alma Team' },
            repository: 'https://github.com/yetone/alma-plugins',
            path: 'plugins/token-counter',
            featured: true,
          },
        ],
      }),
      'utf8',
    );
    await fs.mkdir(path.join(sourceRoot, 'plugins', 'token-counter'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'plugins', 'token-counter', 'plugin.json'), '{}', 'utf8');

    await expect(addMarketplace(`dir:${sourceRoot}`)).resolves.toEqual({ name: 'alma-plugins' });

    const plugins = await listAllPlugins();
    expect(plugins).toEqual([
      {
        marketplace: 'alma-plugins',
        plugin: expect.objectContaining({
          name: 'token-counter',
          source: 'plugins/token-counter',
          types: ['ui'],
          author: 'Alma Team',
          repository: 'https://github.com/yetone/alma-plugins',
        }),
      },
    ]);
  });
});
