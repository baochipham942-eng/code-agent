// ============================================================================
// Planning Types (for Gen 3+ Persistent Planning)
// ============================================================================

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
// blocked 不是持久状态，由 blockedBy 含未完成任务派生（见 taskList 的 blocked 检测）
export type SessionTaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type SessionTaskPriority = 'low' | 'normal' | 'high';

export interface SessionTask {
  id: string;              // 自动生成 "task-{timestamp}-{random}"
  subject: string;         // 祈使句 "Implement login"
  description: string;     // 详细描述
  activeForm: string;      // 进行时 "Implementing login"
  status: SessionTaskStatus;      // pending | in_progress | completed | cancelled
  priority: SessionTaskPriority;  // low | normal | high

  // 依赖关系
  blocks: string[];        // 此任务阻塞的任务 ID
  blockedBy: string[];     // 阻塞此任务的任务 ID

  // 树状结构（roadmap 2.6）：子任务 id 形如 "1.1"、"1.1.2"，由父 id 派生
  parentTaskId?: string;

  // 元数据
  owner?: string;          // Agent 名称（多 Agent 场景；subagent 创建的任务默认归 subagent）
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
