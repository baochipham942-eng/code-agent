// ============================================================================
// Multi-Agent Types - 多 Agent 调度系统类型定义
// ============================================================================

/**
 * Agent 角色类型
 */
export type AgentRole =
  | 'planner' // 规划师 - 任务分解和规划
  | 'researcher' // 研究员 - 搜索和分析信息
  | 'coder' // 编码员 - 代码编写和修改
  | 'reviewer' // 审查员 - 代码审查
  | 'writer' // 写作者 - 文档和内容生成
  | 'tester' // 测试员 - 测试执行
  | 'coordinator'; // 协调员 - 多 Agent 协调

/**
 * Agent 能力
 */
export type AgentCapability =
  | 'file_read' // 读取文件
  | 'file_write' // 写入文件
  | 'shell_execute' // 执行 shell 命令
  | 'web_search' // 网络搜索
  | 'web_scrape' // 网页抓取
  | 'api_call' // API 调用
  | 'memory_access' // 访问记忆系统
  | 'code_analysis' // 代码分析
  | 'test_execution' // 测试执行
  | 'task_delegation'; // 任务委派

/**
 * Agent 状态
 */
export type AgentStatus = 'idle' | 'busy' | 'waiting' | 'error' | 'offline';

/**
 * Agent 定义
 */
export interface AgentDefinition {
  id: string;
  role: AgentRole;
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: AgentCapability[];
  availableTools: string[];

  // 执行配置
  maxIterations: number;
  timeout: number;
  temperature?: number;

  // 运行环境
  preferredLocation: 'local' | 'cloud' | 'any';

  // 协作配置
  canDelegate: boolean;
  canReceiveDelegation: boolean;
  delegationTargets?: AgentRole[];
}

/**
 * Agent 实例状态
 */
export interface AgentInstance {
  id: string;
  definitionId: string;
  role: AgentRole;
  status: AgentStatus;
  currentTaskId?: string;
  createdAt: number;
  lastActiveAt: number;
  stats: AgentStats;
}

/**
 * Agent 统计
 */
export interface AgentStats {
  tasksCompleted: number;
  tasksFailed: number;
  totalIterations: number;
  totalDuration: number;
  averageIterations: number;
  averageDuration: number;
}

/**
 * Agent 任务
 */
export interface AgentTask {
  id: string;
  agentId: string;
  parentTaskId?: string;
  prompt: string;
  context?: TaskContext;
  priority: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: AgentTaskResult;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

/**
 * 任务上下文
 */
export interface TaskContext {
  projectPath?: string;
  files?: string[];
  codeSnippets?: Array<{
    file: string;
    content: string;
    language?: string;
  }>;
  previousResults?: AgentTaskResult[];
  metadata?: Record<string, unknown>;
}

/**
 * Agent 任务结果
 */
export interface AgentTaskResult {
  taskId: string;
  agentId: string;
  success: boolean;
  output?: string;
  error?: string;
  artifacts?: TaskArtifact[];
  iterations: number;
  duration: number;
  toolsUsed: string[];
  delegatedTasks?: AgentTaskResult[];
}

/**
 * 任务产物
 */
export interface TaskArtifact {
  type: 'file' | 'code' | 'report' | 'plan' | 'review';
  name: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Agent 间消息
 */
export interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  type: 'request' | 'response' | 'notification' | 'delegation';
  content: string;
  payload?: unknown;
  timestamp: number;
  correlationId?: string;
}

/**
 * 委派请求
 */
export interface DelegationRequest {
  id: string;
  fromAgentId: string;
  targetRole: AgentRole;
  task: Omit<AgentTask, 'id' | 'agentId' | 'createdAt'>;
  priority: number;
  timeout?: number;
  context?: TaskContext;
}

/**
 * 委派响应
 */
export interface DelegationResponse {
  requestId: string;
  accepted: boolean;
  assignedAgentId?: string;
  reason?: string;
  estimatedDuration?: number;
}

/**
 * 调度策略
 */
export type SchedulingStrategy =
  | 'round_robin' // 轮询
  | 'least_busy' // 最空闲
  | 'skill_match' // 技能匹配
  | 'priority_first'; // 优先级优先

/**
 * 调度配置
 */
export interface SchedulerConfig {
  strategy: SchedulingStrategy;
  maxConcurrentAgents: number;
  taskQueueSize: number;
  delegationTimeout: number;
  retryOnFailure: boolean;
  maxRetries: number;
}

/**
 * 工作流步骤
 */
export interface WorkflowStep {
  id: string;
  agentRole: AgentRole;
  task: string;
  dependsOn?: string[];
  optional?: boolean;
  timeout?: number;
  retries?: number;
}

/**
 * 工作流定义
 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  errorHandling: 'stop' | 'skip' | 'retry';
  parallelExecution: boolean;
}

/**
 * 工作流执行状态
 */
export interface WorkflowExecution {
  id: string;
  definitionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentStepId?: string;
  completedSteps: string[];
  failedSteps: string[];
  stepResults: Map<string, AgentTaskResult>;
  startedAt: number;
  completedAt?: number;
}
