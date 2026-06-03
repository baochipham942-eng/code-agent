// ============================================================================
// ProjectService - 项目空间业务编排（P0-2）
// ============================================================================
//
// 薄编排层：ID/时间戳在此生成，委托 ProjectRepository 落库；接管 workspace
// 记忆 key（写 meta.json projectId，记忆文件不动）。
// 设计：docs/designs/project-space.md §5.2
// ============================================================================

import * as path from 'path';
import { randomUUID } from 'crypto';
import { getDatabase } from '../core/databaseService';
import type { ProjectRepository } from '../core/repositories';
import { getProjectKey } from '../roleAssets/roleAssetPaths';
import { linkProjectIdToMeta } from '../roleAssets/roleAssetService';
import { createLogger } from '../infra/logger';
import { extractArtifacts } from '../../agent/artifactExtractor';
import type { GoalRunInput } from '../../../shared/contract/appService';
import {
  UNSORTED_PROJECT_ID,
  UNSORTED_PROJECT_NAME,
  type CreateProjectGoalInput,
  type Project,
  type ProjectArtifact,
  type ProjectDetail,
  type ProjectGoal,
  type ProjectGoalStatus,
  type ProjectRoleLink,
  type ProjectStatus,
} from '../../../shared/contract/project';

const logger = createLogger('ProjectService');

