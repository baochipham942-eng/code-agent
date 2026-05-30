// ============================================================================
// Workflow Types - Type-safe definitions for multi-agent workflows
// ============================================================================


// ============================================================================
// Core Types
// ============================================================================

/**
 * 工作流阶段工具策略模式。
 *
 * `readOnly` / `noTool` are accepted as ergonomic aliases for custom workflow
 * authors; runtime metadata normalizes them to `readonly` / `none`.
 */
export type WorkflowStageToolPolicyMode =
  | 'inherit'
  | 'none'
  | 'noTool'
  | 'readonly'
  | 'readOnly'
  | 'allowlist';

/**
 * 工作流阶段工具策略。
 */
export interface WorkflowStageToolPolicy {
  /** 工具策略模式；省略时默认继承角色工具，若提供 tools 则按 allowlist 处理 */
  mode?: WorkflowStageToolPolicyMode;
  /** allowlist 模式下允许的工具名，不会扩张出该角色原本没有的工具 */
  tools?: string[];
  /** 单阶段最多允许执行的工具调用数；none / noTool 会强制为 0 */
  maxToolCalls?: number;
}

export type ResolvedWorkflowStageToolPolicyMode =
  | 'inherit'
  | 'none'
  | 'readonly'
  | 'allowlist';

/**
 * 阶段执行后记录的工具策略快照。
 */
export interface WorkflowStageToolPolicySnapshot {
  mode: ResolvedWorkflowStageToolPolicyMode;
  requestedTools?: string[];
  maxToolCalls?: number;
  availableTools: string[];
  blockedTools: string[];
}

/**
 * 工作流阶段定义
 */
export interface WorkflowStage {
  /** 阶段名称（用于依赖引用和日志） */
  name: string;
  /** 执行该阶段的 Agent 角色（built-in 或 predefined） */
  role: string;
  /** 该阶段的任务提示词 */
  prompt: string;
  /** 依赖的前置阶段名称列表 */
  dependsOn?: string[];
  /** 阶段级工具策略 */
  toolPolicy?: WorkflowStageToolPolicy;
  /** 阶段最长执行时间；省略时由 workflow runtime 使用适合子智能体的默认预算 */
  maxExecutionTimeMs?: number;
}

/**
 * 工作流模板定义
 */
export interface WorkflowTemplate {
  /** 模板显示名称 */
  name: string;
  /** 模板描述 */
  description: string;
  /** 阶段列表 */
  stages: WorkflowStage[];
  /** 标签（用于分类和搜索） */
  tags?: string[];
}

/**
 * 内置工作流模板 ID
 */
export type BuiltInWorkflowId =
  | 'code-review-pipeline'
  | 'bug-fix-flow'
  | 'documentation-flow'
  | 'parallel-review'
  | 'image-annotation'
  | 'image-ocr-annotate';

// ============================================================================
// Stage Execution Types
// ============================================================================

/**
 * 阶段上下文 - 用于在阶段之间传递结构化数据
 */
export interface StageContext {
  /** 文本输出 */
  textOutput: string;
  /** 结构化数据（从输出中解析的 JSON） */
  structuredData?: Record<string, unknown>;
  /** 生成的文件 */
  generatedFiles?: GeneratedFile[];
  /** 工具调用记录 */
  toolsUsed: string[];
  /** 阶段级工具策略快照 */
  toolPolicy?: WorkflowStageToolPolicySnapshot;
  /** 执行时间（毫秒） */
  duration: number;
}

/**
 * 生成的文件信息
 */
export interface GeneratedFile {
  /** 文件路径 */
  path: string;
  /** 文件类型 */
  type: 'image' | 'text' | 'data';
}

/**
 * 阶段执行结果
 */
export interface StageResult {
  /** 阶段名称 */
  stage: string;
  /** 执行的 Agent 角色 */
  role: string;
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output: string;
  /** 错误信息 */
  error?: string;
  /** 执行时间（毫秒） */
  duration: number;
  /** 结构化上下文 */
  context?: StageContext;
}

// ============================================================================
// Workflow Execution Types
// ============================================================================

/**
 * 工作流执行状态
 */
export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * 工作流执行记录
 */
export interface WorkflowExecution {
  /** 执行 ID */
  id: string;
  /** 工作流模板 ID */
  workflowId: string;
  /** 工作流名称 */
  workflowName: string;
  /** 任务描述 */
  task: string;
  /** 执行状态 */
  status: WorkflowStatus;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 各阶段结果 */
  stageResults: StageResult[];
  /** 总耗时（毫秒） */
  totalDuration?: number;
  /** 错误信息 */
  error?: string;
}

/**
 * 工作流执行选项
 */
export interface WorkflowExecutionOptions {
  /** 是否并行执行独立阶段（默认 true） */
  parallel?: boolean;
  /** 单阶段最大迭代次数 */
  maxIterationsPerStage?: number;
  /** 工作流总预算（USD） */
  maxBudget?: number;
}

// ============================================================================
// Re-export from workflowTemplates.ts for backward compatibility
// ============================================================================
export {
  BUILT_IN_WORKFLOWS,
  getBuiltInWorkflow,
  isBuiltInWorkflowId,
  listBuiltInWorkflowIds,
  listBuiltInWorkflows,
  getBuiltInWorkflowsByTag,
  validateWorkflowDependencies,
} from './workflowTemplates';
