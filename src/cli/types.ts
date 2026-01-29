// ============================================================================
// CLI Types
// ============================================================================

import type { AgentEvent, ModelConfig, Generation } from '../shared/types';

/**
 * CLI 全局选项
 */
export interface CLIGlobalOptions {
  project: string;
  json: boolean;
  gen: string;
  model?: string;
  provider?: string;
  debug: boolean;
}

/**
 * CLI 运行时配置
 */
export interface CLIConfig {
  workingDirectory: string;
  generationId: string;
  modelConfig: ModelConfig;
  outputFormat: 'text' | 'json';
  debug: boolean;
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
