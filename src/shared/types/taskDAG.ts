// ============================================================================
// Task DAG Types - Type-safe definitions for task dependency graph
// Session 4: Task DAG + Parallel Scheduling
// ============================================================================

// ============================================================================
// Core Task Types
// ============================================================================

/**
 * 任务状态
 * 完整的状态机：pending → ready → running → completed/failed/cancelled
 */
export type TaskStatus =
  | 'pending'     // 等待依赖完成
  | 'ready'       // 依赖已满足，可以执行
  | 'running'     // 正在执行
  | 'completed'   // 执行成功
  | 'failed'      // 执行失败
  | 'cancelled'   // 被取消
  | 'skipped';    // 因上游失败而跳过

/**
 * 任务优先级
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * 任务元数据
 */
export interface TaskMetadata {
  /** 任务创建时间 */
  createdAt: number;
  /** 任务开始执行时间 */
  startedAt?: number;
  /** 任务完成时间 */
  completedAt?: number;
  /** 执行耗时（毫秒） */
  duration?: number;
  /** 重试次数 */
  retryCount: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 估计耗时（毫秒） */
  estimatedDuration?: number;
  /** 实际消耗成本（USD） */
  cost?: number;
}

/**
 * 任务执行上下文 - 用于传递给执行器的信息
 */
export interface TaskExecutionContext {
  /** 从依赖任务继承的输出 */
  dependencyOutputs: Map<string, TaskOutput>;
  /** 共享上下文数据 */
  sharedData: Map<string, unknown>;
  /** 当前工作目录 */
  workingDirectory: string;
  /** 预算剩余（USD） */
  remainingBudget?: number;
}

/**
 * 任务输出
 */
export interface TaskOutput {
  /** 文本输出 */
  text: string;
  /** 结构化数据 */
  data?: Record<string, unknown>;
  /** 生成的文件列表 */
  files?: Array<{ path: string; type: 'image' | 'text' | 'data' }>;
  /** 使用的工具 */
  toolsUsed?: string[];
  /** 迭代次数 */
  iterations?: number;
}

/**
 * 任务失败信息
 */
export interface TaskFailure {
  /** 错误消息 */
  message: string;
  /** 错误代码 */
  code?: string;
  /** 是否可重试 */
  retryable: boolean;
  /** 原始错误堆栈 */
  stack?: string;
}

/**
 * DAG 中的任务节点
 */
export interface DAGTask {
  /** 任务唯一 ID */
  id: string;
  /** 任务名称（用于显示） */
  name: string;
  /** 任务描述 */
  description?: string;
  /** 任务类型 */
  type: DAGTaskType;
  /** 当前状态 */
  status: TaskStatus;
  /** 优先级 */
  priority: TaskPriority;
  /** 元数据 */
  metadata: TaskMetadata;

  // 依赖关系
  /** 前置依赖任务 ID 列表 */
  dependencies: string[];
  /** 后续依赖任务 ID 列表（被哪些任务依赖） */
  dependents: string[];

  // 执行配置
  /** 执行配置（根据 type 不同而不同） */
  config: TaskConfig;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 是否允许失败后继续（不阻塞依赖它的任务） */
  allowFailure?: boolean;

  // 执行结果
  /** 任务输出 */
  output?: TaskOutput;
  /** 失败信息 */
  failure?: TaskFailure;
}

/**
 * 任务类型
 */
export type DAGTaskType =
  | 'agent'       // Agent 执行任务
  | 'workflow'    // 嵌套工作流
  | 'function'    // 简单函数调用
  | 'shell'       // Shell 命令
  | 'parallel'    // 并行任务组
  | 'conditional' // 条件分支
  | 'checkpoint'  // 检查点（用于同步/等待）
  | 'evaluate';   // 评估任务（从候选中选择最优）

/**
 * 任务配置联合类型
 */
export type TaskConfig =
  | AgentTaskConfig
  | WorkflowTaskConfig
  | FunctionTaskConfig
  | ShellTaskConfig
  | ParallelTaskConfig
  | ConditionalTaskConfig
  | CheckpointTaskConfig
  | EvaluateTaskConfig;

/**
 * Agent 任务配置
 */
export interface AgentTaskConfig {
  type: 'agent';
  /** Agent 角色 ID（built-in 或 predefined） */
  role: string;
  /** 任务提示词 */
  prompt: string;
  /** 自定义系统提示词（可选，覆盖角色默认） */
  systemPrompt?: string;
  /** 可用工具列表（可选，覆盖角色默认） */
  tools?: string[];
  /** 最大迭代次数 */
  maxIterations?: number;
  /** 单任务预算（USD） */
  maxBudget?: number;
}

/**
 * 嵌套工作流任务配置
 */
