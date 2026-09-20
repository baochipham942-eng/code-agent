import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedSkill } from '../../../../src/shared/contract/agentSkill';

const mocks = vi.hoisted(() => ({
  userConfigDir: '',
  projectConfigDir: '',
  discoveredSkills: [] as ParsedSkill[],
  getMarketplaceInfo: vi.fn(),
  listMarketplaces: vi.fn(),
  reloadSkills: vi.fn(),
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mocks.userConfigDir,
  getProjectConfigDir: () => mocks.projectConfigDir,
  getCommandsDir: (workingDirectory?: string) => ({
    user: path.join(mocks.userConfigDir, 'commands'),
    ...(workingDirectory ? { project: path.join(mocks.projectConfigDir, 'commands') } : {}),
  }),
}));

vi.mock('../../../../src/host/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({
    getAllSkills: () => mocks.discoveredSkills,
    reload: mocks.reloadSkills,
  }),
}));

vi.mock('../../../../src/host/skills/marketplace/marketplaceService', () => ({
  getMarketplaceInfo: (...args: unknown[]) => mocks.getMarketplaceInfo(...args),
  listMarketplaces: (...args: unknown[]) => mocks.listMarketplaces(...args),
}));

vi.mock('../../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ getPrompts: () => [] }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { exportInstalledSkill } from '../../../../src/host/skills/marketplace/exportService';
import {
  installPlugin,
  listInstalledPlugins,
} from '../../../../src/host/skills/marketplace/installService';
import { extractZipSafely } from '../../../../src/host/skills/marketplace/githubArchiveSecurity';

describe('skill export package', () => {
  let tempRoot: string;
  let skillDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-skill-export-'));
    mocks.userConfigDir = path.join(tempRoot, 'user-config');
    mocks.projectConfigDir = path.join(tempRoot, 'project-config');
    skillDir = path.join(tempRoot, 'demo');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\n\nUse the demo skill.\n',
      'utf8',
    );
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'references', 'guide.md'), 'Guide\n', 'utf8');
    mocks.discoveredSkills = [{
      name: 'demo',
      description: 'Demo skill',
      promptContent: 'Use the demo skill.',
      basePath: skillDir,
      allowedTools: [],
      disableModelInvocation: false,
      userInvocable: true,
      executionContext: 'inline',
      source: 'user',
    }];
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('exports, extracts, and installs through the existing installService shape', async () => {
    const exported = await exportInstalledSkill('demo');
    const extractedRoot = path.join(tempRoot, 'extracted');
    await extractZipSafely(exported.archive, extractedRoot);

    const meta = JSON.parse(await fs.readFile(path.join(extractedRoot, '_meta.json'), 'utf8')) as {
      name: string;
      contentHash: string;
    };
    expect(meta).toEqual({
      name: 'demo',
      contentHash: exported.contentHash,
    });
    expect(await fs.readFile(path.join(extractedRoot, 'demo', 'SKILL.md'), 'utf8'))
      .toContain('name: demo');

    mocks.getMarketplaceInfo.mockResolvedValue({
      rootDir: extractedRoot,
      manifest: {
        name: 'local-export',
        plugins: [{ name: 'demo', source: './', skills: ['demo'] }],
      },
    });

    await installPlugin('demo@local-export');
    const installed = await listInstalledPlugins();
    const record = installed['demo@local-export'];
    expect(record?.skills).toEqual(['demo']);

    const installedSkillDir = path.join(record!.pluginRoot!, 'demo');
    mocks.discoveredSkills = [{ ...mocks.discoveredSkills[0]!, basePath: installedSkillDir }];
    const repacked = await exportInstalledSkill('demo');
    expect(repacked.skillDirName).toBe(meta.name);
    expect(repacked.contentHash).toBe(meta.contentHash);
  });

  it('rejects a skill directory without SKILL.md', async () => {
    await fs.rm(path.join(skillDir, 'SKILL.md'));
    await expect(exportInstalledSkill('demo')).rejects.toThrow('SKILL_EXPORT_INVALID_SHAPE');
  });

  it('rejects path traversal entry names before extraction', async () => {
    const zip = new JSZip();
    zip.file('../escape/SKILL.md', 'owned');
    const archive = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(extractZipSafely(archive, path.join(tempRoot, 'unsafe')))
      .rejects.toThrow('Unsafe zip entry path rejected');
    await expect(fs.stat(path.join(tempRoot, 'escape', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlink that could escape the skill directory', async () => {
    await fs.writeFile(path.join(tempRoot, 'outside.txt'), 'outside', 'utf8');
    await fs.symlink(path.join(tempRoot, 'outside.txt'), path.join(skillDir, 'linked.txt'));

    await expect(exportInstalledSkill('demo')).rejects.toThrow('SKILL_EXPORT_UNSAFE_ENTRY');
  });

  it('refuses to overwrite a non-zip path under the config dir', async () => {
    const poison = path.join(mocks.userConfigDir, 'settings.json');
    await fs.mkdir(path.dirname(poison), { recursive: true });
    await fs.writeFile(poison, '{"keep":true}', 'utf8');
    await expect(exportInstalledSkill('demo', { targetPath: poison }))
      .rejects.toThrow('SKILL_EXPORT_UNSAFE_TARGET');
    expect(await fs.readFile(poison, 'utf8')).toBe('{"keep":true}');
  });

  it('capability-package-shaped directory is not a skill export', async () => {
    await fs.rm(path.join(skillDir, 'SKILL.md'));
    await fs.writeFile(
      path.join(skillDir, 'plugin.json'),
      JSON.stringify({ name: 'demo', skills: ['demo'] }),
      'utf8',
    );
    await expect(exportInstalledSkill('demo')).rejects.toThrow('SKILL_EXPORT_INVALID_SHAPE');
  });
});
