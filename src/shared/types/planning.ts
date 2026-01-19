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