export interface WorkflowTaskConfig {
  type: 'workflow';
  /** 工作流 ID 或自定义工作流 */
  workflowId?: string;
  /** 工作流参数 */
  parameters?: Record<string, unknown>;
  /** 内联定义的子任务 */
  tasks?: DAGTask[];
}

/**
 * 函数任务配置
 */
export interface FunctionTaskConfig {
  type: 'function';
  /** 函数名称（需要注册） */
  functionName: string;
  /** 函数参数 */
  args?: unknown[];
  /** 是否同步执行 */
  sync?: boolean;
}

/**
 * Shell 命令任务配置
 */
export interface ShellTaskConfig {
  type: 'shell';
  /** 要执行的命令 */
  command: string;
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
}

/**
 * 并行任务组配置
 */
export interface ParallelTaskConfig {
  type: 'parallel';
  /** 并行执行的任务 ID 列表 */
  taskIds: string[];
  /** 最大并行度 */
  maxConcurrency?: number;
  /** 失败策略: 'fail-fast' 立即失败, 'continue' 继续执行其他 */
  failureStrategy?: 'fail-fast' | 'continue';
}

/**
 * 条件分支任务配置
 */
export interface ConditionalTaskConfig {
  type: 'conditional';
  /** 条件表达式（支持简单的布尔表达式） */
  condition: string;
  /** 条件为真时执行的任务 ID */
  trueBranch: string;
  /** 条件为假时执行的任务 ID */
  falseBranch?: string;
  /** 条件评估函数名（优先于 condition） */
  evaluator?: string;
}

/**
 * 检查点任务配置
 */
export interface CheckpointTaskConfig {
  type: 'checkpoint';
  /** 检查点名称 */
  name: string;
  /** 是否需要所有前置任务都成功 */
  requireAllSuccess?: boolean;
  /** 收集前置任务的输出 */
  collectOutputs?: boolean;
}

/**
 * 评估任务配置
 * 用于从多个候选方案中选择最优
 */
export interface EvaluateTaskConfig {
  type: 'evaluate';
  /** 候选任务 ID 列表（这些任务的输出将被评估） */
  candidateTaskIds: string[];
  /** 评估维度 */
  dimensions: EvaluationDimension[];
  /** 选择策略 */
  selectionStrategy: EvaluateSelectionStrategy;
  /** 是否自动应用最优方案 */
  autoApply?: boolean;
  /** 自定义评估提示词 */
  customPrompt?: string;
}

/**
 * 评估维度
 */
export type EvaluationDimension =
  | 'correctness'     // 正确性
  | 'efficiency'      // 效率
  | 'readability'     // 可读性
  | 'maintainability' // 可维护性
  | 'security'        // 安全性
  | 'performance'     // 性能
  | 'coverage'        // 覆盖度
  | 'simplicity';     // 简洁性

/**
 * 评估选择策略
 */
export type EvaluateSelectionStrategy =
  | 'best'     // 单评审员选择最优
  | 'vote'     // 多评审员投票
  | 'weighted'; // 加权评分

/**
 * 评估结果
 */
export interface EvaluationResult {
  /** 获胜的候选任务 ID */
  winnerId: string;
  /** 各候选的得分 */
  scores: Array<{
    taskId: string;
    score: number;
    breakdown: Record<EvaluationDimension, number>;
    reasoning: string;
  }>;
  /** 评估耗时 */
  duration: number;
}

// ============================================================================
// DAG Types
// ============================================================================

/**
 * DAG 执行状态
 */
export type DAGStatus =
  | 'idle'        // 未开始
  | 'running'     // 执行中
  | 'paused'      // 暂停
  | 'completed'   // 全部完成
  | 'failed'      // 执行失败
  | 'cancelled';  // 被取消

/**
 * DAG 执行统计
 */
export interface DAGStatistics {
  /** 总任务数 */
  totalTasks: number;
  /** 已完成任务数 */
  completedTasks: number;
  /** 失败任务数 */
  failedTasks: number;
  /** 取消/跳过任务数 */
  skippedTasks: number;
  /** 正在运行任务数 */
  runningTasks: number;
  /** 等待中任务数 */
  pendingTasks: number;
  /** 就绪任务数（可立即执行） */
  readyTasks: number;
  /** 总耗时（毫秒） */
  totalDuration: number;
  /** 总成本（USD） */
  totalCost: number;
  /** 最大达到的并行度 */
  maxParallelism: number;
  /** 关键路径耗时 */
  criticalPathDuration?: number;
}

/**
 * DAG 配置选项
 */
