// ============================================================================
// Session Analytics Types - 会话分析数据类型
// ============================================================================
// 分离客观指标和主观评测，遵循行业最佳实践
// 参考: Anthropic, Braintrust, LangSmith, DeepEval
// ============================================================================

/**
 * 工具调用记录
 */
export interface ToolCallRecord {
  id: string;
  name: string;
  success: boolean;
  duration: number; // ms
  timestamp: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * 客观指标 - 直接从数据库计算，不需要 LLM
 */
export interface ObjectiveMetrics {
  // 基础统计
  sessionId: string;
  startTime: number;
  endTime: number;
  duration: number; // ms

  // 消息统计
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  avgUserMessageLength: number;
  avgAssistantMessageLength: number;

  // 工具调用统计
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  toolSuccessRate: number; // 0-100
  toolCallsByName: Record<string, number>;
  avgToolLatency: number; // ms

  // Token 统计
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCost: number; // USD

  // 代码统计
  codeBlocksGenerated: number;
  messagesWithCode: number;

  // 交互模式
  turnsCount: number;
  avgResponseTime: number;

  // v3 新增：遥测增强指标
  intentDistribution?: Record<string, number>;
  errorTaxonomy?: Record<string, number>;
  selfRepairRate?: number;
  tokenPerTurn?: number[];
}

/**
 * 主观评测维度 (v3)
 * @deprecated 未来将统一到 EvaluationDimension
 */
export enum SubjectiveDimension {
  // v3 计分维度
  OUTCOME_VERIFICATION = 'outcome_verification',
  CODE_QUALITY = 'code_quality',
  SECURITY = 'security',
  TOOL_EFFICIENCY = 'tool_efficiency',
  SELF_REPAIR = 'self_repair',
  VERIFICATION_QUALITY = 'verification_quality',
  FORBIDDEN_PATTERNS = 'forbidden_patterns',

  // v3 信息维度
  EFFICIENCY_METRICS = 'efficiency_metrics',
  ERROR_TAXONOMY = 'error_taxonomy',
  PLAN_QUALITY = 'plan_quality',

  // v2 兼容
  TASK_COMPLETION = 'task_completion',
  RESPONSE_QUALITY = 'response_quality',
  COMMUNICATION = 'communication',
  EFFICIENCY = 'efficiency',
  SAFETY = 'safety',
}

/**
 * 评审员评测结果
 */
export interface ReviewerAssessment {
  reviewerId: string;
  reviewerName: string;
  perspective: string;
  dimension: SubjectiveDimension;
  score: number; // 0-100
  reasoning: string;
  findings: string[];
  concerns: string[];
  passed: boolean;
}

/**
 * 主观评测结果
 */
export interface SubjectiveAssessment {
  // 评测元信息
  evaluatedAt: number;
  model: string;
  provider: string;

  // 各维度评分
  dimensions: {
    [key in SubjectiveDimension]?: {
      score: number;
      reasoning: string;
      reviewerAssessments: ReviewerAssessment[];
    };
  };

  // 综合结果
  overallScore: number;
  grade: string;
  summary: string;
  suggestions: string[];

  // 瑞士奶酪模型信息
  consensus: boolean;
  reviewerCount: number;
  passedReviewers: number;

  // v3 新增：Transcript 分析结果
  transcriptMetrics?: {
    selfRepair: { attempts: number; successes: number; rate: number };
    verificationQuality: { editCount: number; verifiedCount: number; rate: number };
    forbiddenPatterns: { detected: string[]; count: number };
    errorTaxonomy: Record<string, number>;
  };
}

/**
 * 维度名称映射
 */
export const DIMENSION_NAMES: Record<SubjectiveDimension, string> = {
  // v3 计分
  [SubjectiveDimension.OUTCOME_VERIFICATION]: '结果验证',
  [SubjectiveDimension.CODE_QUALITY]: '代码质量',
  [SubjectiveDimension.SECURITY]: '安全性',
  [SubjectiveDimension.TOOL_EFFICIENCY]: '工具效率',
  [SubjectiveDimension.SELF_REPAIR]: '自我修复',
  [SubjectiveDimension.VERIFICATION_QUALITY]: '验证行为',
  [SubjectiveDimension.FORBIDDEN_PATTERNS]: '禁止模式',
  // v3 信息
  [SubjectiveDimension.EFFICIENCY_METRICS]: '效率指标',
  [SubjectiveDimension.ERROR_TAXONOMY]: '错误分类',
  [SubjectiveDimension.PLAN_QUALITY]: '规划质量',
  // v2 兼容
  [SubjectiveDimension.TASK_COMPLETION]: '任务完成度',
  [SubjectiveDimension.RESPONSE_QUALITY]: '响应质量',
  [SubjectiveDimension.COMMUNICATION]: '沟通能力',
  [SubjectiveDimension.EFFICIENCY]: '执行效率',
  [SubjectiveDimension.SAFETY]: '安全性',
};

/**
 * 维度图标映射
 */
export const DIMENSION_ICONS: Record<SubjectiveDimension, string> = {
  [SubjectiveDimension.OUTCOME_VERIFICATION]: '🎯',
  [SubjectiveDimension.CODE_QUALITY]: '💻',
  [SubjectiveDimension.SECURITY]: '🔒',
  [SubjectiveDimension.TOOL_EFFICIENCY]: '🔧',
  [SubjectiveDimension.SELF_REPAIR]: '🔄',
  [SubjectiveDimension.VERIFICATION_QUALITY]: '✅',
  [SubjectiveDimension.FORBIDDEN_PATTERNS]: '🚫',
  [SubjectiveDimension.EFFICIENCY_METRICS]: '⚡',
  [SubjectiveDimension.ERROR_TAXONOMY]: '📋',
  [SubjectiveDimension.PLAN_QUALITY]: '📐',
  [SubjectiveDimension.TASK_COMPLETION]: '🎯',
  [SubjectiveDimension.RESPONSE_QUALITY]: '💬',
  [SubjectiveDimension.COMMUNICATION]: '🤝',
  [SubjectiveDimension.EFFICIENCY]: '⚡',
  [SubjectiveDimension.SAFETY]: '🔒',
};
