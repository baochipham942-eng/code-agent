import { randomBytes, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthUser } from '../../../shared/contract/auth';
import type { Project } from '../../../shared/contract/project';
import { getAuthService } from '../auth/authService';
import { getDatabase } from '../core/databaseService';
import type { ProjectRepository } from '../core/repositories';
import {
  getSupabase,
  type Database as SupabaseDatabase,
} from '../infra/supabaseService';

export type ProjectCollaborationErrorCode =
  | 'COLLAB_AUTH_REQUIRED'
  | 'COLLAB_LOCAL_USER_FORBIDDEN'
  | 'COLLAB_OFFLINE'
  | 'COLLAB_FORBIDDEN'
  | 'COLLAB_PROJECT_NOT_FOUND'
  | 'COLLAB_NOT_CLOUD_SPACE'
  | 'COLLAB_INVITE_NOT_FOUND'
  | 'COLLAB_INVITE_REVOKED'
  | 'COLLAB_INVITE_EXPIRED'
  | 'COLLAB_INVITE_EXHAUSTED'
  | 'COLLAB_INVALID_ARGS'
  | 'COLLAB_SERVICE_ERROR';

const ERROR_MESSAGES: Record<ProjectCollaborationErrorCode, string> = {
  COLLAB_AUTH_REQUIRED: '请先登录后再使用协同空间。',
  COLLAB_LOCAL_USER_FORBIDDEN: '本地访客身份不能写入云端，请先登录正式账号。',
  COLLAB_OFFLINE: '协同服务当前不可用，请检查网络后重试。',
  COLLAB_FORBIDDEN: '只有空间所有者可以执行此操作。',
  COLLAB_PROJECT_NOT_FOUND: '本地项目不存在或已被删除。',
  COLLAB_NOT_CLOUD_SPACE: '该项目尚未升级或加入云协同空间。',
  COLLAB_INVITE_NOT_FOUND: '邀请码不存在。',
  COLLAB_INVITE_REVOKED: '邀请码已被撤销。',
  COLLAB_INVITE_EXPIRED: '邀请码已过期。',
  COLLAB_INVITE_EXHAUSTED: '邀请码使用次数已达上限。',
  COLLAB_INVALID_ARGS: '协同空间参数无效。',
  COLLAB_SERVICE_ERROR: '协同服务暂时出错，请稍后重试。',
};

type CloudErrorLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
};

export class ProjectCollaborationError extends Error {
  constructor(readonly code: ProjectCollaborationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ProjectCollaborationError';
  }
}

export interface CreateProjectInviteInput {
  expiresInHours: number;
  maxUses: number;
}

export interface ProjectInvite {
  code: string;
  projectId: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  revokedAt: string | null;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: 'owner' | 'member';
  displayName: string | null;
  avatarUrl: string | null;
  joinedAt: string;
}

export interface CloudCollabCard {
  localCardId: string;
  sourceUserId: string;
  title: string;
  status: string;
  priority: string;
  dueAt: number | null;
  updatedAt: number;
  requesterUserId: string;
  readonly: true;
}

export interface CloudSpacePromotion {
  localProjectId: string;
  cloudProjectId: string;
  name: string;
}

export interface RedeemedCloudSpace extends CloudSpacePromotion {
  role: 'owner' | 'member';
  createdLocalPlaceholder: boolean;
}

export interface ProjectCollaborationDependencies {
  authUser: () => AuthUser | null;
  cloud: () => SupabaseClient<SupabaseDatabase>;
  projectRepo: () => ProjectRepository;
  now: () => number;
  cloudProjectId: () => string;
  localProjectId: () => string;
  inviteCode: () => string;
}

