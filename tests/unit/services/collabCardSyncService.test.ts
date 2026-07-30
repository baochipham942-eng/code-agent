import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectRepository } from '../../../src/host/services/core/repositories';
import type { Database as SupabaseDatabase } from '../../../src/host/services/infra/supabaseService';
import {
  CollabCardSyncService,
  type CollabCardSyncDependencies,
} from '../../../src/host/services/project/collabCardSyncService';
import type { AuthUser } from '../../../src/shared/contract/auth';
import type { Project } from '../../../src/shared/contract/project';
import type { NeoWorkCard } from '../../../src/shared/contract/tag';

const NOW = 1_800_000_000_000;
const user: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.com',
};

function project(cloudProjectId: string | null = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'): Project {
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
    cloudProjectId,
    sourceRevision: 0,
  };
}

function card(overrides: Partial<NeoWorkCard> = {}): NeoWorkCard {
  return {
    id: 'nwc-local',
    projectId: 'proj-local',
    sourceConversationId: 'private-conversation',
    sourceTurnId: 'private-turn',
    requesterUserId: user.id,
    title: 'Ship cloud cards',
    status: 'working',
    priority: 'high',
    dueAt: NOW + 86_400_000,
    blockedReason: null,
    currentRevisionId: 'private-revision',
    approvedRevisionId: 'private-approved-revision',
    createdAt: NOW - 1_000,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function createCloudMock() {
  const upsertResults: Array<{ error: unknown | null }> = [];
  const deleteResults: Array<{ error: unknown | null }> = [];
  const upserts: Array<{ payload: Record<string, unknown>; options: unknown }> = [];
  const deletes: Array<Record<string, unknown>> = [];

  const cloud = {
    from(table: string) {
      expect(table).toBe('collab_cards');
      return {
        upsert(payload: Record<string, unknown>, options: unknown) {
          upserts.push({ payload, options });
          return Promise.resolve(upsertResults.shift() ?? { error: null });
        },
        delete() {
          const filters: Record<string, unknown> = {};
          const query = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return query;
            },
            then(resolve: (value: { error: unknown | null }) => unknown) {
              deletes.push({ ...filters });
              return Promise.resolve(deleteResults.shift() ?? { error: null }).then(resolve);
            },
          };
          return query;
        },
      };
    },
  } as unknown as SupabaseClient<SupabaseDatabase>;

  return { cloud, upsertResults, deleteResults, upserts, deletes };
}

function createFixture(options: {
  currentUser?: AuthUser | null;
  localProject?: Project;
  cards?: NeoWorkCard[];
} = {}) {
  let currentUser = options.currentUser === undefined ? user : options.currentUser;
  const localProject = options.localProject ?? project();
  const cloud = createCloudMock();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const listByProjectForCloudSync = vi.fn(() => options.cards ?? []);
  const dependencies: CollabCardSyncDependencies = {
    authUser: () => currentUser,
    cloud: () => cloud.cloud,
    projectRepo: () => ({
      getProject: vi.fn((projectId: string) =>
        projectId === localProject.id ? localProject : undefined),
    } as unknown as ProjectRepository),
    cardRepo: () => ({ listByProjectForCloudSync } as never),
    logger,
  };
  const service = new CollabCardSyncService(dependencies);
  return {
    service,
    cloud,
    logger,
    listByProjectForCloudSync,
    setCurrentUser(next: AuthUser | null) {
      currentUser = next;
    },
  };
}

