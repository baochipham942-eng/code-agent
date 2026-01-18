// ============================================================================
// Unified Orchestrator Types - 统一指挥家类型定义
// ============================================================================

import type { ModelConfig, Message, ToolCall, ToolResult } from '../../shared/types';
import type { CloudTask, TaskExecutionLocation, CloudAgentType, TaskPriority } from '../../shared/types/cloud';

// ============================================================================
// 任务分析相关类型
// ============================================================================

/**
 * 任务类型
 */
export type TaskType = 'research' | 'coding' | 'automation' | 'data' | 'general';

/**
 * 所需能力
 */
export type RequiredCapability =
  | 'file_access'   // 文件读写
  | 'shell'         // Shell 命令执行
  | 'network'       // 网络请求
  | 'browser'       // 浏览器自动化
  | 'memory'        // 记忆存储/检索
  | 'code_analysis' // 代码分析
  | 'planning';     // 任务规划

/**
 * 敏感度等级
 */
export type SensitivityLevel = 'public' | 'internal' | 'sensitive';

/**
 * 复杂度等级
 */
export type ComplexityLevel = 'simple' | 'moderate' | 'complex';

/**
 * 实时性要求
 */
export type RealtimeRequirement = 'realtime' | 'async' | 'batch';

/**
 * 任务分析结果
 */
export interface TaskAnalysis {
  /** 任务类型 */
  taskType: TaskType;
  /** 所需能力列表 */
  requiredCapabilities: RequiredCapability[];
  /** 敏感度等级 */
  sensitivityLevel: SensitivityLevel;
  /** 复杂度等级 */
  complexity: ComplexityLevel;
  /** 实时性要求 */
  realtimeRequirement: RealtimeRequirement;
  /** 预估执行时间（毫秒） */
  estimatedDuration: number;
  /** 分析置信度 (0-1) */
  confidence: number;
  /** 检测到的关键词 */
  detectedKeywords: string[];
  /** 分析说明 */
  reasoning: string;
}

// ============================================================================
// 路由决策相关类型
// ============================================================================

/**
 * 路由决策优先级
 */
export type RoutingPriority = 'P1_SECURITY' | 'P2_CAPABILITY' | 'P3_EFFICIENCY' | 'P4_PREFERENCE';

/**
 * 路由决策结果
 */
export interface RoutingDecision {
  /** 决策 ID */
  decisionId: string;
  /** 推荐执行位置 */
  recommendedLocation: TaskExecutionLocation;
  /** 决策原因 */
  reason: string;
  /** 决策优先级 */
  priority: RoutingPriority;
  /** 置信度 (0-1) */
  confidence: number;
  /** 备选方案 */
  alternatives: Array<{
    location: TaskExecutionLocation;
    reason: string;
    confidence: number;
  }>;
  /** 决策依据的任务分析 */
  analysis: TaskAnalysis;
}

/**
 * 用户路由偏好
 */
export interface UserRoutingPreferences {
  /** 离线模式（强制本地） */
  offlineMode: boolean;
  /** 省电模式（优先云端） */
  powerSaveMode: boolean;
  /** 默认执行位置 */
  defaultLocation?: TaskExecutionLocation;
  /** 敏感数据必须本地 */
  sensitiveDataLocal: boolean;
  /** 允许的云端任务类型 */
  allowedCloudTaskTypes: TaskType[];
}

// ============================================================================
// 执行器相关类型
// ============================================================================

/**
 * 执行请求
 */
export interface ExecutorRequest {
  /** 请求 ID */
  requestId: string;
  /** 用户提示 */
  prompt: string;
  /** 任务类型 */
  taskType?: CloudAgentType;
  /** 执行位置 */
  location?: TaskExecutionLocation;
  /** 优先级 */
  priority?: TaskPriority;
  /** 最大迭代次数 */
  maxIterations?: number;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 上下文信息 */
  context?: ExecutionContext;
  /** 模型配置 */
  modelConfig?: ModelConfig;
}

/**
 * 执行上下文
 */
export interface ExecutionContext {
  /** 会话 ID */
  sessionId?: string;
  /** 项目 ID */
  projectId?: string;
  /** 项目路径 */
  projectPath?: string;
  /** 当前文件 */
  currentFile?: string;
  /** 历史消息 */
  messageHistory?: Message[];
  /** 项目概要 */
  projectSummary?: string;
  /** 文件树 */
  fileTree?: string[];
}

