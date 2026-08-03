// 批P 第六波①a「创建即信任」：createSpace / promoteToSpace 的 folder-trust 门。
// 隔离手法对齐 folderTrustService.test.ts：临时 CODE_AGENT_DATA_DIR + 真 better-sqlite3，
// repo 用内存 fake（ProjectService 构造注入 repoProvider，不动 databaseService）。
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');

import { ProjectService } from '../../../src/host/services/project/projectService';
import {
  evaluateFolderTrust,
  resetFolderTrustServiceForTest,
} from '../../../src/host/security/folderTrustService';
import { FOLDER_TRUST_CONFIRM_REQUIRED_PREFIX } from '../../../src/shared/contract/project';
import type { Project, ProjectSource } from '../../../src/shared/contract/project';
import type { ProjectRepository } from '../../../src/host/services/core/repositories';

const NOW = 1_700_000_000_000;

function createRepoFixture() {
  const projects = new Map<string, Project>();
  const sources: ProjectSource[] = [];
  const repo = {
    getProjectByWorkspacePath: (workspacePath: string) =>
      Array.from(projects.values()).find((project) => project.workspacePath === workspacePath),
    getProject: (id: string) => projects.get(id),
    upsertProject: (project: Project) => { projects.set(project.id, project); },
    upsertSource: (source: ProjectSource) => { sources.push(source); },
    listSources: (projectId: string) => sources.filter((source) => source.projectId === projectId),
    promoteToSpace: (id: string, now: number) => {
      const project = projects.get(id);
      if (!project) return undefined;
      const promoted = { ...project, spacePromotedAt: now };
      projects.set(id, promoted);
      return promoted;
    },
  };
  return { projects, repo: repo as unknown as ProjectRepository };
}

function makeProject(id: string, workspacePath: string | null): Project {
  return {
    id,
    name: id,
    workspacePath,
    workspaceKey: workspacePath ? `key-${id}` : null,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    sourceRevision: 0,
  };
}

describe('ProjectService 创建即信任（folder-trust 门）', () => {
  let tmpRoot: string;
  let cleanDir: string;
  let dangerousDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-service-trust-'));
    cleanDir = path.join(tmpRoot, 'clean');
    dangerousDir = path.join(tmpRoot, 'dangerous');
    await fs.mkdir(path.join(dangerousDir, '.code-agent', 'hooks'), { recursive: true });
    await fs.mkdir(cleanDir, { recursive: true });
    // 真实评估能稳定扫出的危险项：项目 hooks
    await fs.writeFile(path.join(dangerousDir, '.code-agent', 'hooks', 'hooks.json'), '{"PreToolUse":[]}', 'utf-8');
    vi.stubEnv('CODE_AGENT_TEST_DEFAULT_FOLDER_TRUST', '');
    vi.stubEnv('CODE_AGENT_DATA_DIR', path.join(tmpRoot, 'data'));
    resetFolderTrustServiceForTest();
  });

  afterEach(async () => {
    resetFolderTrustServiceForTest();
    vi.unstubAllEnvs();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('createSpace 干净目录：创建成功且 folder_trust 静默落库为 trusted', async () => {
    const { projects, repo } = createRepoFixture();
    const svc = new ProjectService(() => repo);

    const created = await svc.createSpace({ name: '干净空间', workspacePath: cleanDir }, NOW);

    expect(created.spacePromotedAt).toBe(NOW);
    expect(projects.size).toBe(1);
    expect((await evaluateFolderTrust(cleanDir)).state).toBe('trusted');
  });

  it('createSpace 危险目录无 ack：抛 coded 错、未创建、未落库', async () => {
    const { projects, repo } = createRepoFixture();
    const svc = new ProjectService(() => repo);

    await expect(svc.createSpace({ name: '危险空间', workspacePath: dangerousDir }, NOW))
      .rejects.toThrow(FOLDER_TRUST_CONFIRM_REQUIRED_PREFIX);

    expect(projects.size).toBe(0);
    expect((await evaluateFolderTrust(dangerousDir)).state).toBe('untrusted');
  });

  it('createSpace 危险目录带 ack：创建成功且已信任', async () => {
    const { projects, repo } = createRepoFixture();
    const svc = new ProjectService(() => repo);

    const created = await svc.createSpace(
      { name: '危险空间', workspacePath: dangerousDir, trustAcknowledged: true },
      NOW,
    );

    expect(created.workspacePath).toBeTruthy();
    expect(projects.size).toBe(1);
    expect((await evaluateFolderTrust(dangerousDir)).state).toBe('trusted');
  });

  it('createSpace 撞已有项目的早退分支同样过门：危险目录无 ack 抛错不升级', async () => {
    const { projects, repo } = createRepoFixture();
    const existing = makeProject('proj_existing', await fs.realpath(dangerousDir));
    projects.set(existing.id, existing);
    const svc = new ProjectService(() => repo);

    await expect(svc.createSpace({ name: '撞名空间', workspacePath: dangerousDir }, NOW))
      .rejects.toThrow(FOLDER_TRUST_CONFIRM_REQUIRED_PREFIX);
    expect(projects.get(existing.id)?.spacePromotedAt).toBeUndefined();

    const promoted = await svc.createSpace(
      { name: '撞名空间', workspacePath: dangerousDir, trustAcknowledged: true },
      NOW,
    );
    expect(promoted.id).toBe(existing.id);
    expect(promoted.spacePromotedAt).toBe(NOW);
    expect((await evaluateFolderTrust(dangerousDir)).state).toBe('trusted');
  });

  it('promoteToSpace 带 workspacePath：升级成功且目录已信任', async () => {
    const { projects, repo } = createRepoFixture();
    const project = makeProject('proj_promote', await fs.realpath(cleanDir));
    projects.set(project.id, project);
    const svc = new ProjectService(() => repo);

    const promoted = await svc.promoteToSpace(project.id, NOW);

    expect(promoted?.spacePromotedAt).toBe(NOW);
    expect((await evaluateFolderTrust(cleanDir)).state).toBe('trusted');
  });

  it('promoteToSpace 危险目录无 ack：抛 coded 错、未升级、未落库', async () => {
    const { projects, repo } = createRepoFixture();
    const project = makeProject('proj_promote_danger', await fs.realpath(dangerousDir));
    projects.set(project.id, project);
    const svc = new ProjectService(() => repo);

    await expect(svc.promoteToSpace(project.id, NOW))
      .rejects.toThrow(FOLDER_TRUST_CONFIRM_REQUIRED_PREFIX);

    expect(projects.get(project.id)?.spacePromotedAt).toBeUndefined();
    expect((await evaluateFolderTrust(dangerousDir)).state).toBe('untrusted');
  });

  it('promoteToSpace 无目录项目：无授权面，直接升级不触碰 folder_trust', async () => {
    const { projects, repo } = createRepoFixture();
    const project = makeProject('proj_promote_no_dir', null);
    projects.set(project.id, project);
    const svc = new ProjectService(() => repo);

    const promoted = await svc.promoteToSpace(project.id, NOW);

    expect(promoted?.spacePromotedAt).toBe(NOW);
  });
});
