// ============================================================================
// Project Space Types (P0-2 项目空间容器)
// ============================================================================
//
// 项目 = 目标（goals）+ 产物集（artifacts）+ 围绕产物工作的 agent（roles）+ 关联会话（sessions）。
// 设计：内部文档
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
  /** 用户显式升级为协作空间的时间；null 表示仍是自动派生的普通项目。 */
  spacePromotedAt?: number | null;
  /** 对应 collab_projects.id；null 表示该项目仍是纯本地空间。 */
  cloudProjectId?: string | null;
  /** Monotonic revision for atomic source edits and immutable run snapshots. */
  sourceRevision?: number;
}

/** 云协同空间成员（project 域 listMembers 返回行；形状与 host ProjectMember 一致） */
export interface ProjectMember {
  projectId: string;
  userId: string;
  role: 'owner' | 'member';
  displayName: string | null;
  avatarUrl: string | null;
  joinedAt: string;
}

/** 空间邀请码（project 域 createInvite 返回；形状与 host ProjectInvite 一致） */
export interface ProjectInvite {
  code: string;
  projectId: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  revokedAt: string | null;
}

/** 升级为云协同空间的结果（project 域 promoteToCloudSpace 返回） */
export interface CloudSpacePromotion {
  localProjectId: string;
  cloudProjectId: string;
  name: string;
}

export type ProjectSourceRole = 'primary' | 'additional';
export type ProjectSourceAccess = 'read_only' | 'read_write';
export type ProjectSourceTrustState = 'trusted' | 'blocked';

export type ProjectSourceTrustFailureKind =
  | 'source_missing'
  | 'identity_changed'
  | 'not_trusted';

export interface ProjectSourceTrustFailureMarker {
  code: 'PROJECT_SOURCE_TRUST';
  kind: ProjectSourceTrustFailureKind;
}

export interface ProjectSource {
  id: string;
  projectId: string;
  path: string;
  canonicalPath: string;
  role: ProjectSourceRole;
  access: ProjectSourceAccess;
  trustState: ProjectSourceTrustState;
  identityDev?: string | null;
  identityIno?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceRoot {
  sourceId: string;
  path: string;
  access: ProjectSourceAccess;
  role: ProjectSourceRole;
  identityDev?: string | null;
  identityIno?: string | null;
}

export interface WorkspaceScope {
  projectId: string;
  primaryRoot: string;
  roots: readonly WorkspaceRoot[];
  version: string;
}

export interface ProjectSourceGitState {
  sourceId: string;
  isRepository: boolean;
  repositoryRoot?: string;
  headSha?: string;
  branch?: string;
  dirtyFiles?: string[];
  ahead?: number;
  behind?: number;
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

export type ProjectCapabilityKind = 'skill' | 'connector' | 'automation';

export interface ProjectCapabilitySelection {
  projectId: string;
  kind: ProjectCapabilityKind;
  capabilityId: string;
  selectedAt: number;
}

export interface ProjectWithActivity extends Project {
  activeTopicCount: number;
  lastActivityAt: number | null;
}

/** 项目详情聚合（中心视图数据源） */
export interface ProjectDetail {
  project: Project;
  sources: ProjectSource[];
  goals: ProjectGoal[];
  roles: ProjectRoleLink[];
  sessionIds: string[];
}

export type ProjectArtifactKind =
  | 'chart'
  | 'spreadsheet'
  | 'document'
  | 'generative_ui'
  | 'neo_ui'
  | 'mermaid'
  | 'question_form'
  | 'file'
  | 'generic_html'
  | 'web_snapshot'
  | 'link'
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
  /** 产出该产物的 assistant message；用于 Workspace Preview 精确选中同一 artifact item */
  messageId?: string;
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
  toolCallId?: string;
  toolName?: string;
  previewItemId?: string;
  sourceId?: string;
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

/** 新建显式协作空间入参；无目录空间沿用 projects 的 null workspace 形态。 */
export interface CreateSpaceInput {
  name: string;
  description?: string;
  workspacePath?: string | null;
  /** 知情确认：目录含危险项时用户已在确认步看过清单并再点创建（批P 第六波①a 创建即信任） */
  trustAcknowledged?: boolean;
}

/**
 * 创建即信任：目录含危险项且未知情确认时 host 抛的 coded 错误前缀（domain:project 契约的一部分），
 * renderer 凭此前缀在同一 Modal 内切确认步，不 toast 报错。
 */
export const FOLDER_TRUST_CONFIRM_REQUIRED_PREFIX = 'FOLDER_TRUST_CONFIRM_REQUIRED:';

/** 将已有普通项目升级为显式协作空间。 */
export interface PromoteToSpaceInput {
  projectId: string;
  /** 同 CreateSpaceInput.trustAcknowledged：升级目录含危险项时的知情确认 */
  trustAcknowledged?: boolean;
}

export interface ProjectSourceInput {
  id?: string;
  path: string;
  role: ProjectSourceRole;
  access: ProjectSourceAccess;
  trustState?: ProjectSourceTrustState;
}

export interface UpdateProjectInput {
  projectId: string;
  revision: number;
  name: string;
  description?: string | null;
  sources: ProjectSourceInput[];
  /** User-confirmed removals whose current Git working tree is dirty. */
  confirmedDirtySourceIds?: string[];
}

/** 新建目标入参 */
export interface CreateProjectGoalInput {
  goal: string;
  verify?: string | null;
  review?: string | null;
}
