// ============================================================================
// Planning Types (for Gen 3+ Persistent Planning)
// ============================================================================

import type { EvidenceRef } from './evidence';

// Todo Types (for Gen 3+)
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

// ============================================================================
// Session Task Types (Claude Code 2.x compatible Task API)
// ============================================================================

// 使用前缀避免与其他模块的 TaskStatus/TaskPriority 冲突
// cancelled: 主动放弃但留痕可见（区别于 update status='deleted' 的物理删除）
// blocked: 卡在外部障碍上（拿不到权限/网站拒绝/缺信息），必须带 blockedReason。
//   与 blockedBy 派生的"等前置任务"不同——后者仍是 pending，由 taskList 派生展示。
export type SessionTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
export type SessionTaskPriority = 'low' | 'normal' | 'high';

/**
 * blocked 原因的语义分类（面向非程序员的展示层用它选文案，不直接暴露 raw error）。
 * 由 host 侧 describeTaskBlockedReason() 从 agent 写的原始文本推断。
 */
export type TaskBlockedCategory =
  | 'network'
  | 'rate_limit'
  | 'permission'
  | 'resource'
  | 'tool'
  | 'model'
  | 'logic'
  /** 子代理结束时把没收口的任务交还主会话，等主会话核实后再收口 */
  | 'handback'
  | 'unknown';

export interface SessionTask {
  id: string;              // 自动生成 "task-{timestamp}-{random}"
  subject: string;         // 祈使句 "Implement login"
  description: string;     // 详细描述
  activeForm: string;      // 进行时 "Implementing login"
  status: SessionTaskStatus;      // pending | in_progress | completed | blocked | cancelled
  priority: SessionTaskPriority;  // low | normal | high

  // 依赖关系
  blocks: string[];        // 此任务阻塞的任务 ID
  blockedBy: string[];     // 阻塞此任务的任务 ID

  // 树状结构（roadmap 2.6）：子任务 id 形如 "1.1"、"1.1.2"，由父 id 派生
  parentTaskId?: string;

  // 证据门（ADR-050）：completed 必须留 evidenceRefs，blocked 必须留可展示的原因
  /** 已过语义化清洗、可直接展示给用户的阻塞说明；raw 原文只进事件日志 */
  blockedReason?: string;
  blockedReasonCategory?: TaskBlockedCategory;

  // 元数据
  owner?: string;          // Agent 名称（多 Agent 场景；subagent 创建的任务默认归 subagent）
  evidenceRefs?: EvidenceRef[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskInput {
  subject: string;
  description: string;
  activeForm?: string;
  priority?: SessionTaskPriority;
  metadata?: Record<string, unknown>;
  /** 父任务 id（树状分解，roadmap 2.6）；父任务必须存在 */
  parentTaskId?: string;
  /** 任务所有者（subagent 所有权语义） */
  owner?: string;
}

// ============================================================================
// Session Task 事件日志（roadmap 2.6）— 可审计的任务生命周期
// ============================================================================

export type SessionTaskEventKind =
  | 'created'
  | 'started'        // pending → in_progress
  | 'unstarted'      // in_progress → pending
  | 'done'           // → completed
  | 'abandoned'      // → cancelled
  | 'renamed'        // subject 变化
  | 'blocked'        // 新增 blockedBy 依赖
  | 'unblocked'      // 阻塞任务被删除/收口导致依赖解除
  | 'owner_changed'  // owner 显式变更
  | 'orphan_adopted' // subagent 结束，未收口任务回归主会话
  | 'parent_detached' // 父任务被删除，子任务脱挂为顶层
  | 'deleted';       // 物理删除

export interface SessionTaskEvent {
  sessionId: string;
  taskId: string;
  at: number;
  kind: SessionTaskEventKind;
  /** 事件补充说明（如 renamed 的新标题、orphan_adopted 的原 owner） */
  summary?: string;
  /** 触发者（owner/agent id），可空 */
  actor?: string;
}

export interface UpdateTaskInput {
  status?: SessionTaskStatus | 'deleted';
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  addBlockedBy?: string[];
  addBlocks?: string[];
  metadata?: Record<string, unknown>;
  /** 已清洗的阻塞说明（写 blocked 时必填，改成其它状态时自动清空） */
  blockedReason?: string;
  blockedReasonCategory?: TaskBlockedCategory;
  /** 追加的完成证据；写 completed 时必填 */
  evidenceRefs?: EvidenceRef[];
  /** 事件日志补充说明（done/blocked/abandoned 的原文，只进审计不进 UI） */
  statusSummary?: string;
}

// ============================================================================
// 证据门（ADR-050）
//
// maka task ledger 语义：completed/blocked 必须带证据，任务状态是 advisory —
// 它记录 agent 声称做了什么，绝不 override 真实 filesystem/git/test 结果。
// 所有写状态的工具入口（update / replace / patch）共用这一个校验，别按 action
// 分别写——按名字枚举的门迟早漏一条路径。
// ============================================================================

export interface TaskEvidenceInput {
  completionEvidence?: unknown;
  blockedReason?: unknown;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 校验状态转移所需的证据。返回 null 表示放行，返回字符串是给模型看的报错。
 */
export function validateTaskStatusEvidence(
  status: unknown,
  input: TaskEvidenceInput,
): string | null {
  if (status === 'completed' && !hasText(input.completionEvidence)) {
    return 'status="completed" requires completionEvidence: state what you actually verified '
      + '(command run and its result, file checked, page observed). '
      + 'If a subagent reported success, verify it yourself first — a subagent report is not evidence.';
  }
  if (status === 'blocked' && !hasText(input.blockedReason)) {
    return 'status="blocked" requires blockedReason: say what is blocking the task in plain language '
      + '(e.g. "the site requires a login we do not have"), not a raw error dump.';
  }
  return null;
}

// Task Plan Types
export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';
export type TaskPhaseStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface TaskStep {
  id: string;
  content: string;
  status: TaskStepStatus;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskPhase {
  id: string;
  title: string;
  status: TaskPhaseStatus;
  steps: TaskStep[];
  notes?: string;
}

export interface TaskPlanMetadata {
  totalSteps: number;
  completedSteps: number;
  blockedSteps: number;
}

export interface TaskPlan {
  id: string;
  title: string;
  objective: string;
  phases: TaskPhase[];
  createdAt: number;
  updatedAt: number;
  metadata: TaskPlanMetadata;
}

// Finding Types
export type FindingCategory = 'code' | 'architecture' | 'dependency' | 'issue' | 'insight';

export interface Finding {
  id: string;
  category: FindingCategory;
  title: string;
  content: string;
  source?: string;
  timestamp: number;
}

// Error Record Types
export interface ErrorRecord {
  id: string;
  toolName: string;
  message: string;
  params?: Record<string, unknown>;
  stack?: string;
  timestamp: number;
  count: number;
}

// Planning State
export interface PlanningState {
  plan: TaskPlan | null;
  findings: Finding[];
  errors: ErrorRecord[];
}