/**
 * 执行结果
 */
export interface ExecutorResult {
  /** 请求 ID */
  requestId: string;
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output?: string;
  /** 错误信息 */
  error?: string;
  /** 执行位置 */
  location: TaskExecutionLocation;
  /** 执行时长（毫秒） */
  duration: number;
  /** 迭代次数 */
  iterations: number;
  /** 使用的工具 */
  toolsUsed: string[];
  /** 工具调用记录 */
  toolCalls?: ToolCall[];
  /** 工具结果记录 */
  toolResults?: ToolResult[];
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 执行进度事件
 */
export interface ExecutionProgressEvent {
  /** 请求 ID */
  requestId: string;
  /** 进度百分比 (0-100) */
  progress: number;
  /** 当前步骤描述 */
  currentStep: string;
  /** 当前执行位置 */
  location: TaskExecutionLocation;
  /** 时间戳 */
  timestamp: number;
}

// ============================================================================
// Orchestrator 相关类型
// ============================================================================

/**
 * Orchestrator 请求
 */
export interface OrchestratorRequest {
  /** 用户提示 */
  prompt: string;
  /** 强制执行位置（可选） */
  forceLocation?: TaskExecutionLocation;
  /** 用户偏好 */
  preferences?: UserRoutingPreferences;
  /** 执行上下文 */
  context?: ExecutionContext;
  /** 模型配置 */
  modelConfig?: ModelConfig;
  /** 最大迭代次数 */
  maxIterations?: number;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 是否流式输出 */
  stream?: boolean;
}

/**
 * Orchestrator 结果
 */
export interface OrchestratorResult {
  /** 请求 ID */
  requestId: string;
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output?: string;
  /** 错误信息 */
  error?: string;
  /** 路由决策 */
  routingDecision: RoutingDecision;
  /** 执行结果 */
  executionResult: ExecutorResult;
  /** 总时长（毫秒） */
  totalDuration: number;
}

/**
 * Orchestrator 配置
 */
export interface OrchestratorConfig {
  /** 默认模型配置 */
  defaultModelConfig?: ModelConfig;
  /** 默认用户偏好 */
  defaultPreferences?: UserRoutingPreferences;
  /** 本地执行器配置 */
  localExecutor?: {
    maxConcurrent: number;
    defaultTimeout: number;
    maxIterations: number;
  };
  /** 云端执行器配置 */
  cloudExecutor?: {
    maxConcurrent: number;
    defaultTimeout: number;
    maxIterations: number;
    apiEndpoint?: string;
  };
  /** 混合协调器配置 */
  hybridCoordinator?: {
    autoSplitThreshold: number;
    preferLocalForSensitive: boolean;
  };
}

// ============================================================================
// 云端工具相关类型
// ============================================================================

/**
 * 云端工具定义
 */
export interface CloudTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

/**
 * 云端搜索结果
 */
export interface CloudSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedDate?: string;
}

/**
 * 云端抓取结果
 */
export interface CloudScrapeResult {
  url: string;
  title?: string;
  content: string;
  extractedData?: Record<string, unknown>;
  metadata?: {
    statusCode: number;
    contentType: string;
    responseTime: number;
  };
}

/**
 * 云端 API 调用结果
 */
export interface CloudApiResult {
  success: boolean;
  statusCode: number;
  data?: unknown;
  error?: string;
  headers?: Record<string, string>;
  responseTime: number;
}

/**
 * 云端记忆存储请求
 */
export interface CloudMemoryStoreRequest {
  key: string;
  content: string;
  metadata?: Record<string, unknown>;
  projectId?: string;
  namespace?: string;
}

/**
 * 云端记忆搜索请求
 */
export interface CloudMemorySearchRequest {
  query: string;
  limit?: number;
  threshold?: number;
  projectId?: string;
  namespace?: string;
  filters?: Record<string, unknown>;
}

/**
 * 云端记忆搜索结果
 */
export interface CloudMemorySearchResult {
  key: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ============================================================================
// 事件类型
// ============================================================================

export type OrchestratorEventType =
  | 'analysis:start'
  | 'analysis:complete'
  | 'routing:start'
  | 'routing:complete'
  | 'execution:start'
  | 'execution:progress'
  | 'execution:complete'
  | 'execution:error'
  | 'tool:call'
  | 'tool:result';

export interface OrchestratorEvent {
  type: OrchestratorEventType;
  requestId: string;
  timestamp: number;
  data: unknown;
}
