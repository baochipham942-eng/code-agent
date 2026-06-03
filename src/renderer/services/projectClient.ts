// ============================================================================
// projectClient - 渲染层项目空间 domain API 封装（P0-2）
// ============================================================================
//
// 走 ipcService.invokeDomain(IPC_DOMAINS.PROJECT, action, payload)，桌面原生 IPC
// 与 HTTP 双链路统一（见 docs/designs/project-space.md §5.3）。
// ============================================================================

import { IPC_DOMAINS } from '@shared/ipc';
import type {
  Project,
  ProjectArtifact,
  ProjectDetail,
  ProjectGoal,
  ProjectGoalStatus,
  ProjectRoleLink,
  ProjectStatus,
} from '@shared/contract/project';
import ipcService from './ipcService';

export async function listProjects(includeArchived = false): Promise<Project[]> {
  return ipcService.invokeDomain<Project[]>(IPC_DOMAINS.PROJECT, 'list', { includeArchived });
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetail> {
  return ipcService.invokeDomain<ProjectDetail>(IPC_DOMAINS.PROJECT, 'detail', { projectId });
}

export async function getProjectArtifacts(projectId: string, limit?: number): Promise<ProjectArtifact[]> {
  return ipcService.invokeDomain<ProjectArtifact[]>(IPC_DOMAINS.PROJECT, 'artifacts', { projectId, limit });
}

export async function renameProject(projectId: string, name: string): Promise<Project> {
  return ipcService.invokeDomain<Project>(IPC_DOMAINS.PROJECT, 'rename', { projectId, name });
}

export async function setProjectStatus(projectId: string, status: ProjectStatus): Promise<Project> {
  return ipcService.invokeDomain<Project>(IPC_DOMAINS.PROJECT, 'setStatus', { projectId, status });
}

export async function addProjectGoal(
  projectId: string,
  goal: string,
  opts?: { verify?: string; review?: string },
): Promise<ProjectGoal> {
  return ipcService.invokeDomain<ProjectGoal>(IPC_DOMAINS.PROJECT, 'addGoal', {
    projectId,
    goal,
    verify: opts?.verify ?? null,
    review: opts?.review ?? null,
  });
}

export async function updateProjectGoalStatus(goalId: string, status: ProjectGoalStatus): Promise<ProjectGoal> {
  return ipcService.invokeDomain<ProjectGoal>(IPC_DOMAINS.PROJECT, 'updateGoalStatus', { goalId, status });
}

export async function addProjectRole(projectId: string, roleId: string): Promise<ProjectRoleLink> {
  return ipcService.invokeDomain<ProjectRoleLink>(IPC_DOMAINS.PROJECT, 'addRole', { projectId, roleId });
}

export async function removeProjectRole(projectId: string, roleId: string): Promise<{ removed: boolean }> {
  return ipcService.invokeDomain<{ removed: boolean }>(IPC_DOMAINS.PROJECT, 'removeRole', { projectId, roleId });
}
