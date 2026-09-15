import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// project.ipc.ts 派发特征测试（RQ-183 续作·PROJECT 刀迁表前钉住现状）：既有 project.ipc.test.ts /
// projectCollaboration.ipc.test.ts 只覆盖 10 个 action，这里补齐其余 23 个 action 的参数校验 /
// INVALID_ARGS / NOT_FOUND 分支与委派参数，以及未知 action 的 UNKNOWN_ACTION 'Unknown project action:'
// 契约和抛错兜底（ProjectCollaborationError code 透传、Error → PROJECT_ERROR + message、非 Error →
// 'Unknown error'，均记日志）。迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  handler: undefined as undefined | ((event: unknown, request: IPCRequest) => Promise<IPCResponse>),
  logError: vi.fn(),
  svc: {
    listProjects: vi.fn(),
    listCapabilitySelections: vi.fn(),
    selectCapability: vi.fn(),
    unselectCapability: vi.fn(),
    createProject: vi.fn(),
    getProjectDetail: vi.fn(),
    listSources: vi.fn(),
    getWorkspaceScope: vi.fn(),
    updateProject: vi.fn(),
    getProjectArtifacts: vi.fn(),
    renameProject: vi.fn(),
    setProjectDescription: vi.fn(),
    setProjectStatus: vi.fn(),
    deleteProject: vi.fn(),
    addGoal: vi.fn(),
    updateGoalStatus: vi.fn(),
    addRole: vi.fn(),
    removeRole: vi.fn(),
  },
  gitStates: vi.fn(),
  issueRepo: null as null | { listIssues: ReturnType<typeof vi.fn> },
}));

vi.mock('../../../src/host/services/project/projectService', () => ({ getProjectService: () => h.svc }));
vi.mock('../../../src/host/services/project/collabCardSyncService', () => ({
  getCollabCardSyncService: () => ({ resyncProjectCards: vi.fn() }),
}));
vi.mock('../../../src/host/services/project/projectCollaborationService', () => {
  class ProjectCollaborationError extends Error {
    constructor(readonly code: string) {
      super(`collab:${code}`);
      this.name = 'ProjectCollaborationError';
    }
  }
  return { ProjectCollaborationError, getProjectCollaborationService: () => ({}) };
});
vi.mock('../../../src/host/services/core/repositories/ArtifactIssueRepository', () => ({
  getArtifactIssueRepository: () => h.issueRepo,
}));
vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getProjectSourceGitStates: (...a: unknown[]) => h.gitStates(...a),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() }),
}));

import { registerProjectHandlers } from '../../../src/host/ipc/project.ipc';
import { ProjectCollaborationError } from '../../../src/host/services/project/projectCollaborationService';

const call = (action: string, payload?: unknown) => h.handler!(null, { action, payload } as IPCRequest);
const invalid = (message: string) => ({ success: false, error: { code: 'INVALID_ARGS', message } });
const notFound = (message: string) => ({ success: false, error: { code: 'NOT_FOUND', message } });
const NOW = expect.any(Number);

beforeEach(() => {
  vi.clearAllMocks();
  h.issueRepo = null;
  h.handler = undefined;
  registerProjectHandlers({
    handle: (channel: string, fn: typeof h.handler) => {
      if (channel === IPC_DOMAINS.PROJECT) h.handler = fn;
    },
  } as never);
});

