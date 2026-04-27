// ============================================================================
// Session Types
// ============================================================================

import type { ModelConfig } from './model';
import type { SessionWorkbenchProvenance, SessionWorkbenchSnapshot } from './sessionWorkspace';

/**
 * 会话运行状态
 */
export type SessionStatus =
  | 'idle'
  | 'running'
  | 'queued'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'error'
  | 'interrupted'
  | 'orphaned'
  | 'archived';

/**
 * Token 使用统计
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: number;
}

export interface StreamRecoverySnapshot {
  sessionId: string;
  turnId: string;
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  estimatedTokens: number;
  timestamp: number;
  isFinal: boolean;
  streamStatus: 'incomplete' | 'complete';
  stableForExecution: boolean;
  incompleteToolCallIds: string[];
}

/**
 * GitHub PR 关联信息
 */
export interface PRLink {
  /** 仓库所有者 */
  owner: string;
  /** 仓库名称 */
  repo: string;
  /** PR 编号 */
  number: number;
  /** PR 标题 */
  title?: string;
  /** PR 分支 */
  branch?: string;
  /** 关联时间 */
  linkedAt: number;
}

export interface Session {
  id: string;
  title: string;
  modelConfig: ModelConfig;
  workingDirectory?: string;
  createdAt: number;
  updatedAt: number;
  turnCount?: number;             // 轮次数（user turns）
  // Wave 3 新增字段
  workspace?: string;              // 工作空间标识
  status?: SessionStatus;          // 会话状态
  lastTokenUsage?: TokenUsage;     // 最近一次 Token 使用统计
  workbenchSnapshot?: SessionWorkbenchSnapshot; // 最小 workbench 解释快照
  workbenchProvenance?: SessionWorkbenchProvenance; // 本地持久化的最后一次明确 workbench 上下文
  streamSnapshot?: StreamRecoverySnapshot; // 上次中断的流式输出恢复快照
  // 归档状态
  isArchived?: boolean;            // 是否已归档
  archivedAt?: number;             // 归档时间
  // PR 关联
  prLink?: PRLink;                 // GitHub PR 关联信息
  // Git 分支
  gitBranch?: string;              // 创建会话时的 git 分支
}
