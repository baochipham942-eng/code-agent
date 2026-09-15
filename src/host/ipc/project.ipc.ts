// ============================================================================
// Project IPC Handlers - domain:project 通道（P0-2 项目空间容器）
// ============================================================================
//
// 单一 domain 处理器同时服务桌面原生 IPC 和 HTTP（domain.ts 的
// POST /api/domain/project/:action 走同一处理器）。设计：内部文档 §5.3
//
// actions：集合真源见 src/shared/ipc/schemas/project.ts（33 个；表 keys、schema、shellCapabilities
// 由 tests/scripts/domainRouteParity.test.ts 三面对账，逐 action 语义见 projectHandlers）
// ============================================================================

import type { IpcMain } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { ProjectSchemas, type ProjectDomainRequest } from '../../shared/ipc/schemas/project';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getProjectService } from '../services/project/projectService';
import {
  getProjectCollaborationService,
  ProjectCollaborationError,
} from '../services/project/projectCollaborationService';
import { getCollabCardSyncService } from '../services/project/collabCardSyncService';
import { getArtifactIssueRepository } from '../services/core/repositories/ArtifactIssueRepository';
import {
  UNSORTED_PROJECT_ID,
  type CreateSpaceInput,
  type ProjectCapabilityKind,
  type ProjectGoalStatus,
  type ProjectSourceAccess,
  type ProjectSourceInput,
  type ProjectStatus,
  type PromoteToSpaceInput,
  type UpdateProjectInput,
} from '../../shared/contract/project';
import type { ArtifactIssue, ArtifactIssueStatus } from '../../shared/contract/productClosure';
import { createLogger } from '../services/infra/logger';
import { getProjectSourceGitStates } from '../services/git/gitStatusService';

const logger = createLogger('ProjectIPC');

const PROJECT_STATUSES: ReadonlySet<string> = new Set(['active', 'idle', 'archived']);
const GOAL_STATUSES: ReadonlySet<string> = new Set(['active', 'met', 'aborted', 'archived']);

interface ListPayload {
  includeArchived?: boolean;
  spacesOnly?: boolean;
}
type CreateSpacePayload = Partial<CreateSpaceInput>;
interface CreatePayload {
  name?: string;
  workspacePath?: string | null;
  description?: string;
}
interface DetailPayload {
  projectId?: string;
}
interface RenamePayload {
  projectId?: string;
  name?: string;
}
interface SetDescriptionPayload {
  projectId?: string;
  description?: string | null;
}
interface SetStatusPayload {
  projectId?: string;
  status?: string;
}
interface AddGoalPayload {
  projectId?: string;
  goal?: string;
  verify?: string | null;
  review?: string | null;
}
interface UpdateGoalStatusPayload {
  goalId?: string;
  status?: string;
  lastRunSessionId?: string | null;
}
interface RolePayload {
  projectId?: string;
  roleId?: string;
}
interface CapabilitySelectionPayload {
  projectId?: string;
  kind?: string;
  capabilityId?: string;
}
interface ArtifactIssuesPayload {
  artifactIds?: string[];
  status?: ArtifactIssueStatus;
  limit?: number;
}
interface SourcesPayload {
  projectId?: string;
}
interface CreateInvitePayload {
  projectId?: string;
  expiresInHours?: number;
  maxUses?: number;
}
interface InviteCodePayload {
  code?: string;
}
type UpdateProjectPayload = Partial<UpdateProjectInput>;
interface SourceMutationPayload {
  projectId?: string;
  revision?: number;
  sourceId?: string;
  path?: string;
  access?: ProjectSourceAccess;
}

function invalid(message: string): IPCResponse {
  return { success: false, error: { code: 'INVALID_ARGS', message } };
}
function notFound(message: string): IPCResponse {
  return { success: false, error: { code: 'NOT_FOUND', message } };
}
function toProjectError(error: unknown): { code: string; message: string } {
  logger.error('Project IPC error', error);
  if (error instanceof ProjectCollaborationError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'PROJECT_ERROR', message: error instanceof Error ? error.message : 'Unknown error' };
}

