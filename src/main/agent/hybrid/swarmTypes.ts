// ============================================================================
// Agent Swarm - 类型定义
// ============================================================================

import type { DynamicAgentConfig } from './dynamicFactory';
import type { SwarmConfig } from './taskRouter';
import type { SwarmVerificationResult } from '../../../shared/types/swarm';

// Import and re-export AgentStatus from shared types
import type { AgentStatus } from '../../../shared/types/swarm';
export type { AgentStatus };

/**
 * 汇报类型
 */
export type ReportType =
  | 'started'      // 开始执行
  | 'progress'     // 进度更新（仅 full 模式）
  | 'completed'    // 完成
  | 'failed'       // 失败
  | 'conflict'     // 检测到冲突
  | 'resource';    // 需要资源

/**
 * Agent 汇报
 */
export interface AgentReport {
  agentId: string;
  agentName: string;
  type: ReportType;
  timestamp: number;
  data: {
    status?: AgentStatus;
    output?: string;
    error?: string;
    progress?: number;
    resourceNeeded?: string;
    conflictWith?: string;
  };
}

/**
 * Agent 运行时状态
 */
export interface AgentRuntime {
  agent: DynamicAgentConfig;
  status: AgentStatus;
  startTime?: number;
  endTime?: number;
  output?: string;
  error?: string;
  iterations: number;
  reports: AgentReport[];
}

/**
 * Swarm 执行结果
 */
export interface SwarmResult {
  success: boolean;
  agents: AgentRuntime[];
  aggregatedOutput: string;
  totalTime: number;
  statistics: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    parallelPeak: number;
    totalIterations: number;
  };
  /** Verification result (if verifier is available) */
  verification?: SwarmVerificationResult;
}

/**
 * Agent 执行器接口
 */
export interface AgentExecutor {
  execute(
    agent: DynamicAgentConfig,
    onReport: (report: AgentReport) => void
  ): Promise<{ success: boolean; output: string; error?: string }>;
}

/**
 * 扩展 Swarm 配置：进程隔离选项
 */
export interface ExtendedSwarmConfig extends SwarmConfig {
  /** 是否启用进程隔离（默认 true） */
  processIsolation?: boolean;
  /** 最大 worker 进程数（默认 4） */
  maxWorkers?: number;
  /** 单个 worker 超时（ms，默认 300000） */
  workerTimeout?: number;
}
