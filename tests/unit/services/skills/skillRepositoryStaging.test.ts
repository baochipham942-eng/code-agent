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

vi.mock('../../../../src/host/services/skills/gitDownloader', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../src/host/services/skills/gitDownloader')
  >();
  return {
    ...actual,
    downloadRepository: vi.fn(),
  };
});

import {
  downloadRepository,
  type DownloadOptions,
} from '../../../../src/host/services/skills/gitDownloader';
import { SkillRepositoryService } from '../../../../src/host/services/skills/skillRepositoryService';

const mockedDownloadRepository = vi.mocked(downloadRepository);

describe('SkillRepositoryService staged install lifecycle', () => {
  let configRoot: string;
  let service: SkillRepositoryService;

  beforeEach(async () => {
    configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-staging-'));
    vi.stubEnv('CODE_AGENT_DATA_DIR', configRoot);
    service = new SkillRepositoryService();

    mockedDownloadRepository.mockImplementation(async (options: DownloadOptions) => {
      await fs.mkdir(options.targetDir, { recursive: true });
      const skillMdContent = [
        '---',
        'name: preview-skill',
        'description: Preview lifecycle skill',
        '---',
        '',
        'Install only after confirmation.',
        '',
      ].join('\n');
      await fs.writeFile(
        path.join(options.targetDir, 'SKILL.md'),
        skillMdContent,
        'utf-8'
      );
      await fs.writeFile(
        path.join(options.targetDir, '.meta.json'),
        JSON.stringify({
          source: options.source || 'github',
          owner: options.owner,
          repo: options.repo,
          branch: options.branch,
          commitHash: '0123456789abcdef0123456789abcdef01234567',
          downloadedAt: 100,
          lastUpdated: 100,
          ...(options.modelScopeRepoType
            ? { modelScopeRepoType: options.modelScopeRepoType }
            : {}),
        }),
        'utf-8'
      );
      return {
        success: true,
        localPath: options.targetDir,
        commitHash: '0123456789abcdef0123456789abcdef01234567',
      };
    });
  });

  afterEach(async () => {
    await service.dispose();
    mockedDownloadRepository.mockReset();
    vi.unstubAllEnvs();
    await fs.rm(configRoot, { recursive: true, force: true });
  });

  it('stages without config pollution and registers only after confirm', async () => {
    const staged = await service.stageRepository(
      'https://www.modelscope.cn/skills/@preview/preview-repo',
      'Preview repository'
    );

    expect(staged).toMatchObject({
      success: true,
      repoId: 'preview-preview-repo',
      repoName: 'Preview repository',
      sourceType: 'modelscope',
      layout: 'single-skill',
    });
    expect(staged.skills).toHaveLength(1);
    expect(staged.skills?.[0].skillMdContent).toContain('---\nname: preview-skill');
    expect(service.getLocalLibraries()).toEqual([]);
    await expect(fs.access(path.join(configRoot, 'skill-config.json'))).rejects.toThrow();
    await expect(
      fs.access(path.join(configRoot, 'skills', 'preview-preview-repo'))
    ).rejects.toThrow();

    const confirmed = await service.confirmStagedRepository(staged.stageId!);

    expect(confirmed.success).toBe(true);
    expect(confirmed.library?.skills.map((skill) => skill.name)).toEqual([
      'preview-skill',
    ]);
    expect(service.getLocalLibraries()).toHaveLength(1);
    await expect(
      fs.access(path.join(configRoot, 'skills', 'preview-preview-repo', 'SKILL.md'))
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(configRoot, 'skills', '.staging', staged.stageId!))
    ).rejects.toThrow();

    const config = JSON.parse(
      await fs.readFile(path.join(configRoot, 'skill-config.json'), 'utf-8')
    ) as { repositories: Array<{ id: string }> };
    expect(config.repositories.map((repository) => repository.id)).toEqual([
      'preview-preview-repo',
    ]);
  });

  it('rejects staging an already-registered repository upfront', async () => {
    const first = await service.stageRepository('https://github.com/preview/dup-repo');
    expect(first.success).toBe(true);
    await service.confirmStagedRepository(first.stageId!);

    const second = await service.stageRepository('https://github.com/preview/dup-repo');
    expect(second.success).toBe(false);
    expect(second.error).toContain('already installed');
  });

  it('replaces an orphan on-disk directory that is not registered in config', async () => {
    // 半孤儿态：目标目录在磁盘上（历史坏安装残留）但未注册进 libraries/config，
    // confirm 应清掉残留继续安装，而不是把用户卡在「装不上又删不掉」
    const orphanDir = path.join(configRoot, 'skills', 'preview-preview-repo');
    await fs.mkdir(orphanDir, { recursive: true });
    await fs.writeFile(path.join(orphanDir, 'stale.txt'), 'leftover', 'utf-8');

    const staged = await service.stageRepository(
      'https://www.modelscope.cn/skills/@preview/preview-repo',
      'Preview repository'
    );
    expect(staged.success).toBe(true);

    const confirmed = await service.confirmStagedRepository(staged.stageId!);
    expect(confirmed.success).toBe(true);
    expect(service.getLocalLibraries()).toHaveLength(1);
    // 残留内容被替换，不残存旧文件
    await expect(fs.access(path.join(orphanDir, 'stale.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(orphanDir, 'SKILL.md'))).resolves.toBeUndefined();
  });

  it('cancels staged content without changing installed state or config', async () => {
    const staged = await service.stageRepository(
      'https://github.com/preview/cancel-repo'
    );
    expect(staged.success).toBe(true);

    await service.cancelStagedRepository(staged.stageId!);

    expect(service.getLocalLibraries()).toEqual([]);
    await expect(
      fs.access(path.join(configRoot, 'skills', '.staging', staged.stageId!))
    ).rejects.toThrow();
    await expect(fs.access(path.join(configRoot, 'skill-config.json'))).rejects.toThrow();
  });
});