function readConnectorSelectionPayload(
  payload: unknown,
): { projectId: string; kind: ProjectCapabilityKind; capabilityId: string } | IPCResponse {
  const { projectId, kind, capabilityId } = (payload ?? {}) as CapabilitySelectionPayload;
  if (!projectId?.trim() || !capabilityId?.trim()) {
    return invalid('projectId and capabilityId are required');
  }
  if (kind !== 'connector') {
    return invalid('kind must be connector; skills and automations use their existing project models');
  }
  return {
    projectId: projectId.trim(),
    kind,
    capabilityId: capabilityId.trim(),
  };
}

/** 来源四件套共用体（原 switch fallthrough）：按 action 分支改 sources 后整体 updateProject */
async function mutateSources(
  action: 'addSource' | 'updateSourceAccess' | 'setPrimarySource' | 'removeSource',
  payload: unknown,
): Promise<IPCResponse> {
  const svc = getProjectService();
  const now = Date.now();
  const mutation = (payload ?? {}) as SourceMutationPayload;
  if (!mutation.projectId || typeof mutation.revision !== 'number') {
    return invalid('projectId and revision are required');
  }
  const detail = svc.getProjectDetail(mutation.projectId);
  if (!detail) return notFound('project not found');
  let sources: ProjectSourceInput[] = detail.sources.map((source) => ({
    id: source.id,
    path: source.path,
    role: source.role,
    access: source.access,
    trustState: source.trustState,
  }));
  if (action === 'addSource') {
    if (!mutation.path) return invalid('path is required');
    sources.push({ path: mutation.path, role: 'additional', access: 'read_only' });
  } else {
    if (!mutation.sourceId) return invalid('sourceId is required');
    const target = sources.find((source) => source.id === mutation.sourceId);
    if (!target) return notFound('source not found');
    if (action === 'updateSourceAccess') {
      if (mutation.access !== 'read_only' && mutation.access !== 'read_write') {
        return invalid('access is required');
      }
      if (target.role === 'primary' && mutation.access !== 'read_write') {
        return invalid('Primary source must remain read_write');
      }
      target.access = mutation.access;
    } else if (action === 'setPrimarySource') {
      sources = sources.map((source) => ({
        ...source,
        role: source.id === mutation.sourceId ? 'primary' : 'additional',
        access: source.id === mutation.sourceId ? 'read_write' : source.access,
      }));
    } else {
      if (target.role === 'primary') return invalid('Primary source cannot be removed');
      sources = sources.filter((source) => source.id !== mutation.sourceId);
    }
  }
  const updated = await svc.updateProject({
    projectId: mutation.projectId,
    revision: mutation.revision,
    name: detail.project.name,
    description: detail.project.description,
    sources,
  }, now);
  return updated ? { success: true, data: updated } : notFound('project not found');
}

/**
 * project 域单源路由表（RQ-183 续作·PROJECT 刀）：原 domain switch 逐 case 平移为 handler（rawResponse：handler
 * 仍返回完整 IPCResponse，含 INVALID_ARGS / NOT_FOUND 失败响应，逐字不变）；服务与 now 按请求在 handler 内取
 * （原 switch 在 try 外取、抛错即 reject，现走 mapError）；未知 action → UNKNOWN_ACTION
 * `Unknown project action: <action>`；抛错 → ProjectCollaborationError code 透传，否则 PROJECT_ERROR，同款日志。
 */
