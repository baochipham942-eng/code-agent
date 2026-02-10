// ============================================================================
// Evaluation Internal Types - 评测模块内部类型
// ============================================================================

import type { EvaluationMetric, EvaluationDimension } from '../../shared/types/evaluation';

/**
 * 对话类型分类
 */
export type ConversationType = 'qa' | 'coding' | 'research' | 'creation';

/**
 * Turn 级快照（结构化遥测数据）
 */
export interface TurnSnapshot {
  turnNumber: number;
  userPrompt: string;
  assistantResponse: string;
  toolCalls: ToolCallRecord[];
  intentPrimary: string;
  outcomeStatus: string;
  thinkingContent?: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * 运行时质量信号
 */
export interface QualitySignals {
  totalRetries: number;
  errorRecoveries: number;
  compactionCount: number;
  circuitBreakerTrips: number;
  selfRepairAttempts: number;
  selfRepairSuccesses: number;
  verificationActions: number;
}

/**
 * 会话快照（用于评测分析）
 */
export interface SessionSnapshot {
  sessionId: string;
  messages: SessionMessage[];
  toolCalls: ToolCallRecord[];
  turns: TurnSnapshot[];
  startTime: number;
  endTime: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  qualitySignals: QualitySignals;
}

/**
 * 会话消息
 */
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * 工具调用记录
 */
export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  success: boolean;
  duration: number;
  timestamp: number;
  turnId?: string;
  index?: number;
  parallel?: boolean;
}

/**
 * 工具调用统计
 */
export interface ToolCallStats {
  total: number;
  successful: number;
  failed: number;
  byTool: Record<string, { count: number; successCount: number }>;
  redundantCalls: number;
}

/**
 * Transcript 分析结果（代码 Grader）
 */
export interface TranscriptMetrics {
  selfRepair: {
    attempts: number;
    successes: number;
    rate: number;
    chains: Array<{ toolName: string; failIndex: number; retryIndex: number; succeeded: boolean }>;
  };
  verificationQuality: {
    editCount: number;
    verifiedCount: number;
    rate: number;
  };
  forbiddenPatterns: {
    detected: string[];
    count: number;
  };
  errorTaxonomy: Record<string, number>;
}

/**
 * 维度评估器接口
 */
export interface DimensionEvaluator {
  dimension: EvaluationDimension;
  evaluate(snapshot: SessionSnapshot): Promise<EvaluationMetric>;
}
