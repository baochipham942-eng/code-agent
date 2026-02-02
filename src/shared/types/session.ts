// ============================================================================
// Session Types
// ============================================================================

import type { GenerationId } from './generation';
import type { ModelConfig } from './model';

/**
 * 会话运行状态
 */
export type SessionStatus = 'idle' | 'running' | 'completed' | 'error';

/**
 * Token 使用统计
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: number;
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
  generationId: GenerationId;
  modelConfig: ModelConfig;
  workingDirectory?: string;
  createdAt: number;
  updatedAt: number;
  // Wave 3 新增字段
  workspace?: string;              // 工作空间标识
  status?: SessionStatus;          // 会话状态
  lastTokenUsage?: TokenUsage;     // 最近一次 Token 使用统计
  // 归档状态
  isArchived?: boolean;            // 是否已归档
  archivedAt?: number;             // 归档时间
  // PR 关联
  prLink?: PRLink;                 // GitHub PR 关联信息
}