const projectHandlers: RawDomainRouteHandlers<ProjectDomainRequest, void> = {
  list: async (_ctx, payload) => {
    const svc = getProjectService();
    const { includeArchived } = (payload ?? {}) as ListPayload;
    return { success: true, data: svc.listProjects(Boolean(includeArchived)) };
  },

  listWithActivity: async (_ctx, payload) => {
    const svc = getProjectService();
    const { includeArchived, spacesOnly } = (payload ?? {}) as ListPayload;
    return {
      success: true,
      data: svc.listProjectsWithActivity(Boolean(includeArchived), Boolean(spacesOnly)),
    };
  },

  createSpace: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const { name, description, workspacePath, trustAcknowledged } = (payload ?? {}) as CreateSpacePayload;
    if (!name?.trim()) return invalid('name is required');
    if (workspacePath !== undefined && workspacePath !== null && !workspacePath.trim()) {
      return invalid('workspacePath must be a non-empty path when provided');
    }
    const created = await svc.createSpace({
      name: name.trim(),
      description,
      workspacePath,
      trustAcknowledged,
    }, now);
    return { success: true, data: created };
  },

  promoteToSpace: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const { projectId, trustAcknowledged } = (payload ?? {}) as Partial<PromoteToSpaceInput>;
    if (!projectId?.trim()) return invalid('projectId is required');
    if (projectId === UNSORTED_PROJECT_ID) {
      return invalid('the unsorted project cannot be promoted to a space');
    }
    const promoted = await svc.promoteToSpace(projectId.trim(), now, { trustAcknowledged });
    return promoted ? { success: true, data: promoted } : notFound('project not found');
  },

  promoteToCloudSpace: async (_ctx, payload) => {
    const collaboration = getProjectCollaborationService();
    const { projectId } = (payload ?? {}) as DetailPayload;
    if (!projectId?.trim()) return invalid('projectId is required');
    if (projectId === UNSORTED_PROJECT_ID) {
      return invalid('the unsorted project cannot be promoted to a cloud space');
    }
    return {
      success: true,
      data: await collaboration.promoteToCloudSpace(projectId.trim()),
    };
  },

  createInvite: async (_ctx, payload) => {
    const collaboration = getProjectCollaborationService();
    const { projectId, expiresInHours, maxUses } = (payload ?? {}) as CreateInvitePayload;
    if (
      !projectId?.trim()
      || typeof expiresInHours !== 'number'
      || typeof maxUses !== 'number'
    ) {
      return invalid('projectId, expiresInHours and maxUses are required');
    }
    return {
      success: true,
      data: await collaboration.createInvite(projectId.trim(), {
        expiresInHours,
        maxUses,
      }),
    };
  },

  revokeInvite: async (_ctx, payload) => {
    const collaboration = getProjectCollaborationService();
    const { code } = (payload ?? {}) as InviteCodePayload;
    if (!code?.trim()) return invalid('code is required');
    return {
      success: true,
      data: await collaboration.revokeInvite(code.trim()),
    };
  },

  redeemInvite: async (_ctx, payload) => {
    const collaboration = getProjectCollaborationService();
    const { code } = (payload ?? {}) as InviteCodePayload;
    if (!code?.trim()) return invalid('code is required');
    return {
      success: true,
      data: await collaboration.redeemInvite(code.trim()),
    };
  },

  listMembers: async (_ctx, payload) => {
    const collaboration = getProjectCollaborationService();
    const { projectId } = (payload ?? {}) as DetailPayload;
    if (!projectId?.trim()) return invalid('projectId is required');
    return {
      success: true,
      data: await collaboration.listMembers(projectId.trim()),
    };
  },

  listCloudCards: async (_ctx, payload) => {
    const collaboration = getProjectCollaborationService();
    const { projectId } = (payload ?? {}) as DetailPayload;
    if (!projectId?.trim()) return invalid('projectId is required');
    return {
      success: true,
      data: await collaboration.listCloudCards(projectId.trim()),
    };
  },

  resyncCloudCards: async (_ctx, payload) => {
    const { projectId } = (payload ?? {}) as DetailPayload;
    if (!projectId?.trim()) return invalid('projectId is required');
    return {
      success: true,
      data: await getCollabCardSyncService().resyncProjectCards(projectId.trim()),
    };
  },

  listCapabilitySelections: async (_ctx, payload) => {
    const svc = getProjectService();
    const { projectId } = (payload ?? {}) as DetailPayload;
    if (!projectId?.trim()) return invalid('projectId is required');
    const selections = svc.listCapabilitySelections(projectId);
    return selections
      ? { success: true, data: selections }
      : notFound('project not found');
  },

  selectCapability: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const parsed = readConnectorSelectionPayload(payload);
    if ('success' in parsed) return parsed;
    const selection = svc.selectCapability(
      parsed.projectId,
      parsed.kind,
      parsed.capabilityId,
      now,
    );
    return selection
      ? { success: true, data: selection }
      : notFound('project not found');
  },

  unselectCapability: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const parsed = readConnectorSelectionPayload(payload);
    if ('success' in parsed) return parsed;
    const result = svc.unselectCapability(
      parsed.projectId,
      parsed.kind,
      parsed.capabilityId,
      now,
    );
    return result
      ? { success: true, data: result }
      : notFound('project not found');
  },

  create: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const { name, workspacePath, description } = (payload ?? {}) as CreatePayload;
    if (!name?.trim()) return invalid('name is required');
    const created = await svc.createProject(
      {
        name: name.trim(),
        workspacePath: typeof workspacePath === 'string' ? workspacePath : null,
        description: typeof description === 'string' ? description : undefined,
      },
      now,
    );
    return { success: true, data: created };
  },

  detail: async (_ctx, payload) => {
    const svc = getProjectService();
    const { projectId } = (payload ?? {}) as DetailPayload;
    if (!projectId) return invalid('projectId is required');
    const detail = svc.getProjectDetail(projectId);
    return detail ? { success: true, data: detail } : notFound('project not found');
  },

  sources: async (_ctx, payload) => {
    const svc = getProjectService();
    const { projectId } = (payload ?? {}) as SourcesPayload;
    if (!projectId) return invalid('projectId is required');
    return { success: true, data: svc.listSources(projectId) };
  },

  gitStates: async (_ctx, payload) => {
    const svc = getProjectService();
    const { projectId } = (payload ?? {}) as SourcesPayload;
    if (!projectId) return invalid('projectId is required');
    const scope = svc.getWorkspaceScope(projectId);
    return { success: true, data: scope ? await getProjectSourceGitStates(scope) : [] };
  },

  updateProject: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const update = (payload ?? {}) as UpdateProjectPayload;
    if (
      !update.projectId
      || typeof update.revision !== 'number'
      || !update.name
      || !Array.isArray(update.sources)
    ) {
      return invalid('projectId, revision, name and sources are required');
    }
    const updated = await svc.updateProject(update as UpdateProjectInput, now);
    return updated ? { success: true, data: updated } : notFound('project not found');
  },

  addSource: (_ctx, payload) => mutateSources('addSource', payload),

  updateSourceAccess: (_ctx, payload) => mutateSources('updateSourceAccess', payload),

  setPrimarySource: (_ctx, payload) => mutateSources('setPrimarySource', payload),

  removeSource: (_ctx, payload) => mutateSources('removeSource', payload),

  artifacts: async (_ctx, payload) => {
    const svc = getProjectService();
    const { projectId, limit } = (payload ?? {}) as DetailPayload & { limit?: number };
    if (!projectId) return invalid('projectId is required');
    return { success: true, data: svc.getProjectArtifacts(projectId, typeof limit === 'number' ? limit : undefined) };
  },

  artifactIssues: async (_ctx, payload) => {
    const { artifactIds, status, limit } = (payload ?? {}) as ArtifactIssuesPayload;
    const ids = Array.from(new Set((artifactIds ?? []).filter((id): id is string => typeof id === 'string' && id.trim().length > 0)));
    if (ids.length === 0) return invalid('artifactIds is required');
    const repo = getArtifactIssueRepository();
    if (!repo) return { success: true, data: {} };
    const perArtifactLimit = Math.max(1, Math.min(typeof limit === 'number' ? limit : 20, 50));
    const issuesByArtifactId: Record<string, ArtifactIssue[]> = {};
    for (const artifactId of ids.slice(0, 50)) {
      issuesByArtifactId[artifactId] = repo.listIssues({
        artifactId,
        status,
        limit: perArtifactLimit,
      });
    }
    return { success: true, data: issuesByArtifactId };
  },

  rename: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const { projectId, name } = (payload ?? {}) as RenamePayload;
    if (!projectId || !name?.trim()) return invalid('projectId and name are required');
    const updated = svc.renameProject(projectId, name.trim(), now);
    return updated ? { success: true, data: updated } : notFound('project not found');
  },

  setDescription: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const { projectId, description } = (payload ?? {}) as SetDescriptionPayload;
    if (!projectId) return invalid('projectId is required');
    const updated = svc.setProjectDescription(
      projectId,
      typeof description === 'string' ? description : null,
      now,
    );
    return updated ? { success: true, data: updated } : notFound('project not found');
  },

  setStatus: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const { projectId, status } = (payload ?? {}) as SetStatusPayload;
    if (!projectId || !status || !PROJECT_STATUSES.has(status)) {
      return invalid('projectId and status (active|idle|archived) are required');
    }
    const updated = svc.setProjectStatus(projectId, status as ProjectStatus, now);
    return updated ? { success: true, data: updated } : notFound('project not found');
  },

  deleteProject: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const { projectId } = (payload ?? {}) as DetailPayload;
    if (!projectId) return invalid('projectId is required');
    return { success: true, data: { deleted: svc.deleteProject(projectId, now) } };
  },

  addGoal: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const { projectId, goal, verify, review } = (payload ?? {}) as AddGoalPayload;
    if (!projectId || !goal?.trim()) return invalid('projectId and goal are required');
    const created = svc.addGoal(projectId, { goal: goal.trim(), verify: verify ?? null, review: review ?? null }, now);
    return created ? { success: true, data: created } : notFound('project not found');
  },

  updateGoalStatus: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const { goalId, status, lastRunSessionId } = (payload ?? {}) as UpdateGoalStatusPayload;
    if (!goalId || !status || !GOAL_STATUSES.has(status)) {
      return invalid('goalId and status (active|met|aborted|archived) are required');
    }
    const updated = svc.updateGoalStatus(goalId, status as ProjectGoalStatus, now, lastRunSessionId ?? undefined);
    return updated ? { success: true, data: updated } : notFound('goal not found');
  },

  addRole: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const { projectId, roleId } = (payload ?? {}) as RolePayload;
    if (!projectId || !roleId?.trim()) return invalid('projectId and roleId are required');
    const link = svc.addRole(projectId, roleId.trim(), now);
    return link ? { success: true, data: link } : notFound('project not found');
  },

  removeRole: async (_ctx, payload) => {
    const svc = getProjectService();
    const now = Date.now();
    const { projectId, roleId } = (payload ?? {}) as RolePayload;
    if (!projectId || !roleId?.trim()) return invalid('projectId and roleId are required');
    const removed = svc.removeRole(projectId, roleId.trim(), now);
    return { success: true, data: { removed } };
  },
};

const projectRoutes = defineDomainRoutes<ProjectDomainRequest, void>(ProjectSchemas.REQUEST, projectHandlers, {
  rawResponse: true,
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `Unknown project action: ${String(action)}`,
  mapError: toProjectError,
});

export function registerProjectHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, projectRoutes, undefined);
  logger.info('Project IPC handlers registered');
}

// 表挂装配函数对象上供 parity 门枚举（同 registerMemoryHandlers.routes 先例）
registerProjectHandlers.routes = projectRoutes;
