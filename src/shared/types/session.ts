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
}