function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** 跨 session 抽取 artifact 并按内容哈希去重、时间倒序、取前 limit（纯函数，便于单测）。 */
export function buildProjectArtifacts(
  sessions: Array<{ id: string; title: string }>,
  loadMessages: (sessionId: string) => Array<{ role: string; content: string; timestamp: number }>,
  limit = 60,
): ProjectArtifact[] {
  const seen = new Set<string>();
  const items: ProjectArtifact[] = [];
  for (const session of sessions) {
    for (const msg of loadMessages(session.id)) {
      if (msg.role !== 'assistant' || !msg.content) continue;
      for (const art of extractArtifacts(msg.content)) {
        if (seen.has(art.id)) continue;
        seen.add(art.id);
        items.push({
          id: art.id,
          sessionId: session.id,
          sessionTitle: session.title || undefined,
          kind: art.type,
          title: art.title,
          createdAt: msg.timestamp,
        });
      }
    }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** 由 workspace 路径构造一个新 Project 行（不落库，仅生成实体）。 */
function buildProjectRow(workspacePath: string, key: string, now: number): Project {
  return {
    id: shortId('proj'),
    name: path.basename(path.resolve(workspacePath)) || workspacePath,
    workspacePath: path.resolve(workspacePath),
    workspaceKey: key,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

export class ProjectService {
  private repo(): ProjectRepository {
    return getDatabase().getProjectRepo();
  }

  /**
   * D2 隐式懒创建：按 workspace 路径拿/建 project，并接管项目记忆 key。
   * session 创建链路调用它拿 project_id。空路径返回 UNSORTED 项目。
   */
  async ensureProjectForWorkspace(workspacePath: string | undefined, now: number): Promise<Project> {
    const dir = (workspacePath || '').trim();
    if (!dir) return this.ensureUnsorted(now);

    const key = getProjectKey(dir);
    const repo = this.repo();
    const existing = repo.getProjectByWorkspaceKey(key);
    if (existing) return existing;

    const project = buildProjectRow(dir, key, now);
    repo.upsertProject(project);
    // 接管项目记忆目录的 key（写 meta.json projectId，记忆文件不动）
    void linkProjectIdToMeta(dir, project.id).catch((err) =>
      logger.warn('[ProjectService] linkProjectIdToMeta failed:', err instanceof Error ? err.message : String(err)),
    );
    return project;
  }

  private ensureUnsorted(now: number): Project {
    const repo = this.repo();
    const existing = repo.getProject(UNSORTED_PROJECT_ID);
    if (existing) return existing;
    const unsorted: Project = {
      id: UNSORTED_PROJECT_ID,
      name: UNSORTED_PROJECT_NAME,
      workspacePath: null,
      workspaceKey: null,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    repo.upsertProject(unsorted);
    return unsorted;
  }

  /** D4 启动迁移归桶：把存量无 project_id 的 session 按 workspace 自动归桶。返回归桶数。 */
  backfillSessions(now: number): number {
    return this.repo().backfillSessions(now, (workspacePath, key) => buildProjectRow(workspacePath, key, now));
  }

  listProjects(includeArchived = false): Project[] {
    return this.repo().listProjects(includeArchived);
  }

  /** 中心视图数据源：project + goals + roles + sessionIds */
  getProjectDetail(projectId: string): ProjectDetail | undefined {
    const repo = this.repo();
    const project = repo.getProject(projectId);
    if (!project) return undefined;
    return {
      project,
      goals: repo.listGoals(projectId),
      roles: repo.listRoles(projectId),
      sessionIds: repo.listSessionIds(projectId),
    };
  }

  /**
   * 中心视图"产物列表"数据源：跨该项目所有 session 抽取 artifact，按内容哈希去重、时间倒序、取前 limit。
   * 产物 = assistant 消息内 chart/spreadsheet/mermaid/generative_ui/question-form 代码块（extractArtifacts）。
   */
  getProjectArtifacts(projectId: string, limit = 60): ProjectArtifact[] {
    const db = getDatabase();
    const repo = this.repo();
    if (!repo.getProject(projectId)) return [];
    const sessions = repo.listProjectSessions(projectId);
    return buildProjectArtifacts(sessions, (sessionId) => db.getMessages(sessionId), limit);
  }

  renameProject(projectId: string, name: string, now: number): Project | undefined {
    const repo = this.repo();
    if (!repo.getProject(projectId)) return undefined;
    repo.renameProject(projectId, name, now);
    return repo.getProject(projectId);
  }

  setProjectStatus(projectId: string, status: ProjectStatus, now: number): Project | undefined {
    const repo = this.repo();
    if (!repo.getProject(projectId)) return undefined;
    repo.setProjectStatus(projectId, status, now, status === 'archived' ? now : null);
    return repo.getProject(projectId);
  }

  // --- goals ---

  addGoal(projectId: string, input: CreateProjectGoalInput, now: number): ProjectGoal | undefined {
    const repo = this.repo();
    if (!repo.getProject(projectId)) return undefined;
    const goal: ProjectGoal = {
      id: shortId('pgoal'),
      projectId,
      goal: input.goal,
      verify: input.verify ?? null,
      review: input.review ?? null,
      status: 'active',
      lastRunSessionId: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.insertGoal(goal);
    repo.touchProject(projectId, now);
    return goal;
  }

  updateGoalStatus(
    goalId: string,
    status: ProjectGoalStatus,
    now: number,
    lastRunSessionId?: string | null,
  ): ProjectGoal | undefined {
    const repo = this.repo();
    const goal = repo.getGoal(goalId);
    if (!goal) return undefined;
    repo.updateGoalStatus(goalId, status, now, lastRunSessionId);
    repo.touchProject(goal.projectId, now);
    return repo.getGoal(goalId);
  }

  /**
   * §7 单向投影：把一条持久化 ProjectGoal 投影成 P4 的 GoalRunInput 交给现有 goal 链路。
   * 只读，不修改 GoalContract / GoalRunInput 契约本身。
   */
  projectGoalToRunInput(goalId: string): GoalRunInput | undefined {
    const goal = this.repo().getGoal(goalId);
    if (!goal) return undefined;
    return {
      goal: goal.goal,
      verify: goal.verify ?? undefined,
      review: goal.review ?? undefined,
    };
  }

  // --- roles（D6 角色入驻）---

  addRole(projectId: string, roleId: string, now: number): ProjectRoleLink | undefined {
    const repo = this.repo();
    if (!repo.getProject(projectId)) return undefined;
    const link: ProjectRoleLink = { projectId, roleId, joinedAt: now };
    repo.addRole(link);
    repo.touchProject(projectId, now);
    return link;
  }

  removeRole(projectId: string, roleId: string, now: number): boolean {
    const repo = this.repo();
    const ok = repo.removeRole(projectId, roleId);
    if (ok) repo.touchProject(projectId, now);
    return ok;
  }
}

let instance: ProjectService | null = null;

export function getProjectService(): ProjectService {
  if (!instance) instance = new ProjectService();
  return instance;
}
