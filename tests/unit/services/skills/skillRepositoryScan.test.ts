// ============================================================================
// scanLocalLibraries per-library 隔离测试
// 单个坏库（layout 探测失败）只 warn 跳过，不中止其余库的扫描
// ============================================================================

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

import {
  getSkillRepositoryService,
  resetSkillRepositoryService,
} from '../../../../src/host/services/skills/skillRepositoryService';

function repoMeta(owner: string, repo: string): string {
  return JSON.stringify({
    source: 'github',
    owner,
    repo,
    branch: 'main',
    commitHash: 'deadbeef',
    downloadedAt: Date.now(),
    lastUpdated: Date.now(),
  });
}

describe('scanLocalLibraries per-library isolation', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-repo-scan-'));
    vi.stubEnv('CODE_AGENT_DATA_DIR', tmpRoot);
    // 模块加载时 serviceRegistry.register 会立即构造单例（当时 env 尚未打桩），
    // 必须 reset 让下次 getSkillRepositoryService() 用桩后的 CODE_AGENT_DATA_DIR 重建。
    resetSkillRepositoryService();
  });

  afterEach(async () => {
    resetSkillRepositoryService();
    vi.unstubAllEnvs();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('skips a broken library and still loads the healthy ones', async () => {
    const skillsDir = path.join(tmpRoot, 'skills');

    // 坏库：有元数据但全库没有任何 SKILL.md，detectRepositoryLayout 抛错
    const badLib = path.join(skillsDir, 'bad-lib');
    await fs.mkdir(badLib, { recursive: true });
    await fs.writeFile(path.join(badLib, '.meta.json'), repoMeta('acme', 'bad'), 'utf-8');

    // 好库：single-skill 布局，且 SKILL.md 不声明 depends/provides（走默认值）
    const goodLib = path.join(skillsDir, 'good-lib');
    await fs.mkdir(goodLib, { recursive: true });
    await fs.writeFile(path.join(goodLib, '.meta.json'), repoMeta('acme', 'good'), 'utf-8');
    await fs.writeFile(
      path.join(goodLib, 'SKILL.md'),
      ['---', 'name: good-skill', 'description: A healthy skill', '---', '', 'Body.'].join('\n'),
      'utf-8',
    );

    const service = getSkillRepositoryService();
    await service.initialize();

    const libraries = service.getLocalLibraries();
    expect(libraries.map((lib) => lib.repoId).sort()).toEqual(['good-lib']);
    expect(libraries[0]?.skills.map((skill) => skill.name)).toEqual(['good-skill']);
  });
});
