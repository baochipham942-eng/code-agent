// ============================================================================
// 懒开目录与 Project 铸造的边界（N-DELIVERABLE-WORKDIR-LAZY）
//
// 真实运行实测的回归钉：无文件夹会话首轮只规划目录不落盘，回写 workingDirectory 时
// ensureProjectForWorkspace 若把「还不存在的目录」铸成 trusted Source（null identity），
// 目录一旦落盘，getWorkspaceScope 按 identity_changed 硬拒，该会话之后每一轮都 500。
// 这里钉三件事：
// - 目录不存在 → 不铸造，落未分类；
// - 目录落盘后再来认领 → 铸造带真实 identity 的 trusted Source，getWorkspaceScope 通过；
// - 已铸造过的项目目录后来被删 → 仍返回既有项目（existing 查找先于缺目录守卫）。
// ============================================================================
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectSource } from '../../../../src/shared/contract/project';
import { UNSORTED_PROJECT_ID } from '../../../../src/shared/contract/project';
import type { ProjectRepository } from '../../../../src/host/services/core/repositories';
import { ProjectService } from '../../../../src/host/services/project/projectService';

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => {
    throw new Error('getDatabase must not be reached in this test (repo injected)');
  },
}));

/** 最小内存 repo：只实现 ensureProjectForWorkspace / getWorkspaceScope 触达的面。 */
function makeFakeRepo() {
  const projects = new Map<string, Project>();
  const sources = new Map<string, ProjectSource[]>();
  const repo = {
    getProject: vi.fn((id: string) => projects.get(id) ?? null),
    upsertProject: vi.fn((project: Project) => {
      projects.set(project.id, project);
    }),
    getProjectByWorkspaceKey: vi.fn((key: string) =>
      [...projects.values()].find((project) => project.workspaceKey === key) ?? null),
    listSources: vi.fn((projectId: string) => sources.get(projectId) ?? []),
    upsertSource: vi.fn((source: ProjectSource) => {
      const list = sources.get(source.projectId) ?? [];
      const index = list.findIndex((entry) => entry.id === source.id);
      if (index >= 0) list[index] = source;
      else list.push(source);
      sources.set(source.projectId, list);
    }),
    backfillProjectSources: vi.fn(() => 0),
    assignSessionProject: vi.fn(),
  };
  return { repo, projects, sources };
}

describe('ProjectService.ensureProjectForWorkspace vs lazy (not-yet-materialized) dirs', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'project-service-lazy-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('defers minting while the workspace is not on disk: returns UNSORTED and stores nothing', async () => {
    const { repo, projects, sources } = makeFakeRepo();
    const service = new ProjectService(() => repo as unknown as ProjectRepository);
    const missingDir = path.join(tempRoot, '任务_1011_还没落盘');

    const project = await service.ensureProjectForWorkspace(missingDir, 1_000);

    expect(project.id).toBe(UNSORTED_PROJECT_ID);
    // 未分类行可以有，但绝不为缺失目录铸造具体项目 / trusted Source
    expect([...projects.values()].filter((row) => row.workspaceKey)).toHaveLength(0);
    expect([...sources.values()]).toHaveLength(0);
  });

  it('mints a trusted source with a real identity once the dir exists, and getWorkspaceScope passes', async () => {
    const { repo } = makeFakeRepo();
    const service = new ProjectService(() => repo as unknown as ProjectRepository);
    const dir = path.join(tempRoot, '任务_1011_已落盘');

    // 首轮（目录缺失）：未分类；目录落盘后 Materializer 再来认领
    const deferred = await service.ensureProjectForWorkspace(dir, 1_000);
    expect(deferred.id).toBe(UNSORTED_PROJECT_ID);

    mkdirSync(dir, { recursive: true });
    const adopted = await service.ensureProjectForWorkspace(dir, 2_000);
    expect(adopted.id).not.toBe(UNSORTED_PROJECT_ID);
    const [source] = repo.listSources(adopted.id);
    expect(source?.trustState).toBe('trusted');
    expect(source?.identityIno).toBeTruthy();

    // 真实运行炸点：目录存在 + 真实 identity → 派生 scope 不得抛 ProjectSourceTrustError
    const scope = service.getWorkspaceScope(adopted.id);
    expect(scope?.primaryRoot).toBe(realpathSync(dir));

    // 幂等：再认领是同一份项目
    const again = await service.ensureProjectForWorkspace(dir, 3_000);
    expect(again.id).toBe(adopted.id);
  });

  it('still returns an existing project whose folder has since been deleted (existing lookup first)', async () => {
    const { repo } = makeFakeRepo();
    const service = new ProjectService(() => repo as unknown as ProjectRepository);
    const dir = path.join(tempRoot, '任务_1011_后被删除');
    mkdirSync(dir, { recursive: true });
    const minted = await service.ensureProjectForWorkspace(dir, 1_000);
    expect(minted.id).not.toBe(UNSORTED_PROJECT_ID);

    rmSync(dir, { recursive: true, force: true });
    const returned = await service.ensureProjectForWorkspace(dir, 2_000);
    expect(returned.id).toBe(minted.id);
  });
});
