// ============================================================================
// taskManagerTypes - TaskManager 对外类型与默认配置（自 TaskManager.ts 拆出）
// ============================================================================

import type { AgentOrchestrator } from '../agent/agentOrchestrator';
import { TASK_QUEUE_TIMEOUTS } from '../../shared/constants';

/**
 * 会话运行状态
 */
export type SessionStatus = 'idle' | 'running' | 'paused' | 'queued' | 'cancelling' | 'error';

/**
 * 会话状态信息
 */
export interface SessionState {
  /** 当前状态 */
  status: SessionStatus;
  /** 在队列中的位置（仅 queued 状态有效）*/
  queuePosition?: number;
  /** 任务开始时间 */
  startTime?: number;
  /** 错误信息（仅 error 状态有效）*/
  error?: string;
}

/**
 * TaskManager 配置
 */
export interface TaskManagerConfig {
  /** 最大并发任务数，默认 3 */
  maxConcurrentTasks: number;
  /** 中断超时时间（毫秒），超时后降级为强制取消，默认 5000 */
  interruptTimeout: number;
  /** 排队超时时间（毫秒），超时后自动取消，默认 300000 (5分钟) */
  queueTimeout: number;
}

/**
 * TaskManager 事件类型
 */
export type TaskManagerEventType =
  | 'state_change'      // 会话状态变化
  | 'queue_update'      // 队列更新
  | 'task_started'      // 任务开始执行
  | 'task_completed'    // 任务完成
  | 'task_error'        // 任务出错
  | 'task_cancelled';   // 任务取消

export interface TaskManagerEvent {
  type: TaskManagerEventType;
  sessionId: string;
  data?: unknown;
}

/**
 * 内部 Orchestrator 包装
 */
export interface OrchestratorWrapper {
  orchestrator: AgentOrchestrator;
  sessionId: string;
  createdAt: number;
}

export type BackgroundTaskRunStatus = 'running' | 'cancelling';

export interface BackgroundTaskRun {
  taskId: string;
  sessionId: string;
  orchestrator: AgentOrchestrator;
  status: BackgroundTaskRunStatus;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_CONFIG: TaskManagerConfig = {
  maxConcurrentTasks: 3,
  interruptTimeout: 5000,
  queueTimeout: TASK_QUEUE_TIMEOUTS.QUEUE_TIMEOUT_MS,
};
