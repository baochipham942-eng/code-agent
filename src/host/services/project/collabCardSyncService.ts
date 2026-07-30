import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthUser } from '../../../shared/contract/auth';
import type { NeoWorkCard } from '../../../shared/contract/tag';
import { getAuthService } from '../auth/authService';
import { getDatabase } from '../core/databaseService';
import {
  NeoWorkCardRepository,
  type ProjectRepository,
} from '../core/repositories';
import {
  getSupabase,
  type Database as SupabaseDatabase,
} from '../infra/supabaseService';
import { createLogger } from '../infra/logger';
import { pickCollabCardMetadata } from './collabCloudContract';
import {
  ProjectCollaborationError,
} from './projectCollaborationService';

type PendingCardOperation =
  | { kind: 'upsert'; card: NeoWorkCard }
  | { kind: 'delete'; card: NeoWorkCard };

interface SyncLogger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
}

export interface CollabCardSyncDependencies {
  authUser: () => AuthUser | null;
  cloud: () => SupabaseClient<SupabaseDatabase>;
  projectRepo: () => ProjectRepository;
  cardRepo: () => NeoWorkCardRepository;
  logger: SyncLogger;
}

export interface CollabCardSyncReport {
  queued: number;
  synced: number;
  failed: number;
}

function defaultDependencies(): CollabCardSyncDependencies {
  return {
    authUser: () => getAuthService().getCurrentUser(),
    cloud: () => getSupabase(),
    projectRepo: () => getDatabase().getProjectRepo(),
    cardRepo: () => {
      const db = getDatabase().getDb();
      if (!db) throw new ProjectCollaborationError('COLLAB_SERVICE_ERROR');
      return new NeoWorkCardRepository(db);
    },
    logger: createLogger('CollabCardSync'),
  };
}