export interface DAGOptions {
  /** 最大并行度 */
  maxParallelism: number;
  /** 默认任务超时（毫秒） */
  defaultTimeout: number;
  /** 默认最大重试次数 */
  defaultMaxRetries: number;
  /** 全局预算（USD） */
  globalBudget?: number;
  /** 失败策略 */
  failureStrategy: 'fail-fast' | 'continue' | 'retry-then-continue';
  /** 是否启用任务输出传递 */
  enableOutputPassing: boolean;
  /** 是否启用共享上下文 */
  enableSharedContext: boolean;
}

/**
 * DAG 默认配置
 */
export const DEFAULT_DAG_OPTIONS: DAGOptions = {
  maxParallelism: 4,
  defaultTimeout: 120000, // 2 分钟
  defaultMaxRetries: 0,
  failureStrategy: 'fail-fast',
  enableOutputPassing: true,
  enableSharedContext: true,
};

/**
 * Task DAG 定义
 */
export interface TaskDAGDefinition {
  /** DAG 唯一 ID */
  id: string;
  /** DAG 名称 */
  name: string;
  /** DAG 描述 */
  description?: string;
  /** 任务节点 */
  tasks: DAGTask[];
  /** 配置选项 */
  options: DAGOptions;
}

/**
 * DAG 运行时状态
 */
export interface TaskDAGState {
  /** DAG 定义 */
  definition: TaskDAGDefinition;
  /** 当前状态 */
  status: DAGStatus;
  /** 执行统计 */
  statistics: DAGStatistics;
  /** 开始时间 */
  startedAt?: number;
  /** 完成时间 */
  completedAt?: number;
  /** 共享上下文 */
  sharedContext: Map<string, unknown>;
  /** 错误信息 */
  error?: string;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * DAG 事件类型
 */
export type DAGEventType =
  | 'dag:start'
  | 'dag:complete'
  | 'dag:failed'
  | 'dag:cancelled'
  | 'dag:paused'
  | 'dag:resumed'
  | 'task:ready'
  | 'task:start'
  | 'task:complete'
  | 'task:failed'
  | 'task:retry'
  | 'task:cancelled'
  | 'task:skipped'
  | 'progress:update';

/**
 * DAG 事件
 */
export interface DAGEvent {
  type: DAGEventType;
  dagId: string;
  taskId?: string;
  timestamp: number;
  data?: unknown;
}

// ============================================================================
// Builder Types (Fluent API)
// ============================================================================

/**
 * 任务构建器输入
 */
export interface TaskBuilderInput {
  id: string;
  name?: string;
  description?: string;
  priority?: TaskPriority;
  timeout?: number;
  allowFailure?: boolean;
}

/**
 * Agent 任务构建器输入
 */
export interface AgentTaskBuilderInput extends TaskBuilderInput {
  role: string;
  prompt: string;
  systemPrompt?: string;
  tools?: string[];
  maxIterations?: number;
  maxBudget?: number;
}

/**
 * Shell 任务构建器输入
 */
export interface ShellTaskBuilderInput extends TaskBuilderInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 创建默认任务元数据
 */
export function createDefaultMetadata(): TaskMetadata {
  return {
    createdAt: Date.now(),
    retryCount: 0,
    maxRetries: 0,
  };
}

/**
 * 创建空的任务输出
 */
export function createEmptyOutput(): TaskOutput {
  return {
    text: '',
    toolsUsed: [],
  };
}

/**
 * 检查任务是否为终态
 */
export function isTaskTerminal(status: TaskStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'skipped'].includes(status);
}

/**
 * 检查任务是否可执行
 */
export function isTaskExecutable(status: TaskStatus): boolean {
  return status === 'ready';
}

/**
 * 计算任务的下一个状态
 */
export function getNextTaskStatus(
  currentStatus: TaskStatus,
  event: 'dependencies_met' | 'start' | 'success' | 'failure' | 'cancel' | 'skip' | 'retry'
): TaskStatus {
  switch (event) {
    case 'dependencies_met':
      return currentStatus === 'pending' ? 'ready' : currentStatus;
    case 'start':
      return currentStatus === 'ready' ? 'running' : currentStatus;
    case 'success':
      return currentStatus === 'running' ? 'completed' : currentStatus;
    case 'failure':
      return currentStatus === 'running' ? 'failed' : currentStatus;
    case 'cancel':
      return ['pending', 'ready', 'running'].includes(currentStatus) ? 'cancelled' : currentStatus;
    case 'skip':
      return currentStatus === 'pending' ? 'skipped' : currentStatus;
    case 'retry':
      return currentStatus === 'failed' ? 'ready' : currentStatus;
    default:
      return currentStatus;
  }
}

/**
 * 计算优先级数值（用于排序）
 */
export function getPriorityValue(priority: TaskPriority): number {
  const values: Record<TaskPriority, number> = {
    low: 0,
    normal: 1,
    high: 2,
    critical: 3,
  };
  return values[priority];
}
