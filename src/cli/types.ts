// ============================================================================
// CLI Types
// ============================================================================

import type { AgentEvent, ModelConfig } from '../shared/contract';

/**
 * CLI 全局选项
 */
export interface CLIGlobalOptions {
  project: string;
  json: boolean;
  gen: string;
  model?: string;
  provider?: string;
  plan?: boolean;
  debug: boolean;
  outputFormat?: 'text' | 'json' | 'stream-json';
  systemPrompt?: string;
  /** Comma-separated tool names to preload (bypass tool_search) */
  preloadTools?: string;
  /** Path to write session metrics JSON (enables MetricsCollector), mapped from --metrics */
  metrics?: string;
}

/**
 * CLI 运行时配置
 */
export interface CLIConfig {
  workingDirectory: string;
  modelConfig: ModelConfig;
  outputFormat: 'text' | 'json' | 'stream-json';
  enablePlanning: boolean;
  debug: boolean;
  /** 自动批准 plan mode 计划（用于 CLI/测试场景） */
  autoApprovePlan?: boolean;
  /** Custom system prompt to inject */
  systemPrompt?: string;
  /** Path to write session metrics JSON (enables MetricsCollector) */
  metricsPath?: string;
}

/**
 * CLI 输出事件
 */
export interface CLIOutputEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'complete';
  timestamp: number;
  data: unknown;
}

/**
 * CLI Agent 事件处理器
 */
export type CLIEventHandler = (event: AgentEvent) => void;

/**
 * CLI 运行结果
 */
export interface CLIRunResult {
  success: boolean;
  output?: string;
  error?: string;
  toolsUsed?: string[];
  duration?: number;
  /** Path to the metrics JSON file (if --metrics was used) */
  metricsPath?: string;
}

/**
 * HTTP API 请求体
 */
export interface APIRunRequest {
  prompt: string;
  project?: string;
  generation?: string;
  model?: string;
  provider?: string;
}

/**
 * HTTP API 状态响应
 */
export interface APIStatusResponse {
  running: boolean;
  taskId?: string;
  task?: string;
  startTime?: number;
  duration?: number;
}

/**
 * SSE 事件类型
 */
export interface SSEEvent {
  event: string;
  data: string;
}