describe('project.ipc dispatch 特征：列表 / 详情 / 创建', () => {
  it('list：includeArchived 转布尔，缺 payload 按 false', async () => {
    h.svc.listProjects.mockReturnValue([{ id: 'p1' }]);
    expect(await call('list', { includeArchived: 1 })).toEqual({ success: true, data: [{ id: 'p1' }] });
    expect(h.svc.listProjects).toHaveBeenLastCalledWith(true);
    await call('list');
    expect(h.svc.listProjects).toHaveBeenLastCalledWith(false);
  });

  it('create：name 必填并 trim；workspacePath / description 非字符串分别降为 null / undefined', async () => {
    expect(await call('create', { name: '  ' })).toEqual(invalid('name is required'));
    h.svc.createProject.mockResolvedValue({ id: 'p2' });
    expect(await call('create', { name: ' 新项目 ', workspacePath: 42, description: 7 })).toEqual({ success: true, data: { id: 'p2' } });
    expect(h.svc.createProject).toHaveBeenLastCalledWith({ name: '新项目', workspacePath: null, description: undefined }, NOW);
    await call('create', { name: 'x', workspacePath: '/w', description: 'd' });
    expect(h.svc.createProject).toHaveBeenLastCalledWith({ name: 'x', workspacePath: '/w', description: 'd' }, NOW);
  });

  it('detail / sources：缺 projectId → INVALID_ARGS；detail 为空 → NOT_FOUND', async () => {
    expect(await call('detail', {})).toEqual(invalid('projectId is required'));
    h.svc.getProjectDetail.mockReturnValueOnce(null);
    expect(await call('detail', { projectId: 'p1' })).toEqual(notFound('project not found'));
    h.svc.getProjectDetail.mockReturnValueOnce({ project: { id: 'p1' } });
    expect(await call('detail', { projectId: 'p1' })).toEqual({ success: true, data: { project: { id: 'p1' } } });
    expect(await call('sources')).toEqual(invalid('projectId is required'));
    h.svc.listSources.mockReturnValue([{ id: 's1' }]);
    expect(await call('sources', { projectId: 'p1' })).toEqual({ success: true, data: [{ id: 's1' }] });
  });

  it('gitStates：无 workspace scope → 空数组且不查 git；有 scope → 透传 git 状态', async () => {
    expect(await call('gitStates', {})).toEqual(invalid('projectId is required'));
    h.svc.getWorkspaceScope.mockReturnValueOnce(null);
    expect(await call('gitStates', { projectId: 'p1' })).toEqual({ success: true, data: [] });
    expect(h.gitStates).not.toHaveBeenCalled();
    h.svc.getWorkspaceScope.mockReturnValueOnce({ roots: ['/w'] });
    h.gitStates.mockResolvedValueOnce([{ path: '/w', dirty: true }]);
    expect(await call('gitStates', { projectId: 'p1' })).toEqual({ success: true, data: [{ path: '/w', dirty: true }] });
    expect(h.gitStates).toHaveBeenCalledWith({ roots: ['/w'] });
  });

  it('artifacts：limit 只认数字', async () => {
    expect(await call('artifacts', {})).toEqual(invalid('projectId is required'));
    h.svc.getProjectArtifacts.mockReturnValue([]);
    await call('artifacts', { projectId: 'p1', limit: '5' });
    expect(h.svc.getProjectArtifacts).toHaveBeenLastCalledWith('p1', undefined);
    await call('artifacts', { projectId: 'p1', limit: 5 });
    expect(h.svc.getProjectArtifacts).toHaveBeenLastCalledWith('p1', 5);
  });

  it('artifactIssues：id 去重去空；无 repo → {}；每 artifact limit 钳制到 [1,50]、缺省 20', async () => {
    expect(await call('artifactIssues', { artifactIds: ['', '  ', 3] })).toEqual(invalid('artifactIds is required'));
    expect(await call('artifactIssues', { artifactIds: ['a1'] })).toEqual({ success: true, data: {} });
    h.issueRepo = { listIssues: vi.fn(({ artifactId }: { artifactId: string }) => [{ artifactId }]) };
    expect(await call('artifactIssues', { artifactIds: ['a1', 'a1', 'a2'], status: 'open', limit: 999 }))
      .toEqual({ success: true, data: { a1: [{ artifactId: 'a1' }], a2: [{ artifactId: 'a2' }] } });
    expect(h.issueRepo.listIssues).toHaveBeenCalledTimes(2);
    expect(h.issueRepo.listIssues).toHaveBeenLastCalledWith({ artifactId: 'a2', status: 'open', limit: 50 });
    await call('artifactIssues', { artifactIds: ['a3'], limit: 0 });
    expect(h.issueRepo.listIssues).toHaveBeenLastCalledWith({ artifactId: 'a3', status: undefined, limit: 1 });
    await call('artifactIssues', { artifactIds: ['a4'] });
    expect(h.issueRepo.listIssues).toHaveBeenLastCalledWith({ artifactId: 'a4', status: undefined, limit: 20 });
  });
});

