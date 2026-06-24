// ============================================================================
// Session Types
// ============================================================================

import type { ModelConfig } from './model';
import type { AgentEngineSessionMetadata } from './agentEngine';
import type { SessionWorkbenchProvenance, SessionWorkbenchSnapshot } from './sessionWorkspace';

/**
 * 会话运行状态
 */
export type SessionStatus = 'idle' | 'running' | 'queued' | 'paused' | 'cancelling' | 'completed' | 'error' | 'interrupted' | 'orphaned' | 'archived';

/**
 * 会话代表的工作单元类型。
 *
 * chat 是用户主动对话；schedule / heartbeat / subagent 是由系统或子运行生成的
 * 可回看工作单元。background / review 仍然是状态或分析队列，不进这里。
 */
export type SessionType = 'chat' | 'schedule' | 'heartbeat' | 'subagent';

export type SessionMemoryMode = 'auto' | 'off';

export type SessionOriginKind =
  | 'manual'
  | 'cron'
  | 'heartbeat'
  | 'subagent'
  | 'channel'
  | 'import'
  | 'retry'
  | 'agent_session_manager';

export interface SessionOrigin {
  kind: SessionOriginKind;
  id?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

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
  userId?: string | null; // Auth user owner for admin-scoped diagnostics
  title: string;
  modelConfig: ModelConfig;
  workingDirectory?: string;
  type?: SessionType; // 工作单元类型，旧数据默认 chat
  origin?: SessionOrigin; // 触发来源，如 cron job / heartbeat task / parent agent
  metadata?: Record<string, unknown>; // 会话级产品/评测元数据，不承载消息内容
  parentSessionId?: string; // 子 session 或派生 session 的父级
  sourceRunId?: string; // 外部执行记录 ID，如 CronJobExecution.id
  engine?: AgentEngineSessionMetadata; // Agent Engine metadata; old sessions default to native
  memoryMode?: SessionMemoryMode; // 会话级记忆注入策略
  suppressedMemoryEntryIds?: string[]; // 本会话不再注入的记忆条目
  readOnly?: boolean; // 生成型 session 默认只读，由 UI 决定是否允许继续输入
  retryOfSessionId?: string; // 重试链路
  createdAt: number;
  updatedAt: number;
  turnCount?: number; // 轮次数（user turns）
  // Wave 3 新增字段
  workspace?: string; // 工作空间标识
  status?: SessionStatus; // 会话状态
  lastTokenUsage?: TokenUsage; // 最近一次 Token 使用统计
  workbenchSnapshot?: SessionWorkbenchSnapshot; // 最小 workbench 解释快照
  workbenchProvenance?: SessionWorkbenchProvenance; // 本地持久化的最后一次明确 workbench 上下文
  streamSnapshot?: StreamRecoverySnapshot; // 上次中断的流式输出恢复快照
  // 归档状态
  isArchived?: boolean; // 是否已归档
  archivedAt?: number; // 归档时间
  // PR 关联
  prLink?: PRLink; // GitHub PR 关联信息
  // Git 分支
  gitBranch?: string; // 创建会话时的 git 分支
  // 项目空间（P0-2）：归属的 project；存量由 backfillSessions 回填，新建时按 workspace 隐式归桶
  projectId?: string;
}
