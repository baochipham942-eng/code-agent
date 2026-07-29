import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  Project,
  ProjectSource,
} from '../../../src/shared/contract/project';
import { getProjectKey } from '../../../src/host/services/roleAssets/roleAssetPaths';

const databaseState = vi.hoisted(() => ({
  projectRepo: undefined as unknown,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getProjectRepo: () => databaseState.projectRepo,
  }),
}));

vi.mock('../../../src/host/services/roleAssets/roleAssetService', () => ({
  linkProjectIdToMeta: vi.fn().mockResolvedValue(undefined),
}));

import { ProjectService } from '../../../src/host/services/project/projectService';

const NOW = 1_700_000_000_000;

interface FakeRepo {
  projects: Map<string, Project>;
  sources: ProjectSource[];
}

function createFakeRepo(): FakeRepo & Record<string, unknown> {
  const state: FakeRepo = {
    projects: new Map(),
    sources: [],
  };
  return {
    ...state,
    getProject: (id: string) => state.projects.get(id),
    getProjectByWorkspaceKey: (key: string) =>
      Array.from(state.projects.values()).find((project) => project.workspaceKey === key),
    upsertProject: (project: Project) => {
      state.projects.set(project.id, project);
    },
    upsertSource: (source: ProjectSource) => {
      state.sources.push(source);
    },
    listSources: (projectId: string) => state.sources.filter((source) => source.projectId === projectId),
    backfillProjectSources: () => 0,
    renameProject: (projectId: string, name: string, now: number) => {
      const project = state.projects.get(projectId);
      if (project) state.projects.set(projectId, { ...project, name, updatedAt: now });
    },
    setProjectDescription: (projectId: string, description: string | null, now: number) => {
      const project = state.projects.get(projectId);
      if (project) state.projects.set(projectId, { ...project, description: description ?? undefined, updatedAt: now });
    },
  };
}

describe('ProjectService.createProject', () => {
  it('creates a new project with the explicit name overriding the directory basename', async () => {
    databaseState.projectRepo = createFakeRepo();
    const service = new ProjectService();

    const project = await service.createProject(
      { name: '我的项目', workspacePath: '/tmp/neo-create-project/work' },
      NOW,
    );

    expect(project.name).toBe('我的项目');
    expect(project.workspaceKey).toBe(getProjectKey('/tmp/neo-create-project/work'));
    expect(project.workspacePath).toBeTruthy();
    const repo = databaseState.projectRepo as ReturnType<typeof createFakeRepo>;
    const sources = (repo.listSources as (id: string) => ProjectSource[])(project.id);
    expect(sources).toHaveLength(1);
    expect(sources[0].role).toBe('primary');
  });

  it('is idempotent for an already-bound workspace and applies the explicit name', async () => {
    databaseState.projectRepo = createFakeRepo();
    const service = new ProjectService();
    const dir = '/tmp/neo-create-project/work';

    const first = await service.createProject({ name: '第一个名字', workspacePath: dir }, NOW);
    const second = await service.createProject({ name: '改名了', workspacePath: dir }, NOW + 1);

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('改名了');
    const repo = databaseState.projectRepo as ReturnType<typeof createFakeRepo>;
    const sources = (repo.listSources as (id: string) => ProjectSource[])(first.id);
    expect(sources).toHaveLength(1);
  });

  it('rejects a blank name', async () => {
    databaseState.projectRepo = createFakeRepo();
    const service = new ProjectService();

    await expect(
      service.createProject({ name: '   ', workspacePath: '/tmp/neo-create-project/work' }, NOW),
    ).rejects.toThrow('Project name is required.');
  });

  it('creates a workspace-less container project when no workspacePath is given', async () => {
    databaseState.projectRepo = createFakeRepo();
    const service = new ProjectService();

    const project = await service.createProject({ name: '纯容器' }, NOW);

    expect(project.name).toBe('纯容器');
    expect(project.workspacePath).toBeNull();
    expect(project.workspaceKey).toBeNull();
  });
});