function defaultDependencies(): ProjectCollaborationDependencies {
  return {
    authUser: () => getAuthService().getCurrentUser(),
    cloud: () => getSupabase(),
    projectRepo: () => getDatabase().getProjectRepo(),
    now: () => Date.now(),
    cloudProjectId: () => randomUUID(),
    localProjectId: () => `proj_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    // 24 random bytes > the protocol's 16-byte minimum; base64url is copy-safe.
    inviteCode: () => randomBytes(24).toString('base64url'),
  };
}

function errorText(error: CloudErrorLike): string {
  return [error.code, error.message, error.details].filter(Boolean).join(' ');
}

function mapCloudError(error: CloudErrorLike): ProjectCollaborationError {
  const text = errorText(error);
  const protocolCode = ([
    'COLLAB_AUTH_REQUIRED',
    'COLLAB_FORBIDDEN',
    'COLLAB_INVITE_NOT_FOUND',
    'COLLAB_INVITE_REVOKED',
    'COLLAB_INVITE_EXPIRED',
    'COLLAB_INVITE_EXHAUSTED',
  ] as const).find((code) => text.includes(code));
  if (protocolCode) return new ProjectCollaborationError(protocolCode);
  if (/JWT|token.*expired|not authenticated|auth session/iu.test(text)) {
    return new ProjectCollaborationError('COLLAB_AUTH_REQUIRED');
  }
  if (error.code === '42501' || /permission denied|row-level security/iu.test(text)) {
    return new ProjectCollaborationError('COLLAB_FORBIDDEN');
  }
  if (/fetch|network|offline|ECONN|ENOTFOUND|ETIMEDOUT|socket/iu.test(text)) {
    return new ProjectCollaborationError('COLLAB_OFFLINE');
  }
  return new ProjectCollaborationError('COLLAB_SERVICE_ERROR');
}

function thrownCloudError(error: unknown): ProjectCollaborationError {
  if (error instanceof ProjectCollaborationError) return error;
  if (error && typeof error === 'object') {
    const value = error as CloudErrorLike;
    return mapCloudError({
      code: typeof value.code === 'string' ? value.code : null,
      message: typeof value.message === 'string' ? value.message : null,
      details: typeof value.details === 'string' ? value.details : null,
    });
  }
  return mapCloudError({ message: String(error) });
}

function assertCloudResult(error: CloudErrorLike | null): void {
  if (error) throw mapCloudError(error);
}

export class ProjectCollaborationService {
  private readonly deps: ProjectCollaborationDependencies;

  constructor(dependencies: Partial<ProjectCollaborationDependencies> = {}) {
    this.deps = { ...defaultDependencies(), ...dependencies };
  }

  private currentUser(): AuthUser {
    const user = this.deps.authUser();
    if (!user) throw new ProjectCollaborationError('COLLAB_AUTH_REQUIRED');
    if (user.id === 'local-user') {
      throw new ProjectCollaborationError('COLLAB_LOCAL_USER_FORBIDDEN');
    }
    return user;
  }

  private cloud(): SupabaseClient<SupabaseDatabase> {
    try {
      return this.deps.cloud();
    } catch {
      throw new ProjectCollaborationError('COLLAB_OFFLINE');
    }
  }

  private localProject(projectId: string): Project {
    const project = this.deps.projectRepo().getProject(projectId);
    if (!project) throw new ProjectCollaborationError('COLLAB_PROJECT_NOT_FOUND');
    return project;
  }

  private async cloudCall<T>(operation: () => PromiseLike<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw thrownCloudError(error);
    }
  }

  async promoteToCloudSpace(projectId: string): Promise<CloudSpacePromotion> {
    const user = this.currentUser();
    const project = this.localProject(projectId);
    if (project.cloudProjectId) {
      return {
        localProjectId: project.id,
        cloudProjectId: project.cloudProjectId,
        name: project.name,
      };
    }

    const cloudProjectId = this.deps.cloudProjectId();
    const cloud = this.cloud();
    const { error: projectError } = await this.cloudCall(() =>
      cloud.from('collab_projects').insert({
        id: cloudProjectId,
        owner_user_id: user.id,
        name: project.name,
      }));
    assertCloudResult(projectError);

    const { error: memberError } = await this.cloudCall(() =>
      cloud.from('project_members').insert({
        project_id: cloudProjectId,
        user_id: user.id,
        role: 'owner',
        display_name: user.nickname ?? user.username ?? user.email,
        avatar_url: user.avatarUrl ?? null,
      }));
    if (memberError) {
      await this.cloudCall(() =>
        cloud.from('collab_projects').delete().eq('id', cloudProjectId)).catch(() => undefined);
      throw mapCloudError(memberError);
    }

    let mapped: Project | undefined;
    try {
      mapped = this.deps.projectRepo().setCloudProjectId(
        project.id,
        cloudProjectId,
        this.deps.now(),
      );
    } catch {
      await this.cloudCall(() =>
        cloud.from('collab_projects').delete().eq('id', cloudProjectId)).catch(() => undefined);
      throw new ProjectCollaborationError('COLLAB_SERVICE_ERROR');
    }
    if (!mapped) {
      await this.cloudCall(() =>
        cloud.from('collab_projects').delete().eq('id', cloudProjectId)).catch(() => undefined);
      throw new ProjectCollaborationError('COLLAB_PROJECT_NOT_FOUND');
    }
    return {
      localProjectId: mapped.id,
      cloudProjectId,
      name: mapped.name,
    };
  }

  async createInvite(
    projectId: string,
    input: CreateProjectInviteInput,
  ): Promise<ProjectInvite> {
    const user = this.currentUser();
    if (
      !Number.isFinite(input.expiresInHours)
      || input.expiresInHours <= 0
      || input.expiresInHours > 8_760
      || !Number.isInteger(input.maxUses)
      || input.maxUses <= 0
      || input.maxUses > 1_000
    ) {
      throw new ProjectCollaborationError('COLLAB_INVALID_ARGS');
    }
    const project = this.localProject(projectId);
    if (!project.cloudProjectId) {
      throw new ProjectCollaborationError('COLLAB_NOT_CLOUD_SPACE');
    }
    const invite: ProjectInvite = {
      code: this.deps.inviteCode(),
      projectId: project.cloudProjectId,
      expiresAt: new Date(this.deps.now() + input.expiresInHours * 60 * 60 * 1_000).toISOString(),
      maxUses: input.maxUses,
      usedCount: 0,
      revokedAt: null,
    };
    const cloud = this.cloud();
    const { error } = await this.cloudCall(() =>
      cloud.from('project_invites').insert({
        code: invite.code,
        project_id: invite.projectId,
        created_by: user.id,
        expires_at: invite.expiresAt,
        max_uses: invite.maxUses,
      }));
    assertCloudResult(error);
    return invite;
  }

  async revokeInvite(code: string): Promise<{ revoked: true }> {
    this.currentUser();
    const normalizedCode = code.trim();
    if (!normalizedCode) throw new ProjectCollaborationError('COLLAB_INVALID_ARGS');
    const cloud = this.cloud();
    const { error } = await this.cloudCall(() =>
      cloud.rpc('revoke_project_invite', {
        code: normalizedCode,
      }));
    assertCloudResult(error);
    return { revoked: true };
  }

  async redeemInvite(code: string): Promise<RedeemedCloudSpace> {
    this.currentUser();
    const normalizedCode = code.trim();
    if (!normalizedCode) throw new ProjectCollaborationError('COLLAB_INVALID_ARGS');
    const cloud = this.cloud();
    const { data, error } = await this.cloudCall(() =>
      cloud.rpc('redeem_project_invite', {
        code: normalizedCode,
      }));
    assertCloudResult(error);
    const redemption = data?.[0];
    if (!redemption) throw new ProjectCollaborationError('COLLAB_SERVICE_ERROR');

    const repo = this.deps.projectRepo();
    const existing = repo.getProjectByCloudProjectId(redemption.collab_project_id);
    if (existing) {
      return {
        localProjectId: existing.id,
        cloudProjectId: redemption.collab_project_id,
        name: existing.name,
        role: redemption.member_role,
        createdLocalPlaceholder: false,
      };
    }

    const now = this.deps.now();
    const placeholder: Project = {
      id: this.deps.localProjectId(),
      name: redemption.project_name,
      workspacePath: null,
      workspaceKey: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      spacePromotedAt: now,
      cloudProjectId: redemption.collab_project_id,
      sourceRevision: 0,
    };
    try {
      repo.upsertProject(placeholder);
    } catch {
      const concurrentlyCreated = repo.getProjectByCloudProjectId(redemption.collab_project_id);
      if (concurrentlyCreated) {
        return {
          localProjectId: concurrentlyCreated.id,
          cloudProjectId: redemption.collab_project_id,
          name: concurrentlyCreated.name,
          role: redemption.member_role,
          createdLocalPlaceholder: false,
        };
      }
      throw new ProjectCollaborationError('COLLAB_SERVICE_ERROR');
    }
    return {
      localProjectId: placeholder.id,
      cloudProjectId: redemption.collab_project_id,
      name: placeholder.name,
      role: redemption.member_role,
      createdLocalPlaceholder: true,
    };
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    this.currentUser();
    const project = this.localProject(projectId);
    if (!project.cloudProjectId) {
      throw new ProjectCollaborationError('COLLAB_NOT_CLOUD_SPACE');
    }
    const cloudProjectId = project.cloudProjectId;
    const cloud = this.cloud();
    const { data, error } = await this.cloudCall(() =>
      cloud
        .from('project_members')
        .select('project_id, user_id, role, display_name, avatar_url, joined_at')
        .eq('project_id', cloudProjectId)
        .order('joined_at', { ascending: true }));
    assertCloudResult(error);
    return (data ?? []).map((member) => ({
      projectId: member.project_id,
      userId: member.user_id,
      role: member.role,
      displayName: member.display_name,
      avatarUrl: member.avatar_url,
      joinedAt: member.joined_at,
    }));
  }

  async listCloudCards(projectId: string): Promise<CloudCollabCard[]> {
    const user = this.currentUser();
    const project = this.localProject(projectId);
    if (!project.cloudProjectId) {
      throw new ProjectCollaborationError('COLLAB_NOT_CLOUD_SPACE');
    }
    const cloudProjectId = project.cloudProjectId;
    const cloud = this.cloud();
    const { data, error } = await this.cloudCall(() =>
      cloud
        .from('collab_cards')
        .select(
          'source_user_id, local_card_id, title, status, priority, due_at, updated_at, requester_user_id',
        )
        .eq('project_id', cloudProjectId)
        .neq('source_user_id', user.id)
        .order('updated_at', { ascending: false }));
    assertCloudResult(error);
    return (data ?? [])
      .filter((card) => card.source_user_id !== user.id)
      .map((card) => ({
        localCardId: card.local_card_id,
        sourceUserId: card.source_user_id,
        title: card.title,
        status: card.status,
        priority: card.priority,
        dueAt: card.due_at === null ? null : Date.parse(card.due_at),
        updatedAt: Date.parse(card.updated_at),
        requesterUserId: card.requester_user_id,
        readonly: true,
      }));
  }
}

let instance: ProjectCollaborationService | null = null;

export function getProjectCollaborationService(): ProjectCollaborationService {
  if (!instance) instance = new ProjectCollaborationService();
  return instance;
}
