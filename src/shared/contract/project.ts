// ============================================================================
// Project Space Types (P0-2 项目空间容器)
// ============================================================================
//
// 项目 = 目标（goals）+ 产物集（artifacts）+ 围绕产物工作的 agent（roles）+ 关联会话（sessions）。
// 设计：docs/designs/project-space.md
//
// 关键边界：ProjectGoal 是 goal 的"持久化存储模型"，不复用也不修改 P4 的
// GoalContract（contract/agent.ts）/ GoalRunInput（contract/appService.ts）。
// 要把某条 ProjectGoal 跑起来时由 ProjectService 单向投影成 GoalRunInput。
// ============================================================================

/** 项目状态：派生自 goal/session 活跃度，或用户显式归档 */
export type ProjectStatus = 'active' | 'idle' | 'archived';

/** 项目目标状态 */
export type ProjectGoalStatus = 'active' | 'met' | 'aborted' | 'archived';

export interface Project {
  id: string; // proj_<nanoid12>；proj_unsorted 为保留 ID（无 workspace 的存量会话归桶处）
  name: string;
  workspacePath?: string | null; // 绑定的工作目录绝对路径
  workspaceKey?: string | null; // getProjectKey(workspacePath)，接管项目记忆目录
  status: ProjectStatus;
  description?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
}

export interface ProjectGoal {
  id: string; // pgoal_<nanoid12>
  projectId: string;
  goal: string; // 自然语言目标
  verify?: string | null; // 闸1 shell（可选）
  review?: string | null; // 闸2 软条件（可选）
  status: ProjectGoalStatus;
  lastRunSessionId?: string | null; // 最近一次推进这条 goal 的 session
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRoleLink {
  projectId: string;
  roleId: string; // = agents/<id>.md 注册 id
  joinedAt: number;
}

/** 项目详情聚合（中心视图数据源） */
export interface ProjectDetail {
  project: Project;
  goals: ProjectGoal[];
  roles: ProjectRoleLink[];
  sessionIds: string[];
}

export type ProjectArtifactKind =
  | 'chart'
  | 'spreadsheet'
  | 'document'
  | 'generative_ui'
  | 'mermaid'
  | 'question_form'
  | 'text'
  | 'binary'
  | 'image'
  | 'audio'
  | 'video'
  | 'web'
  | 'search'
  | 'process-output'
  | 'process-log';

/** 项目维度聚合的产物条目（跨该项目所有 session 抽取，中心视图"产物列表"数据源） */
export interface ProjectArtifact {
  /** 内容哈希派生的稳定 ID，用于跨 session 去重 */
  id: string;
  sessionId: string;
  /** 产出该产物的 session 标题（便于在产物列表标注来源） */
  sessionTitle?: string;
  kind: ProjectArtifactKind;
  title?: string;
  createdAt: number;
  path?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  sourceTool?: string;
}

/** 保留项目 ID：无 workspace 的存量会话归入此项目 */
export const UNSORTED_PROJECT_ID = 'proj_unsorted';
export const UNSORTED_PROJECT_NAME = '未分类';

/** 新建项目入参 */
export interface CreateProjectInput {
  name: string;
  workspacePath?: string | null;
  description?: string;
}

/** 新建目标入参 */
export interface CreateProjectGoalInput {
  goal: string;
  verify?: string | null;
  review?: string | null;
}
