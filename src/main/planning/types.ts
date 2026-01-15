// ============================================================================
// Planning System Types
// ============================================================================

// ----------------------------------------------------------------------------
// Task Plan Types
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// Error Tracking Types
// ----------------------------------------------------------------------------

export interface ErrorRecord {
  id: string;
  toolName: string;
  message: string;
  params?: Record<string, unknown>;
  stack?: string;
  timestamp: number;
  count: number;
}

// ----------------------------------------------------------------------------
// Findings Types
// ----------------------------------------------------------------------------

export type FindingCategory = 'code' | 'architecture' | 'dependency' | 'issue' | 'insight';

export interface Finding {
  id: string;
  category: FindingCategory;
  title: string;
  content: string;
  source?: string;
  timestamp: number;
}

// ----------------------------------------------------------------------------
// Hook Types
// ----------------------------------------------------------------------------

export type HookType =
  | 'session_start'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'on_stop'
  | 'on_error';

export interface HookContext {
  toolName?: string;
  toolParams?: Record<string, unknown>;
  toolResult?: {
    success: boolean;
    output?: string;
    error?: string;
  };
  error?: Error;
  actionCount?: number;
}

export interface HookResult {
  shouldContinue: boolean;
  injectContext?: string;
  notification?: string;
}

// ----------------------------------------------------------------------------
// Planning Service Config
// ----------------------------------------------------------------------------

export interface PlanningConfig {
  workingDirectory: string;
  sessionId: string;
  autoCreatePlan?: boolean;
  syncToTodoWrite?: boolean;
}

export interface PlanningHooksConfig {
  preToolUse: boolean;
  postToolUse: boolean;
  onStop: boolean;
  onError: boolean;
}

export interface PlanningRulesConfig {
  actionThreshold: number;  // 2-Action Rule
  errorStrikeLimit: number; // 3-Strike Rule
}
