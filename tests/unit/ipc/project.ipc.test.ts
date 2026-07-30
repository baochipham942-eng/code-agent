import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { UNSORTED_PROJECT_ID } from '../../../src/shared/contract/project';

const svc = vi.hoisted(() => ({
  listProjects: vi.fn(() => []),
  listProjectsWithActivity: vi.fn(() => []),
  createSpace: vi.fn(async () => ({ id: 'proj_space' })),
  promoteToSpace: vi.fn(() => ({ id: 'proj_space' })),
}));

vi.mock('../../../src/host/services/project/projectService', () => ({
  getProjectService: () => svc,
}));
vi.mock('../../../src/host/services/core/repositories/ArtifactIssueRepository', () => ({
  getArtifactIssueRepository: () => null,
}));
vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getProjectSourceGitStates: vi.fn(async () => []),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerProjectHandlers } from '../../../src/host/ipc/project.ipc';

type HandlerFn = (event: unknown, request: {
  domain: string;
  action: string;
  payload?: unknown;
}) => unknown;

function register() {
  const handlers = new Map<string, HandlerFn>();
  registerProjectHandlers({
    handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler),
  } as never);
  return (action: string, payload?: unknown) => handlers.get(IPC_DOMAINS.PROJECT)!(null, {
    domain: IPC_DOMAINS.PROJECT,
    action,
    payload,
  });
}

let call: ReturnType<typeof register>;

beforeEach(() => {
  vi.clearAllMocks();
  svc.listProjectsWithActivity.mockReturnValue([]);
  svc.createSpace.mockResolvedValue({ id: 'proj_space' });
  svc.promoteToSpace.mockReturnValue({ id: 'proj_space' });
  call = register();
});

describe('project space IPC', () => {
  it('listWithActivity 透传 spacesOnly', async () => {
    await call('listWithActivity', { includeArchived: true, spacesOnly: true });
    expect(svc.listProjectsWithActivity).toHaveBeenCalledWith(true, true);
  });

  it('createSpace 透传显式空间输入', async () => {
    await expect(call('createSpace', {
      name: '  Alpha  ',
      description: 'desc',
      workspacePath: '/work/alpha',
    })).resolves.toEqual({ success: true, data: { id: 'proj_space' } });
    expect(svc.createSpace).toHaveBeenCalledWith({
      name: 'Alpha',
      description: 'desc',
      workspacePath: '/work/alpha',
    }, expect.any(Number));
  });

  it('promoteToSpace 对 UNSORTED 返回 INVALID_ARGS', async () => {
    await expect(call('promoteToSpace', {
      projectId: UNSORTED_PROJECT_ID,
    })).resolves.toEqual({
      success: false,
      error: {
        code: 'INVALID_ARGS',
        message: 'the unsorted project cannot be promoted to a space',
      },
    });
    expect(svc.promoteToSpace).not.toHaveBeenCalled();
  });
});
