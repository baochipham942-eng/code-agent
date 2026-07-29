import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectRepository } from '../../../src/host/services/core/repositories';
import type { Database as SupabaseDatabase } from '../../../src/host/services/infra/supabaseService';
import {
  ProjectCollaborationError,
  ProjectCollaborationService,
} from '../../../src/host/services/project/projectCollaborationService';
import type { AuthUser } from '../../../src/shared/contract/auth';
import type { Project } from '../../../src/shared/contract/project';

type CloudResult = {
  data: unknown;
  error: { code?: string; message?: string; details?: string } | null;
};

const NOW = 1_800_000_000_000;
const owner: AuthUser = {
  id: 'user-owner',
  email: 'owner@example.com',
  nickname: 'Owner',
  avatarUrl: 'https://example.com/avatar.png',
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-local',
    name: 'Alpha',
    workspacePath: null,
    workspaceKey: null,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    spacePromotedAt: NOW,
    sourceRevision: 0,
    ...overrides,
  };
}

function createRepo(initialProjects: Project[] = [project()]) {
  const projects = new Map(initialProjects.map((item) => [item.id, { ...item }]));
  const repo = {
    getProject: vi.fn((id: string) => projects.get(id)),
    getProjectByCloudProjectId: vi.fn((cloudProjectId: string) =>
      Array.from(projects.values()).find((item) => item.cloudProjectId === cloudProjectId)),
    setCloudProjectId: vi.fn((id: string, cloudProjectId: string, updatedAt: number) => {
      const current = projects.get(id);
      if (!current) return undefined;
      const updated = { ...current, cloudProjectId, updatedAt };
      projects.set(id, updated);
      return updated;
    }),
    upsertProject: vi.fn((item: Project) => {
      projects.set(item.id, { ...item });
    }),
  };
  return {
    projects,
    repo: repo as unknown as ProjectRepository,
    spies: repo,
  };
}

function createCloudMock() {
  const responses = new Map<string, CloudResult[]>();
  const writes: Array<{ operation: string; table: string; payload?: unknown }> = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];

  function queue(key: string, result: Partial<CloudResult>): void {
    const values = responses.get(key) ?? [];
    values.push({ data: result.data ?? null, error: result.error ?? null });
    responses.set(key, values);
  }

  function take(key: string): CloudResult {
    return responses.get(key)?.shift() ?? { data: null, error: null };
  }

  const cloud = {
    from(table: string) {
      return {
        insert(payload: unknown) {
          writes.push({ operation: 'insert', table, payload });
          return Promise.resolve(take(`insert:${table}`));
        },
        delete() {
          return {
            eq(column: string, value: unknown) {
              writes.push({
                operation: 'delete',
                table,
                payload: { [column]: value },
              });
              return Promise.resolve(take(`delete:${table}`));
            },
          };
        },
        select(columns: string) {
          return {
            eq(column: string, value: unknown) {
              return {
                order(orderColumn: string, options: unknown) {
                  writes.push({
                    operation: 'select',
                    table,
                    payload: { columns, [column]: value, orderColumn, options },
                  });
                  return Promise.resolve(take(`select:${table}`));
                },
              };
            },
          };
        },
      };
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve(take(`rpc:${name}`));
    },
  } as unknown as SupabaseClient<SupabaseDatabase>;

  return { cloud, queue, writes, rpcCalls };
}

function createFixture(options: {
  user?: AuthUser | null;
  projects?: Project[];
  cloudFactory?: () => SupabaseClient<SupabaseDatabase>;
} = {}) {
  const local = createRepo(options.projects);
  const remote = createCloudMock();
  const service = new ProjectCollaborationService({
    authUser: () => options.user === undefined ? owner : options.user,
    cloud: options.cloudFactory ?? (() => remote.cloud),
    projectRepo: () => local.repo,
    now: () => NOW,
    cloudProjectId: () => 'cloud-project-id',
    localProjectId: () => 'proj-placeholder',
    inviteCode: () => '1234567890abcdefghijklmnopqrstuv',
  });
  return { service, local, remote };
}

async function expectCode(
  promise: Promise<unknown>,
  code: ProjectCollaborationError['code'],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'ProjectCollaborationError',
    code,
  });
}

