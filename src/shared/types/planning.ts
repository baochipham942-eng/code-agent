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
export type SessionTaskStatus = 'pending' | 'in_progress' | 'completed';
export type SessionTaskPriority = 'low' | 'normal' | 'high';

export interface SessionTask {
  id: string;              // 自动生成 "task-{timestamp}-{random}"
  subject: string;         // 祈使句 "Implement login"
  description: string;     // 详细描述
  activeForm: string;      // 进行时 "Implementing login"
  status: SessionTaskStatus;      // pending | in_progress | completed
  priority: SessionTaskPriority;  // low | normal | high

  // 依赖关系
  blocks: string[];        // 此任务阻塞的任务 ID
  blockedBy: string[];     // 阻塞此任务的任务 ID

  // 元数据
  owner?: string;          // Agent 名称（多 Agent 场景）
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
