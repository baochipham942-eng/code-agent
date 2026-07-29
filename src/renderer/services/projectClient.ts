// ============================================================================
// projectClient - 渲染层项目空间 domain API 封装（P0-2）
// ============================================================================
//
// 走 ipcService.invokeDomain(IPC_DOMAINS.PROJECT, action, payload)，桌面原生 IPC
// 与 HTTP 双链路统一（见 内部文档 §5.3）。
// ============================================================================

import { IPC_DOMAINS } from '@shared/ipc';
import type {
  CloudSpacePromotion,
  CreateSpaceInput,
  Project,
  ProjectArtifact,
  ProjectCapabilityKind,
  ProjectCapabilitySelection,
  ProjectDetail,
  ProjectGoal,
  ProjectGoalStatus,
  ProjectInvite,
  ProjectMember,
  ProjectRoleLink,
  ProjectSourceGitState,
  ProjectStatus,
  ProjectWithActivity,
  UpdateProjectInput,
} from '@shared/contract/project';
import type { ArtifactIssue, ArtifactIssueStatus } from '@shared/contract/productClosure';
import ipcService from './ipcService';

export async function listProjects(includeArchived = false): Promise<Project[]> {
  return ipcService.invokeDomain<Project[]>(IPC_DOMAINS.PROJECT, 'list', { includeArchived });
}

/** 项目列表页数据源：项目 + 活跃 topic 数 + 最近活动时间；spacesOnly=true 只回显式空间 */
export async function listProjectsWithActivity(includeArchived = false, spacesOnly = false): Promise<ProjectWithActivity[]> {
  return ipcService.invokeDomain<ProjectWithActivity[]>(IPC_DOMAINS.PROJECT, 'listWithActivity', { includeArchived, spacesOnly });
}

/** 新建显式协作空间；撞已有 workspace 项目时 host 侧自动升级并返回该项目 */
export async function createSpace(input: CreateSpaceInput): Promise<Project> {
  return ipcService.invokeDomain<Project>(IPC_DOMAINS.PROJECT, 'createSpace', input);
}

/** 将已有普通项目升级为显式协作空间 */
export async function promoteToSpace(projectId: string): Promise<Project> {
  return ipcService.invokeDomain<Project>(IPC_DOMAINS.PROJECT, 'promoteToSpace', { projectId });
}

/** 升级为云协同空间：创建云项目壳并写回本地映射；失败 error.message 已是人话（host 侧映射） */
export async function promoteToCloudSpace(projectId: string): Promise<CloudSpacePromotion> {
  return ipcService.invokeDomain<CloudSpacePromotion>(IPC_DOMAINS.PROJECT, 'promoteToCloudSpace', { projectId });
}

/** owner 创建空间邀请码；失败 error.message 已是人话，toast 直接展示 */
export async function createInvite(
  projectId: string,
  opts: { expiresInHours: number; maxUses: number },
): Promise<ProjectInvite> {
  return ipcService.invokeDomain<ProjectInvite>(IPC_DOMAINS.PROJECT, 'createInvite', {
    projectId,
    expiresInHours: opts.expiresInHours,
    maxUses: opts.maxUses,
  });
}

/** 读取云协同空间成员卡（仅 cloudProjectId 非空的空间可用） */
export async function listMembers(projectId: string): Promise<ProjectMember[]> {
  return ipcService.invokeDomain<ProjectMember[]>(IPC_DOMAINS.PROJECT, 'listMembers', { projectId });
}

/** 项目级能力选用清单（connector 等 kind 维度；skill 走 SKILL IPC 覆盖模型） */
export async function listCapabilitySelections(projectId: string): Promise<ProjectCapabilitySelection[]> {
  return ipcService.invokeDomain<ProjectCapabilitySelection[]>(IPC_DOMAINS.PROJECT, 'listCapabilitySelections', { projectId });
}

export async function selectCapability(
  projectId: string,
  kind: ProjectCapabilityKind,
  capabilityId: string,
): Promise<ProjectCapabilitySelection> {
  return ipcService.invokeDomain<ProjectCapabilitySelection>(IPC_DOMAINS.PROJECT, 'selectCapability', {
    projectId,
    kind,
    capabilityId,
  });
}

export async function unselectCapability(
  projectId: string,
  kind: ProjectCapabilityKind,
  capabilityId: string,
): Promise<{ removed: boolean }> {
  return ipcService.invokeDomain<{ removed: boolean }>(IPC_DOMAINS.PROJECT, 'unselectCapability', {
    projectId,
    kind,
    capabilityId,
  });
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetail> {
  return ipcService.invokeDomain<ProjectDetail>(IPC_DOMAINS.PROJECT, 'detail', { projectId });
}

export async function getProjectSourceGitStates(projectId: string): Promise<ProjectSourceGitState[]> {
  return ipcService.invokeDomain<ProjectSourceGitState[]>(IPC_DOMAINS.PROJECT, 'gitStates', { projectId });
}

export async function updateProject(input: UpdateProjectInput): Promise<ProjectDetail> {
  return ipcService.invokeDomain<ProjectDetail>(IPC_DOMAINS.PROJECT, 'updateProject', input);
}

export async function getProjectArtifacts(projectId: string, limit?: number): Promise<ProjectArtifact[]> {
  return ipcService.invokeDomain<ProjectArtifact[]>(IPC_DOMAINS.PROJECT, 'artifacts', { projectId, limit });
}

export async function getArtifactIssuesByArtifactId(
  artifactIds: string[],
  opts: { status?: ArtifactIssueStatus; limit?: number } = {},
): Promise<Record<string, ArtifactIssue[]>> {
  if (artifactIds.length === 0) return {};
  return ipcService.invokeDomain<Record<string, ArtifactIssue[]>>(IPC_DOMAINS.PROJECT, 'artifactIssues', {
    artifactIds,
    status: opts.status,
    limit: opts.limit,
  });
}

export async function renameProject(projectId: string, name: string): Promise<Project> {
  return ipcService.invokeDomain<Project>(IPC_DOMAINS.PROJECT, 'rename', { projectId, name });
}

export async function setProjectDescription(projectId: string, description: string | null): Promise<Project> {
  return ipcService.invokeDomain<Project>(IPC_DOMAINS.PROJECT, 'setDescription', { projectId, description });
}

export async function setProjectStatus(projectId: string, status: ProjectStatus): Promise<Project> {
  return ipcService.invokeDomain<Project>(IPC_DOMAINS.PROJECT, 'setStatus', { projectId, status });
}

export async function deleteProject(projectId: string): Promise<{ deleted: boolean }> {
  return ipcService.invokeDomain<{ deleted: boolean }>(IPC_DOMAINS.PROJECT, 'deleteProject', { projectId });
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

export async function updateProjectGoalStatus(
  goalId: string,
  status: ProjectGoalStatus,
  opts?: { lastRunSessionId?: string | null },
): Promise<ProjectGoal> {
  return ipcService.invokeDomain<ProjectGoal>(IPC_DOMAINS.PROJECT, 'updateGoalStatus', {
    goalId,
    status,
    lastRunSessionId: opts?.lastRunSessionId,
  });
}

export async function addProjectRole(projectId: string, roleId: string): Promise<ProjectRoleLink> {
  return ipcService.invokeDomain<ProjectRoleLink>(IPC_DOMAINS.PROJECT, 'addRole', { projectId, roleId });
}

export async function removeProjectRole(projectId: string, roleId: string): Promise<{ removed: boolean }> {
  return ipcService.invokeDomain<{ removed: boolean }>(IPC_DOMAINS.PROJECT, 'removeRole', { projectId, roleId });
}
