// ============================================================================
// Cloud Task Types - 云端任务执行系统类型定义
// ============================================================================

/**
 * 任务执行位置
 */
export type TaskExecutionLocation = 'local' | 'cloud' | 'hybrid';

/**
 * 任务状态
 */
export type CloudTaskStatus =
  | 'pending' // 等待执行
  | 'queued' // 已入队
  | 'running' // 执行中
  | 'paused' // 已暂停
  | 'completed' // 已完成
  | 'failed' // 失败
  | 'cancelled'; // 已取消

/**
 * 任务优先级
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * 云端 Agent 类型
 */
export type CloudAgentType =
  | 'researcher' // 研究员 - 搜索和分析信息
  | 'analyzer' // 分析师 - 代码/数据分析
  | 'writer' // 写作者 - 生成文档/报告
  | 'reviewer' // 审查员 - 代码审查
  | 'planner'; // 规划师 - 任务分解和规划

/**
 * 加密数据包装器
 */
export interface EncryptedPayload {
  iv: string; // 初始化向量 (base64)
  data: string; // 加密后的数据 (base64)
  tag: string; // 认证标签 (base64)
  algorithm: 'aes-256-gcm';
}

/**
 * 云端任务定义
 */
export interface CloudTask {
  id: string;
  userId: string;
  sessionId?: string;
  projectId?: string;

  // 任务内容
  type: CloudAgentType;
  title: string;
  description: string;
  prompt: string; // 可能加密

  // 执行配置
  priority: TaskPriority;
  location: TaskExecutionLocation;
  maxIterations?: number;
  timeout?: number; // 毫秒

  // 状态
  status: CloudTaskStatus;
  progress: number; // 0-100
  currentStep?: string;

  // 结果
  result?: string; // 可能加密
  error?: string;

  // 时间戳
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;

  // 元数据
  metadata?: Record<string, unknown>;
}

/**
 * 加密的云端任务（存储在数据库中）
 */
export interface EncryptedCloudTask extends Omit<CloudTask, 'prompt' | 'result'> {
  encryptedPrompt?: EncryptedPayload;
  encryptedResult?: EncryptedPayload;
  encryptionKeyId?: string; // 用于标识使用哪个密钥
}

/**
 * 任务创建请求
 */
export interface CreateCloudTaskRequest {
  type: CloudAgentType;
  title: string;
  description: string;
  prompt: string;
  priority?: TaskPriority;
  location?: TaskExecutionLocation;
  projectId?: string;
  sessionId?: string;
  maxIterations?: number;
  timeout?: number;
  metadata?: Record<string, unknown>;
}

/**
 * 任务更新请求
 */
export interface UpdateCloudTaskRequest {
  status?: CloudTaskStatus;
  progress?: number;
  currentStep?: string;
  result?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 任务查询过滤器
 */
export interface CloudTaskFilter {
  status?: CloudTaskStatus | CloudTaskStatus[];
  type?: CloudAgentType | CloudAgentType[];
  location?: TaskExecutionLocation;
  priority?: TaskPriority;
  projectId?: string;
  sessionId?: string;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
}

/**
 * 任务执行结果
 */
export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  output?: string;
  error?: string;
  duration: number; // 毫秒
  iterations: number;
  toolsUsed: string[];
}

/**
 * 任务进度事件
 */
export interface TaskProgressEvent {
  taskId: string;
  status: CloudTaskStatus;
  progress: number;
  currentStep?: string;
  message?: string;
  timestamp: string;
}

/**
 * 混合任务协调配置
 */
export interface HybridTaskConfig {
  // 本地优先的任务类型
  localPreferred: CloudAgentType[];
  // 云端优先的任务类型
  cloudPreferred: CloudAgentType[];
  // 自动回退到本地的条件
  fallbackToLocal: {
    onCloudTimeout: boolean;
    onCloudError: boolean;
    maxRetries: number;
  };
  // 并行执行配置
  parallel: {
    enabled: boolean;
    maxConcurrent: number;
  };
}

/**
 * 任务路由决策
 */
export interface TaskRoutingDecision {
  taskId: string;
  recommendedLocation: TaskExecutionLocation;
  reason: string;
  confidence: number; // 0-1
  alternatives: Array<{
    location: TaskExecutionLocation;
    reason: string;
  }>;
}

/**
 * 云端 Agent 配置
 */
export interface CloudAgentConfig {
  type: CloudAgentType;
  name: string;
  description: string;
  systemPrompt: string;
  availableTools: string[];
  maxIterations: number;
  timeout: number;
}

/**
 * 任务同步状态
 */
export interface TaskSyncState {
  lastSyncAt: string;
  pendingUploads: number;
  pendingDownloads: number;
  syncErrors: Array<{
    taskId: string;
    error: string;
    timestamp: string;
  }>;
}

/**
 * 云端执行统计
 */
export interface CloudExecutionStats {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  averageDuration: number;
  byType: Record<CloudAgentType, {
    total: number;
    completed: number;
    failed: number;
    avgDuration: number;
  }>;
  byLocation: Record<TaskExecutionLocation, {
    total: number;
    completed: number;
    failed: number;
  }>;
}

// ============================================================================
// IPC 通道定义
// ============================================================================

export const CloudTaskChannels = {
  // 任务管理
  CREATE_TASK: 'cloud:task:create',
  UPDATE_TASK: 'cloud:task:update',
  CANCEL_TASK: 'cloud:task:cancel',
  GET_TASK: 'cloud:task:get',
  LIST_TASKS: 'cloud:task:list',
  DELETE_TASK: 'cloud:task:delete',

  // 执行控制
  START_TASK: 'cloud:task:start',
  PAUSE_TASK: 'cloud:task:pause',
  RESUME_TASK: 'cloud:task:resume',
  RETRY_TASK: 'cloud:task:retry',

  // 同步
  SYNC_TASKS: 'cloud:task:sync',
  GET_SYNC_STATE: 'cloud:task:syncState',

  // 事件
  TASK_PROGRESS: 'cloud:task:progress',
  TASK_COMPLETED: 'cloud:task:completed',
  TASK_FAILED: 'cloud:task:failed',

  // 统计
  GET_STATS: 'cloud:task:stats',
} as const;

export type CloudTaskChannel = typeof CloudTaskChannels[keyof typeof CloudTaskChannels];