describe('CollabCardSyncService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not queue or push a card without cloud_project_id', async () => {
    const fixture = createFixture({ localProject: project(null) });

    fixture.service.scheduleUpsert(card());
    await expect(fixture.service.flushPending()).resolves.toEqual({
      queued: 0,
      synced: 0,
      failed: 0,
    });

    expect(fixture.cloud.upserts).toEqual([]);
    expect(fixture.service.pendingCount).toBe(0);
  });

  it('queues while logged out and drains on the next logged-in write', async () => {
    const fixture = createFixture({ currentUser: null });

    fixture.service.scheduleUpsert(card({ id: 'nwc-offline' }));
    expect(fixture.cloud.upserts).toEqual([]);
    expect(fixture.service.pendingCount).toBe(1);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      'Cloud card sync queued until login',
      expect.objectContaining({ pending: 1 }),
    );

    fixture.setCurrentUser(user);
    fixture.service.scheduleUpsert(card({ id: 'nwc-next-write' }));
    await fixture.service.flushPending();

    expect(fixture.cloud.upserts).toHaveLength(2);
    expect(fixture.service.pendingCount).toBe(0);
  });

  it('throws before cloud access for local-user identities', () => {
    const localUserFixture = createFixture({
      currentUser: { id: 'local-user', email: 'local@device.invalid' },
    });
    expect(() => localUserFixture.service.scheduleUpsert(card())).toThrow(
      expect.objectContaining({ code: 'COLLAB_LOCAL_USER_FORBIDDEN' }),
    );
    expect(localUserFixture.cloud.upserts).toEqual([]);

    const localRequesterFixture = createFixture();
    expect(() => localRequesterFixture.service.scheduleUpsert(card({
      requesterUserId: 'local-user',
    }))).toThrow(expect.objectContaining({ code: 'COLLAB_LOCAL_USER_FORBIDDEN' }));
    expect(localRequesterFixture.cloud.upserts).toEqual([]);
  });

  it('uses the C0 whitelist for the upsert payload and excludes private card fields', async () => {
    const fixture = createFixture();
    const privateCard = {
      ...card(),
      readScope: { fileGlobs: ['/private/**'] },
      writeScope: { allowedPaths: ['/private/secret.ts'] },
      content: 'private conversation body',
      workspacePath: '/Users/private/repo',
      filePath: '/Users/private/repo/secret.ts',
      files: ['/Users/private/repo/secret.ts'],
    } as NeoWorkCard;

    fixture.service.scheduleUpsert(privateCard);
    await fixture.service.flushPending();

    expect(fixture.cloud.upserts).toEqual([{
      payload: {
        project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        source_user_id: user.id,
        local_card_id: 'nwc-local',
        title: 'Ship cloud cards',
        status: 'working',
        priority: 'high',
        due_at: new Date(NOW + 86_400_000).toISOString(),
        updated_at: new Date(NOW).toISOString(),
        requester_user_id: user.id,
      },
      options: {
        onConflict: 'project_id,source_user_id,local_card_id',
      },
    }]);
    expect(fixture.cloud.upserts[0].payload).not.toHaveProperty('readScope');
    expect(fixture.cloud.upserts[0].payload).not.toHaveProperty('writeScope');
    expect(fixture.cloud.upserts[0].payload).not.toHaveProperty('content');
    expect(fixture.cloud.upserts[0].payload).not.toHaveProperty('workspacePath');
    expect(fixture.cloud.upserts[0].payload).not.toHaveProperty('filePath');
    expect(fixture.cloud.upserts[0].payload).not.toHaveProperty('files');
  });

  it('keeps failed writes pending, logs them, and retries successfully', async () => {
    const fixture = createFixture();
    fixture.cloud.upsertResults.push({ error: new TypeError('fetch failed') });

    fixture.service.scheduleUpsert(card());
    await expect(fixture.service.flushPending()).resolves.toEqual({
      queued: 1,
      synced: 0,
      failed: 1,
    });

    expect(fixture.logger.warn).toHaveBeenCalledWith(
      'Cloud card sync failed; operation remains pending',
      expect.objectContaining({
        localCardId: 'nwc-local',
        operation: 'upsert',
      }),
    );
    await expect(fixture.service.flushPending()).resolves.toEqual({
      queued: 0,
      synced: 1,
      failed: 0,
    });
    expect(fixture.cloud.upserts).toHaveLength(2);
  });

  it('turns archive operations into source-scoped cloud deletes', async () => {
    const fixture = createFixture();

    fixture.service.scheduleDelete(card({ status: 'archived', archivedAt: NOW }));
    await fixture.service.flushPending();

    expect(fixture.cloud.deletes).toEqual([{
      project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source_user_id: user.id,
      local_card_id: 'nwc-local',
    }]);
  });

  it('resyncs every local project card and deletes archived rows', async () => {
    const active = card({ id: 'nwc-active' });
    const archived = card({ id: 'nwc-archived', status: 'archived', archivedAt: NOW });
    const fixture = createFixture({ cards: [active, archived] });

    await expect(fixture.service.resyncProjectCards(' proj-local ')).resolves.toEqual({
      queued: 0,
      synced: 2,
      failed: 0,
    });

    expect(fixture.listByProjectForCloudSync).toHaveBeenCalledWith('proj-local');
    expect(fixture.cloud.upserts).toHaveLength(1);
    expect(fixture.cloud.deletes).toHaveLength(1);
  });
});
