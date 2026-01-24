// ============================================================================
// Session State Types - 会话运行时状态类型定义
// ============================================================================

import type { Message } from '../types';
import type { ContextHealthState } from './contextHealth';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 会话运行状态
 */
export type SessionStatus = 'idle' | 'running' | 'paused' | 'stopping';

/**
 * 子代理状态
 */
export interface SubagentState {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: {
    current: number;
    total: number;
  };
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

/**
 * 会话运行时状态摘要（用于前端显示）
 */
export interface SessionRuntimeSummary {
  /** 会话 ID */
  sessionId: string;
  /** 运行状态 */
  status: SessionStatus;
  /** 活跃代理数量 */
  activeAgentCount: number;
  /** 上下文健康状态 */
  contextHealth: ContextHealthState | null;
  /** 最后活动时间 */
  lastActivityAt: number;
}

/**
 * 会话状态更新事件
 */
export interface SessionStatusUpdateEvent {
  sessionId: string;
  status: SessionStatus;
  activeAgentCount: number;
  contextHealth: ContextHealthState | null;
}

// ----------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------

/**
 * 创建空的会话运行时摘要
 */
export function createEmptyRuntimeSummary(sessionId: string): SessionRuntimeSummary {
  return {
    sessionId,
    status: 'idle',
    activeAgentCount: 0,
    contextHealth: null,
    lastActivityAt: Date.now(),
  };
}
