// ============================================================================
// Project IPC Handlers - domain:project 通道（P0-2 项目空间容器）
// ============================================================================
//
// 单一 domain 处理器同时服务桌面原生 IPC 和 HTTP（domain.ts 的
// POST /api/domain/project/:action 走同一处理器）。设计：内部文档 §5.3
//
// actions:
// - list            -> 项目列表（{ includeArchived? }）
// - detail          -> 项目详情（project + goals + roles + sessionIds）
// - rename          -> 改名（{ projectId, name }）
// - setDescription  -> 改描述（{ projectId, description? }）
// - setStatus       -> 改状态（{ projectId, status }）
// - addGoal         -> 新增目标（{ projectId, goal, verify?, review? }）
// - updateGoalStatus-> 更新目标状态（{ goalId, status, lastRunSessionId? }）
// - addRole         -> 角色入驻（{ projectId, roleId }）
// - removeRole      -> 角色退出（{ projectId, roleId }）
// - artifactIssues  -> 产物质量问题查询（{ artifactIds, status?, limit? }）
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { getProjectService } from '../services/project/projectService';
import { getArtifactIssueRepository } from '../services/core/repositories/ArtifactIssueRepository';
import {
  type ProjectGoalStatus,
  type ProjectStatus,
} from '../../shared/contract/project';
import type { ArtifactIssue, ArtifactIssueStatus } from '../../shared/contract/productClosure';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ProjectIPC');

const PROJECT_STATUSES: ReadonlySet<string> = new Set(['active', 'idle', 'archived']);
const GOAL_STATUSES: ReadonlySet<string> = new Set(['active', 'met', 'aborted', 'archived']);

interface ListPayload {
  includeArchived?: boolean;
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
interface ArtifactIssuesPayload {
  artifactIds?: string[];
  status?: ArtifactIssueStatus;
  limit?: number;
}

function invalid(message: string): IPCResponse {
  return { success: false, error: { code: 'INVALID_ARGS', message } };
}
function notFound(message: string): IPCResponse {
  return { success: false, error: { code: 'NOT_FOUND', message } };
}

export function registerProjectHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.PROJECT, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;
    const svc = getProjectService();
    const now = Date.now();
    try {
      switch (action) {
        case 'list': {
          const { includeArchived } = (payload ?? {}) as ListPayload;
          return { success: true, data: svc.listProjects(Boolean(includeArchived)) };
        }

        case 'detail': {
          const { projectId } = (payload ?? {}) as DetailPayload;
          if (!projectId) return invalid('projectId is required');
          const detail = svc.getProjectDetail(projectId);
          return detail ? { success: true, data: detail } : notFound('project not found');
        }

        case 'artifacts': {
          const { projectId, limit } = (payload ?? {}) as DetailPayload & { limit?: number };
          if (!projectId) return invalid('projectId is required');
          return { success: true, data: svc.getProjectArtifacts(projectId, typeof limit === 'number' ? limit : undefined) };
        }

        case 'artifactIssues': {
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
        }

        case 'rename': {
          const { projectId, name } = (payload ?? {}) as RenamePayload;
          if (!projectId || !name?.trim()) return invalid('projectId and name are required');
          const updated = svc.renameProject(projectId, name.trim(), now);
          return updated ? { success: true, data: updated } : notFound('project not found');
        }

        case 'setDescription': {
          const { projectId, description } = (payload ?? {}) as SetDescriptionPayload;
          if (!projectId) return invalid('projectId is required');
          const updated = svc.setProjectDescription(
            projectId,
            typeof description === 'string' ? description : null,
            now,
          );
          return updated ? { success: true, data: updated } : notFound('project not found');
        }

        case 'setStatus': {
          const { projectId, status } = (payload ?? {}) as SetStatusPayload;
          if (!projectId || !status || !PROJECT_STATUSES.has(status)) {
            return invalid('projectId and status (active|idle|archived) are required');
          }
          const updated = svc.setProjectStatus(projectId, status as ProjectStatus, now);
          return updated ? { success: true, data: updated } : notFound('project not found');
        }

        case 'addGoal': {
          const { projectId, goal, verify, review } = (payload ?? {}) as AddGoalPayload;
          if (!projectId || !goal?.trim()) return invalid('projectId and goal are required');
          const created = svc.addGoal(projectId, { goal: goal.trim(), verify: verify ?? null, review: review ?? null }, now);
          return created ? { success: true, data: created } : notFound('project not found');
        }

        case 'updateGoalStatus': {
          const { goalId, status, lastRunSessionId } = (payload ?? {}) as UpdateGoalStatusPayload;
          if (!goalId || !status || !GOAL_STATUSES.has(status)) {
            return invalid('goalId and status (active|met|aborted|archived) are required');
          }
          const updated = svc.updateGoalStatus(goalId, status as ProjectGoalStatus, now, lastRunSessionId ?? undefined);
          return updated ? { success: true, data: updated } : notFound('goal not found');
        }

        case 'addRole': {
          const { projectId, roleId } = (payload ?? {}) as RolePayload;
          if (!projectId || !roleId?.trim()) return invalid('projectId and roleId are required');
          const link = svc.addRole(projectId, roleId.trim(), now);
          return link ? { success: true, data: link } : notFound('project not found');
        }

        case 'removeRole': {
          const { projectId, roleId } = (payload ?? {}) as RolePayload;
          if (!projectId || !roleId?.trim()) return invalid('projectId and roleId are required');
          const removed = svc.removeRole(projectId, roleId.trim(), now);
          return { success: true, data: { removed } };
        }

        default:
          return { success: false, error: { code: 'UNKNOWN_ACTION', message: `Unknown project action: ${action}` } };
      }
    } catch (error) {
      logger.error('Project IPC error', error);
      return {
        success: false,
        error: { code: 'PROJECT_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  });

  logger.info('Project IPC handlers registered');
}