describe('ProjectCollaborationService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('promotes a local project, inserts its owner member, and writes the cloud mapping', async () => {
    const fixture = createFixture();

    await expect(fixture.service.promoteToCloudSpace('proj-local')).resolves.toEqual({
      localProjectId: 'proj-local',
      cloudProjectId: 'cloud-project-id',
      name: 'Alpha',
    });

    expect(fixture.remote.writes.slice(0, 2)).toEqual([
      {
        operation: 'insert',
        table: 'collab_projects',
        payload: {
          id: 'cloud-project-id',
          owner_user_id: 'user-owner',
          name: 'Alpha',
        },
      },
      {
        operation: 'insert',
        table: 'project_members',
        payload: {
          project_id: 'cloud-project-id',
          user_id: 'user-owner',
          role: 'owner',
          display_name: 'Owner',
          avatar_url: 'https://example.com/avatar.png',
        },
      },
    ]);
    expect(fixture.local.spies.setCloudProjectId)
      .toHaveBeenCalledWith('proj-local', 'cloud-project-id', NOW);
  });

  it('fails loudly before any promote cloud call when logged out', async () => {
    const fixture = createFixture({ user: null });

    await expectCode(
      fixture.service.promoteToCloudSpace('proj-local'),
      'COLLAB_AUTH_REQUIRED',
    );
    expect(fixture.remote.writes).toEqual([]);
  });

  it('maps an unavailable cloud client to the offline chokepoint', async () => {
    const fixture = createFixture({
      cloudFactory: () => {
        throw new Error('Supabase not initialized');
      },
    });

    await expectCode(
      fixture.service.promoteToCloudSpace('proj-local'),
      'COLLAB_OFFLINE',
    );
  });

  it('maps a thrown network failure without exposing its internal message', async () => {
    const failingCloud = {
      from: () => ({
        insert: () => Promise.reject(new TypeError('fetch failed for https://private.invalid')),
      }),
    } as unknown as SupabaseClient<SupabaseDatabase>;
    const fixture = createFixture({ cloudFactory: () => failingCloud });

    await expectCode(
      fixture.service.promoteToCloudSpace('proj-local'),
      'COLLAB_OFFLINE',
    );
  });

  it('creates a random-copy-safe owner invite without reading the invite table', async () => {
    const fixture = createFixture({
      projects: [project({ cloudProjectId: 'cloud-alpha' })],
    });

    const invite = await fixture.service.createInvite('proj-local', {
      expiresInHours: 24,
      maxUses: 3,
    });

    expect(invite).toEqual({
      code: '1234567890abcdefghijklmnopqrstuv',
      projectId: 'cloud-alpha',
      expiresAt: new Date(NOW + 24 * 60 * 60 * 1_000).toISOString(),
      maxUses: 3,
      usedCount: 0,
      revokedAt: null,
    });
    expect(fixture.remote.writes).toEqual([
      expect.objectContaining({
        operation: 'insert',
        table: 'project_invites',
      }),
    ]);
    expect(fixture.remote.writes.some((call) =>
      call.operation === 'select' && call.table === 'project_invites')).toBe(false);
  });

  it('reports non-owner invite creation through a stable forbidden error', async () => {
    const fixture = createFixture({
      projects: [project({ cloudProjectId: 'cloud-alpha' })],
    });
    fixture.remote.queue('insert:project_invites', {
      error: { code: '42501', message: 'row-level security policy denied insert' },
    });

    await expectCode(
      fixture.service.createInvite('proj-local', { expiresInHours: 1, maxUses: 1 }),
      'COLLAB_FORBIDDEN',
    );
  });

  it('redeems through the RPC and creates a null-workspace local placeholder', async () => {
    const fixture = createFixture({ projects: [] });
    fixture.remote.queue('rpc:redeem_project_invite', {
      data: [{
        collab_project_id: 'cloud-joined',
        project_name: 'Joined Space',
        member_role: 'member',
      }],
    });

    await expect(fixture.service.redeemInvite(' invite-code ')).resolves.toEqual({
      localProjectId: 'proj-placeholder',
      cloudProjectId: 'cloud-joined',
      name: 'Joined Space',
      role: 'member',
      createdLocalPlaceholder: true,
    });
    expect(fixture.remote.rpcCalls).toEqual([
      { name: 'redeem_project_invite', args: { code: 'invite-code' } },
    ]);
    expect(fixture.local.spies.upsertProject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'proj-placeholder',
        workspacePath: null,
        workspaceKey: null,
        cloudProjectId: 'cloud-joined',
      }),
    );
  });

  it.each([
    ['COLLAB_INVITE_EXPIRED', 'COLLAB_INVITE_EXPIRED'],
    ['COLLAB_INVITE_EXHAUSTED', 'COLLAB_INVITE_EXHAUSTED'],
    ['COLLAB_INVITE_REVOKED', 'COLLAB_INVITE_REVOKED'],
  ] as const)('maps rejected redemption %s to its public error code', async (message, code) => {
    const fixture = createFixture();
    fixture.remote.queue('rpc:redeem_project_invite', {
      error: { code: 'P0001', message },
    });

    await expectCode(fixture.service.redeemInvite('code'), code);
  });

  it('fails redemption before RPC while logged out', async () => {
    const fixture = createFixture({ user: null });

    await expectCode(fixture.service.redeemInvite('code'), 'COLLAB_AUTH_REQUIRED');
    expect(fixture.remote.rpcCalls).toEqual([]);
  });

  it('revokes an invite through the owner-checking RPC', async () => {
    const fixture = createFixture();

    await expect(fixture.service.revokeInvite(' invite-code ')).resolves.toEqual({
      revoked: true,
    });
    expect(fixture.remote.rpcCalls).toEqual([
      { name: 'revoke_project_invite', args: { code: 'invite-code' } },
    ]);
  });

  it('fails revoke while logged out and maps non-owner rejection', async () => {
    const loggedOut = createFixture({ user: null });
    await expectCode(loggedOut.service.revokeInvite('code'), 'COLLAB_AUTH_REQUIRED');
    expect(loggedOut.remote.rpcCalls).toEqual([]);

    const nonOwner = createFixture();
    nonOwner.remote.queue('rpc:revoke_project_invite', {
      error: { code: '42501', message: 'COLLAB_FORBIDDEN' },
    });
    await expectCode(nonOwner.service.revokeInvite('code'), 'COLLAB_FORBIDDEN');
  });

  it('lists member display names and avatars from project_members', async () => {
    const fixture = createFixture({
      projects: [project({ cloudProjectId: 'cloud-alpha' })],
    });
    fixture.remote.queue('select:project_members', {
      data: [{
        project_id: 'cloud-alpha',
        user_id: 'user-owner',
        role: 'owner',
        display_name: 'Owner',
        avatar_url: 'avatar',
        joined_at: '2026-07-30T00:00:00.000Z',
      }],
    });

    await expect(fixture.service.listMembers('proj-local')).resolves.toEqual([{
      projectId: 'cloud-alpha',
      userId: 'user-owner',
      role: 'owner',
      displayName: 'Owner',
      avatarUrl: 'avatar',
      joinedAt: '2026-07-30T00:00:00.000Z',
    }]);
  });

  it.each([
    ['promote', (service: ProjectCollaborationService) => service.promoteToCloudSpace('proj-local')],
    ['create invite', (service: ProjectCollaborationService) =>
      service.createInvite('proj-local', { expiresInHours: 1, maxUses: 1 })],
    ['revoke invite', (service: ProjectCollaborationService) => service.revokeInvite('code')],
    ['redeem invite', (service: ProjectCollaborationService) => service.redeemInvite('code')],
  ])('blocks local-user before the %s cloud write path', async (_name, invoke) => {
    const fixture = createFixture({
      user: { id: 'local-user', email: 'local@device.invalid' },
      projects: [project({ cloudProjectId: 'cloud-alpha' })],
    });

    await expectCode(invoke(fixture.service), 'COLLAB_LOCAL_USER_FORBIDDEN');
    expect(fixture.remote.writes).toEqual([]);
    expect(fixture.remote.rpcCalls).toEqual([]);
  });
});