describe('project.ipc dispatch 特征：能力选择', () => {
  it('listCapabilitySelections：缺/空白 projectId → INVALID_ARGS；null → NOT_FOUND', async () => {
    expect(await call('listCapabilitySelections', { projectId: ' ' })).toEqual(invalid('projectId is required'));
    h.svc.listCapabilitySelections.mockReturnValueOnce(null);
    expect(await call('listCapabilitySelections', { projectId: 'p1' })).toEqual(notFound('project not found'));
    h.svc.listCapabilitySelections.mockReturnValueOnce([{ capabilityId: 'c1' }]);
    expect(await call('listCapabilitySelections', { projectId: 'p1' })).toEqual({ success: true, data: [{ capabilityId: 'c1' }] });
  });

  it('selectCapability / unselectCapability：只接受 connector，参数 trim；服务 null → NOT_FOUND', async () => {
    expect(await call('selectCapability', { projectId: 'p1' })).toEqual(invalid('projectId and capabilityId are required'));
    expect(await call('unselectCapability', { projectId: 'p1', capabilityId: 'c1', kind: 'skill' }))
      .toEqual(invalid('kind must be connector; skills and automations use their existing project models'));
    h.svc.selectCapability.mockReturnValueOnce({ id: 'sel' });
    expect(await call('selectCapability', { projectId: ' p1 ', capabilityId: ' c1 ', kind: 'connector' })).toEqual({ success: true, data: { id: 'sel' } });
    expect(h.svc.selectCapability).toHaveBeenCalledWith('p1', 'connector', 'c1', NOW);
    h.svc.unselectCapability.mockReturnValueOnce(null);
    expect(await call('unselectCapability', { projectId: 'p1', capabilityId: 'c1', kind: 'connector' })).toEqual(notFound('project not found'));
  });
});

