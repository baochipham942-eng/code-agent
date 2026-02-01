// ============================================================================
// Evaluation Internal Types - 评测模块内部类型
// ============================================================================

import type { EvaluationMetric, EvaluationDimension } from '../../shared/types/evaluation';

/**
 * 会话快照（用于评测分析）
 */
export interface SessionSnapshot {
  sessionId: string;
  messages: SessionMessage[];
  toolCalls: ToolCallRecord[];
  startTime: number;
  endTime: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
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
 * 维度评估器接口
 */
export interface DimensionEvaluator {
  dimension: EvaluationDimension;
  evaluate(snapshot: SessionSnapshot): Promise<EvaluationMetric>;
}
