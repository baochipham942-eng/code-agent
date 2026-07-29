import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

const env = vi.hoisted(() => ({
  handler: undefined as undefined | ((event: unknown, request: IPCRequest) => Promise<IPCResponse>),
  promoteToCloudSpace: vi.fn(),
  createInvite: vi.fn(),
  revokeInvite: vi.fn(),
  redeemInvite: vi.fn(),
  listMembers: vi.fn(),
}));

vi.mock('../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({}),
}));

vi.mock('../../../src/host/services/project/projectCollaborationService', () => {
  class ProjectCollaborationError extends Error {
    constructor(readonly code: string, message = 'safe public message') {
      super(message);
      this.name = 'ProjectCollaborationError';
    }
  }
  return {
    ProjectCollaborationError,
    getProjectCollaborationService: () => ({
      promoteToCloudSpace: env.promoteToCloudSpace,
      createInvite: env.createInvite,
      revokeInvite: env.revokeInvite,
      redeemInvite: env.redeemInvite,
      listMembers: env.listMembers,
    }),
  };
});

vi.mock('../../../src/host/services/core/repositories/ArtifactIssueRepository', () => ({
  getArtifactIssueRepository: () => null,
}));

vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getProjectSourceGitStates: vi.fn(),
}));

import { registerProjectHandlers } from '../../../src/host/ipc/project.ipc';
import { ProjectCollaborationError } from '../../../src/host/services/project/projectCollaborationService';

async function call(action: string, payload?: unknown): Promise<IPCResponse> {
  return env.handler!(null, { action, payload });
}

describe('project collaboration IPC actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.handler = undefined;
    registerProjectHandlers({
      handle: vi.fn((_channel, handler) => {
        env.handler = handler;
      }),
    } as never);
  });

  it('routes promote, create, redeem, revoke, and member listing through the project domain', async () => {
    env.promoteToCloudSpace.mockResolvedValue({ cloudProjectId: 'cloud-1' });
    env.createInvite.mockResolvedValue({ code: 'invite-1' });
    env.redeemInvite.mockResolvedValue({ localProjectId: 'proj-2' });
    env.revokeInvite.mockResolvedValue({ revoked: true });
    env.listMembers.mockResolvedValue([{ userId: 'user-1' }]);

    await expect(call('promoteToCloudSpace', { projectId: ' proj-1 ' }))
      .resolves.toMatchObject({ success: true, data: { cloudProjectId: 'cloud-1' } });
    await expect(call('createInvite', {
      projectId: ' proj-1 ',
      expiresInHours: 24,
      maxUses: 2,
    })).resolves.toMatchObject({ success: true, data: { code: 'invite-1' } });
    await expect(call('redeemInvite', { code: ' code-1 ' }))
      .resolves.toMatchObject({ success: true, data: { localProjectId: 'proj-2' } });
    await expect(call('revokeInvite', { code: ' code-1 ' }))
      .resolves.toMatchObject({ success: true, data: { revoked: true } });
    await expect(call('listMembers', { projectId: ' proj-1 ' }))
      .resolves.toMatchObject({ success: true, data: [{ userId: 'user-1' }] });

    expect(env.promoteToCloudSpace).toHaveBeenCalledWith('proj-1');
    expect(env.createInvite).toHaveBeenCalledWith('proj-1', {
      expiresInHours: 24,
      maxUses: 2,
    });
    expect(env.redeemInvite).toHaveBeenCalledWith('code-1');
    expect(env.revokeInvite).toHaveBeenCalledWith('code-1');
    expect(env.listMembers).toHaveBeenCalledWith('proj-1');
  });

  it('returns a stable collaboration code and never leaks the internal cause', async () => {
    env.redeemInvite.mockRejectedValue(
      new ProjectCollaborationError('COLLAB_INVITE_EXPIRED', '邀请码已过期。'),
    );

    await expect(call('redeemInvite', { code: 'secret-code' })).resolves.toEqual({
      success: false,
      error: {
        code: 'COLLAB_INVITE_EXPIRED',
        message: '邀请码已过期。',
      },
    });
  });

  it('rejects invalid collaboration payloads before reaching the service', async () => {
    await expect(call('createInvite', {
      projectId: 'proj-1',
      expiresInHours: '24',
      maxUses: 2,
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGS' },
    });
    await expect(call('redeemInvite', { code: '   ' })).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGS' },
    });
    expect(env.createInvite).not.toHaveBeenCalled();
    expect(env.redeemInvite).not.toHaveBeenCalled();
  });
});