describe('project.ipc dispatch 特征：更新与来源变更', () => {
  const detail = {
    project: { name: 'P', description: 'D' },
    sources: [
      { id: 's1', path: '/a', role: 'primary', access: 'read_write', trustState: 'trusted', extra: 1 },
      { id: 's2', path: '/b', role: 'additional', access: 'read_only', trustState: 'trusted' },
    ],
  };

  it('updateProject：四个必填缺一 → INVALID_ARGS；服务 null → NOT_FOUND；成功透传', async () => {
    expect(await call('updateProject', { projectId: 'p1', revision: '1', name: 'n', sources: [] }))
      .toEqual(invalid('projectId, revision, name and sources are required'));
    h.svc.updateProject.mockResolvedValueOnce(null);
    expect(await call('updateProject', { projectId: 'p1', revision: 1, name: 'n', sources: [] })).toEqual(notFound('project not found'));
    h.svc.updateProject.mockResolvedValueOnce({ id: 'p1' });
    expect(await call('updateProject', { projectId: 'p1', revision: 1, name: 'n', sources: [] })).toEqual({ success: true, data: { id: 'p1' } });
    expect(h.svc.updateProject).toHaveBeenLastCalledWith({ projectId: 'p1', revision: 1, name: 'n', sources: [] }, NOW);
  });

  it('来源变更公共前置：缺 revision → INVALID_ARGS；详情不存在 → NOT_FOUND', async () => {
    for (const action of ['addSource', 'updateSourceAccess', 'setPrimarySource', 'removeSource']) {
      expect(await call(action, { projectId: 'p1' })).toEqual(invalid('projectId and revision are required'));
    }
    h.svc.getProjectDetail.mockReturnValueOnce(null);
    expect(await call('removeSource', { projectId: 'p1', revision: 1, sourceId: 's2' })).toEqual(notFound('project not found'));
  });

  it('addSource：缺 path → INVALID_ARGS；追加 additional/read_only 并以详情 name/description 更新', async () => {
    h.svc.getProjectDetail.mockReturnValue(detail);
    expect(await call('addSource', { projectId: 'p1', revision: 3 })).toEqual(invalid('path is required'));
    h.svc.updateProject.mockResolvedValueOnce({ id: 'p1' });
    expect(await call('addSource', { projectId: 'p1', revision: 3, path: '/c' })).toEqual({ success: true, data: { id: 'p1' } });
    expect(h.svc.updateProject).toHaveBeenLastCalledWith({
      projectId: 'p1',
      revision: 3,
      name: 'P',
      description: 'D',
      sources: [
        { id: 's1', path: '/a', role: 'primary', access: 'read_write', trustState: 'trusted' },
        { id: 's2', path: '/b', role: 'additional', access: 'read_only', trustState: 'trusted' },
        { path: '/c', role: 'additional', access: 'read_only' },
      ],
    }, NOW);
  });

  it('updateSourceAccess：缺 sourceId / 找不到 / access 非法 / primary 降级各自报错；合法则改 access', async () => {
    h.svc.getProjectDetail.mockReturnValue(detail);
    expect(await call('updateSourceAccess', { projectId: 'p1', revision: 1 })).toEqual(invalid('sourceId is required'));
    expect(await call('updateSourceAccess', { projectId: 'p1', revision: 1, sourceId: 'zz' })).toEqual(notFound('source not found'));
    expect(await call('updateSourceAccess', { projectId: 'p1', revision: 1, sourceId: 's2', access: 'admin' })).toEqual(invalid('access is required'));
    expect(await call('updateSourceAccess', { projectId: 'p1', revision: 1, sourceId: 's1', access: 'read_only' }))
      .toEqual(invalid('Primary source must remain read_write'));
    h.svc.updateProject.mockResolvedValueOnce(null);
    expect(await call('updateSourceAccess', { projectId: 'p1', revision: 1, sourceId: 's2', access: 'read_write' })).toEqual(notFound('project not found'));
    expect(h.svc.updateProject.mock.lastCall![0].sources[1]).toEqual({ id: 's2', path: '/b', role: 'additional', access: 'read_write', trustState: 'trusted' });
  });

  it('setPrimarySource：目标变 primary/read_write，其余降 additional 保留原 access', async () => {
    h.svc.getProjectDetail.mockReturnValue(detail);
    h.svc.updateProject.mockResolvedValueOnce({ id: 'p1' });
    await call('setPrimarySource', { projectId: 'p1', revision: 1, sourceId: 's2' });
    expect(h.svc.updateProject.mock.lastCall![0].sources).toEqual([
      { id: 's1', path: '/a', role: 'additional', access: 'read_write', trustState: 'trusted' },
      { id: 's2', path: '/b', role: 'primary', access: 'read_write', trustState: 'trusted' },
    ]);
  });

  it('removeSource：primary 不可删；删除 additional', async () => {
    h.svc.getProjectDetail.mockReturnValue(detail);
    expect(await call('removeSource', { projectId: 'p1', revision: 1, sourceId: 's1' })).toEqual(invalid('Primary source cannot be removed'));
    h.svc.updateProject.mockResolvedValueOnce({ id: 'p1' });
    await call('removeSource', { projectId: 'p1', revision: 1, sourceId: 's2' });
    expect(h.svc.updateProject.mock.lastCall![0].sources).toEqual([
      { id: 's1', path: '/a', role: 'primary', access: 'read_write', trustState: 'trusted' },
    ]);
  });
});