function pendingKey(card: NeoWorkCard): string {
  return `${card.projectId}:${card.id}`;
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

export class CollabCardSyncService {
  private readonly deps: CollabCardSyncDependencies;
  private readonly pending = new Map<string, PendingCardOperation>();
  private draining: Promise<CollabCardSyncReport> | null = null;

  constructor(dependencies: Partial<CollabCardSyncDependencies> = {}) {
    this.deps = { ...defaultDependencies(), ...dependencies };
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  scheduleUpsert(card: NeoWorkCard): void {
    const project = this.deps.projectRepo().getProject(card.projectId);
    if (!project?.cloudProjectId) return;
    this.assertCloudIdentity(this.deps.authUser(), card);
    this.pending.set(pendingKey(card), { kind: 'upsert', card: { ...card } });
    this.startDrainOrLogLoggedOut(card.projectId);
  }

  scheduleDelete(card: NeoWorkCard): void {
    const project = this.deps.projectRepo().getProject(card.projectId);
    if (!project?.cloudProjectId) return;
    this.assertCloudIdentity(this.deps.authUser(), card);
    this.pending.set(pendingKey(card), { kind: 'delete', card: { ...card } });
    this.startDrainOrLogLoggedOut(card.projectId);
  }

  async flushPending(): Promise<CollabCardSyncReport> {
    if (this.draining) return this.draining;
    const user = this.deps.authUser();
    if (!user) {
      return { queued: this.pending.size, synced: 0, failed: 0 };
    }
    if (user.id === 'local-user') {
      throw new ProjectCollaborationError('COLLAB_LOCAL_USER_FORBIDDEN');
    }

    const drain = this.drainPending(user);
    this.draining = drain;
    try {
      return await drain;
    } finally {
      if (this.draining === drain) this.draining = null;
    }
  }

  async resyncProjectCards(projectId: string): Promise<CollabCardSyncReport> {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) {
      throw new ProjectCollaborationError('COLLAB_INVALID_ARGS');
    }
    const user = this.deps.authUser();
    if (!user) throw new ProjectCollaborationError('COLLAB_AUTH_REQUIRED');
    if (user.id === 'local-user') {
      throw new ProjectCollaborationError('COLLAB_LOCAL_USER_FORBIDDEN');
    }
    const project = this.deps.projectRepo().getProject(normalizedProjectId);
    if (!project) throw new ProjectCollaborationError('COLLAB_PROJECT_NOT_FOUND');
    if (!project.cloudProjectId) {
      throw new ProjectCollaborationError('COLLAB_NOT_CLOUD_SPACE');
    }

    for (const card of this.deps.cardRepo().listByProjectForCloudSync(normalizedProjectId)) {
      this.assertCloudIdentity(user, card);
      this.pending.set(pendingKey(card), {
        kind: card.status === 'archived' ? 'delete' : 'upsert',
        card: { ...card },
      });
    }
    return this.flushPending();
  }

  private startDrainOrLogLoggedOut(projectId: string): void {
    if (!this.deps.authUser()) {
      this.deps.logger.warn('Cloud card sync queued until login', {
        projectId,
        pending: this.pending.size,
      });
      return;
    }
    void this.flushPending().catch((error) => {
      this.deps.logger.warn('Cloud card sync drain could not start', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private assertCloudIdentity(user: AuthUser | null, card: NeoWorkCard): void {
    if (user?.id === 'local-user' || (user && card.requesterUserId === 'local-user')) {
      throw new ProjectCollaborationError('COLLAB_LOCAL_USER_FORBIDDEN');
    }
  }

  private async drainPending(user: AuthUser): Promise<CollabCardSyncReport> {
    let synced = 0;
    let failed = 0;
    const attempted = new Set<PendingCardOperation>();

    while (true) {
      const batch = [...this.pending.values()].filter((operation) => !attempted.has(operation));
      if (batch.length === 0) break;

      for (const operation of batch) {
        attempted.add(operation);
        try {
          await this.execute(operation, user);
          if (this.pending.get(pendingKey(operation.card)) === operation) {
            this.pending.delete(pendingKey(operation.card));
          }
          synced += 1;
        } catch (error) {
          failed += 1;
          this.deps.logger.warn('Cloud card sync failed; operation remains pending', {
            projectId: operation.card.projectId,
            localCardId: operation.card.id,
            operation: operation.kind,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (synced > 0) {
      this.deps.logger.info('Cloud card sync completed', {
        synced,
        failed,
        pending: this.pending.size,
      });
    }
    return { queued: this.pending.size, synced, failed };
  }

  private async execute(operation: PendingCardOperation, user: AuthUser): Promise<void> {
    this.assertCloudIdentity(user, operation.card);
    const project = this.deps.projectRepo().getProject(operation.card.projectId);
    if (!project?.cloudProjectId) return;
    const cloud = this.deps.cloud();

    if (operation.kind === 'delete') {
      const { error } = await cloud
        .from('collab_cards')
        .delete()
        .eq('project_id', project.cloudProjectId)
        .eq('source_user_id', user.id)
        .eq('local_card_id', operation.card.id);
      if (error) throw error;
      return;
    }

    const metadata = pickCollabCardMetadata(
      operation.card as unknown as Record<string, unknown>,
    );
    const { error } = await cloud.from('collab_cards').upsert({
      project_id: project.cloudProjectId,
      source_user_id: user.id,
      local_card_id: operation.card.id,
      title: metadata.title as string,
      status: metadata.status as string,
      priority: metadata.priority as string,
      due_at: typeof metadata.dueAt === 'number' ? isoTimestamp(metadata.dueAt) : null,
      updated_at: isoTimestamp(metadata.updatedAt as number),
      requester_user_id: metadata.requesterUserId as string,
    }, {
      onConflict: 'project_id,source_user_id,local_card_id',
    });
    if (error) throw error;
  }
}

let instance: CollabCardSyncService | null = null;

export function getCollabCardSyncService(): CollabCardSyncService {
  if (!instance) instance = new CollabCardSyncService();
  return instance;
}
