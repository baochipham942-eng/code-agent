// ============================================================================
// Evaluation Internal Types - 评测模块内部类型
// ============================================================================

// Re-export TranscriptMetrics from shared (canonical source) for backward compatibility
export type { TranscriptMetrics } from '../../shared/contract/evaluation';

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
  actualArgs?: Record<string, unknown>;
  argsSource?: 'telemetry_sanitized' | 'telemetry_actual' | 'transcript';
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

// TranscriptMetrics moved to shared/contract/evaluation.ts (canonical source)
// Re-exported above for backward compatibility

// ADR-036 F4a：DimensionEvaluator 空接口（零 implements）已删除——单实现都没有的
// 抽象是负债。未来真要维度评估器时，从需求反推接口，别留悬空定义。