describe('project.ipc dispatch 特征：元数据 / 目标 / 角色', () => {
  it('rename / setDescription：参数校验、trim、description 非字符串降 null、NOT_FOUND', async () => {
    expect(await call('rename', { projectId: 'p1', name: ' ' })).toEqual(invalid('projectId and name are required'));
    h.svc.renameProject.mockReturnValueOnce(null);
    expect(await call('rename', { projectId: 'p1', name: ' 新名 ' })).toEqual(notFound('project not found'));
    expect(h.svc.renameProject).toHaveBeenCalledWith('p1', '新名', NOW);
    expect(await call('setDescription', {})).toEqual(invalid('projectId is required'));
    h.svc.setProjectDescription.mockReturnValueOnce({ id: 'p1' });
    expect(await call('setDescription', { projectId: 'p1', description: 5 })).toEqual({ success: true, data: { id: 'p1' } });
    expect(h.svc.setProjectDescription).toHaveBeenCalledWith('p1', null, NOW);
  });

  it('setStatus：只认 active|idle|archived；deleteProject 包成 { deleted }', async () => {
    expect(await call('setStatus', { projectId: 'p1', status: 'paused' })).toEqual(invalid('projectId and status (active|idle|archived) are required'));
    h.svc.setProjectStatus.mockReturnValueOnce(null);
    expect(await call('setStatus', { projectId: 'p1', status: 'idle' })).toEqual(notFound('project not found'));
    expect(await call('deleteProject', {})).toEqual(invalid('projectId is required'));
    h.svc.deleteProject.mockReturnValueOnce(true);
    expect(await call('deleteProject', { projectId: 'p1' })).toEqual({ success: true, data: { deleted: true } });
  });

  it('addGoal / updateGoalStatus：goal trim、verify/review 缺省 null、状态白名单、lastRunSessionId null → undefined', async () => {
    expect(await call('addGoal', { projectId: 'p1', goal: ' ' })).toEqual(invalid('projectId and goal are required'));
    h.svc.addGoal.mockReturnValueOnce({ id: 'g1' });
    expect(await call('addGoal', { projectId: 'p1', goal: ' 上线 ' })).toEqual({ success: true, data: { id: 'g1' } });
    expect(h.svc.addGoal).toHaveBeenCalledWith('p1', { goal: '上线', verify: null, review: null }, NOW);
    expect(await call('updateGoalStatus', { goalId: 'g1', status: 'done' })).toEqual(invalid('goalId and status (active|met|aborted|archived) are required'));
    h.svc.updateGoalStatus.mockReturnValueOnce(null);
    expect(await call('updateGoalStatus', { goalId: 'g1', status: 'met', lastRunSessionId: null })).toEqual(notFound('goal not found'));
    expect(h.svc.updateGoalStatus).toHaveBeenCalledWith('g1', 'met', NOW, undefined);
  });

  it('addRole / removeRole：roleId trim；removeRole 包成 { removed }', async () => {
    expect(await call('addRole', { projectId: 'p1' })).toEqual(invalid('projectId and roleId are required'));
    h.svc.addRole.mockReturnValueOnce(null);
    expect(await call('addRole', { projectId: 'p1', roleId: ' r1 ' })).toEqual(notFound('project not found'));
    expect(h.svc.addRole).toHaveBeenCalledWith('p1', 'r1', NOW);
    h.svc.removeRole.mockReturnValueOnce(false);
    expect(await call('removeRole', { projectId: 'p1', roleId: 'r1' })).toEqual({ success: true, data: { removed: false } });
  });
});

describe('project.ipc dispatch 特征：兜底', () => {
  it('未知 action → UNKNOWN_ACTION + Unknown project action 文案', async () => {
    expect(await call('bogus')).toEqual({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown project action: bogus' } });
  });

  it('抛错：ProjectCollaborationError code 透传；Error → PROJECT_ERROR + message；非 Error → Unknown error；均记日志', async () => {
    h.svc.listProjects.mockImplementationOnce(() => {
      throw new ProjectCollaborationError('COLLAB_INVITE_EXPIRED' as never);
    });
    expect(await call('list')).toEqual({ success: false, error: { code: 'COLLAB_INVITE_EXPIRED', message: 'collab:COLLAB_INVITE_EXPIRED' } });
    h.svc.listProjects.mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    expect(await call('list')).toEqual({ success: false, error: { code: 'PROJECT_ERROR', message: 'db locked' } });
    h.svc.listProjects.mockImplementationOnce(() => {
      throw 'boom';
    });
    expect(await call('list')).toEqual({ success: false, error: { code: 'PROJECT_ERROR', message: 'Unknown error' } });
    expect(h.logError).toHaveBeenCalledTimes(3);
    expect(h.logError).toHaveBeenCalledWith('Project IPC error', expect.any(Error));
  });
});
