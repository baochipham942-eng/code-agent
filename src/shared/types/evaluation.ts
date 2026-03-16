// ============================================================================
// Evaluation Types - 会话评测类型定义
// ============================================================================

/**
 * 评测维度 (v3: 7 计分 + 3 信息)
 */
export enum EvaluationDimension {
  // 计分维度 (v3)
  OUTCOME_VERIFICATION = 'outcome_verification',
  CODE_QUALITY = 'code_quality',
  SECURITY = 'security',
  TOOL_EFFICIENCY = 'tool_efficiency',
  SELF_REPAIR = 'self_repair',
  VERIFICATION_QUALITY = 'verification_quality',
  FORBIDDEN_PATTERNS = 'forbidden_patterns',

  // QA 维度
  ANSWER_CORRECTNESS = 'answer_correctness',
  REASONING_QUALITY = 'reasoning_quality',
  COMMUNICATION_QUALITY = 'communication_quality',
  // Research 维度
  INFORMATION_QUALITY = 'information_quality',
  // Creation 维度
  OUTPUT_QUALITY = 'output_quality',
  REQUIREMENT_COMPLIANCE = 'requirement_compliance',

  // 信息维度 (不计分)
  EFFICIENCY_METRICS = 'efficiency_metrics',
  ERROR_TAXONOMY = 'error_taxonomy',
  PLAN_QUALITY = 'plan_quality',

  // v2 兼容 (旧数据)
  TASK_COMPLETION = 'task_completion',
  DIALOG_QUALITY = 'dialog_quality',
  PERFORMANCE = 'performance',
}

/**
 * v3 计分维度列表
 */
export const V3_SCORING_DIMENSIONS: EvaluationDimension[] = [
  EvaluationDimension.OUTCOME_VERIFICATION,
  EvaluationDimension.CODE_QUALITY,
  EvaluationDimension.SECURITY,
  EvaluationDimension.TOOL_EFFICIENCY,
  EvaluationDimension.SELF_REPAIR,
  EvaluationDimension.VERIFICATION_QUALITY,
  EvaluationDimension.FORBIDDEN_PATTERNS,
];

/**
 * v3 信息维度列表
 */
export const V3_INFO_DIMENSIONS: EvaluationDimension[] = [
  EvaluationDimension.EFFICIENCY_METRICS,
  EvaluationDimension.ERROR_TAXONOMY,
  EvaluationDimension.PLAN_QUALITY,
];

/**
 * 维度权重配置 (v3)
 */
export const DIMENSION_WEIGHTS: Partial<Record<EvaluationDimension, number>> = {
  [EvaluationDimension.OUTCOME_VERIFICATION]: 0.35,
  [EvaluationDimension.CODE_QUALITY]: 0.20,
  [EvaluationDimension.SECURITY]: 0.15,
  [EvaluationDimension.TOOL_EFFICIENCY]: 0.08,
  [EvaluationDimension.SELF_REPAIR]: 0.05,
  [EvaluationDimension.VERIFICATION_QUALITY]: 0.04,
  [EvaluationDimension.FORBIDDEN_PATTERNS]: 0.03,
  // QA 权重
  [EvaluationDimension.ANSWER_CORRECTNESS]: 0.60,
  [EvaluationDimension.REASONING_QUALITY]: 0.25,
  [EvaluationDimension.COMMUNICATION_QUALITY]: 0.15,
  // Research 权重
  [EvaluationDimension.INFORMATION_QUALITY]: 0.35,
  // Creation 权重
  [EvaluationDimension.OUTPUT_QUALITY]: 0.35,
  [EvaluationDimension.REQUIREMENT_COMPLIANCE]: 0.20,
  // v2 兼容权重
  [EvaluationDimension.TASK_COMPLETION]: 0.30,
  [EvaluationDimension.DIALOG_QUALITY]: 0.15,
  [EvaluationDimension.PERFORMANCE]: 0.10,
};

/**
 * 维度中文名称
 */
export const DIMENSION_NAMES: Record<EvaluationDimension, string> = {
  [EvaluationDimension.OUTCOME_VERIFICATION]: '结果验证',
  [EvaluationDimension.CODE_QUALITY]: '代码质量',
  [EvaluationDimension.SECURITY]: '安全性',
  [EvaluationDimension.TOOL_EFFICIENCY]: '工具效率',
  [EvaluationDimension.SELF_REPAIR]: '自我修复',
  [EvaluationDimension.VERIFICATION_QUALITY]: '验证行为',
  [EvaluationDimension.FORBIDDEN_PATTERNS]: '禁止模式',
  [EvaluationDimension.ANSWER_CORRECTNESS]: '回答正确性',
  [EvaluationDimension.REASONING_QUALITY]: '推理质量',
  [EvaluationDimension.COMMUNICATION_QUALITY]: '表达质量',
  [EvaluationDimension.INFORMATION_QUALITY]: '信息质量',
  [EvaluationDimension.OUTPUT_QUALITY]: '产出质量',
  [EvaluationDimension.REQUIREMENT_COMPLIANCE]: '需求符合度',
  [EvaluationDimension.EFFICIENCY_METRICS]: '效率指标',
  [EvaluationDimension.ERROR_TAXONOMY]: '错误分类',
  [EvaluationDimension.PLAN_QUALITY]: '规划质量',
  // v2 兼容
  [EvaluationDimension.TASK_COMPLETION]: '任务完成度',
  [EvaluationDimension.DIALOG_QUALITY]: '对话质量',
  [EvaluationDimension.PERFORMANCE]: '性能指标',
};

/**
 * 维度图标
 */
export const DIMENSION_ICONS: Record<EvaluationDimension, string> = {
  [EvaluationDimension.OUTCOME_VERIFICATION]: '🎯',
  [EvaluationDimension.CODE_QUALITY]: '💻',
  [EvaluationDimension.SECURITY]: '🔒',
  [EvaluationDimension.TOOL_EFFICIENCY]: '🔧',
  [EvaluationDimension.SELF_REPAIR]: '🔄',
  [EvaluationDimension.VERIFICATION_QUALITY]: '✅',
  [EvaluationDimension.FORBIDDEN_PATTERNS]: '🚫',
  [EvaluationDimension.ANSWER_CORRECTNESS]: '🎯',
  [EvaluationDimension.REASONING_QUALITY]: '🧠',
  [EvaluationDimension.COMMUNICATION_QUALITY]: '💬',
  [EvaluationDimension.INFORMATION_QUALITY]: '📚',
  [EvaluationDimension.OUTPUT_QUALITY]: '📝',
  [EvaluationDimension.REQUIREMENT_COMPLIANCE]: '✅',
  [EvaluationDimension.EFFICIENCY_METRICS]: '⚡',
  [EvaluationDimension.ERROR_TAXONOMY]: '📋',
  [EvaluationDimension.PLAN_QUALITY]: '📐',
  // v2 兼容
  [EvaluationDimension.TASK_COMPLETION]: '✅',
  [EvaluationDimension.DIALOG_QUALITY]: '💬',
  [EvaluationDimension.PERFORMANCE]: '⚡',
};

/**
 * 子指标
 */
export interface SubMetric {
  name: string;
  value: number;
  unit?: string;
}

/**
 * 评测指标
 */
export interface EvaluationMetric {
  dimension: EvaluationDimension;
  score: number; // 0-100
  weight: number;
  subMetrics?: SubMetric[];
  details?: { reason?: string; [key: string]: unknown };
  suggestions?: string[];
  informational?: boolean; // true = 不计入总分
}

/**
 * 评测等级
 */
export type EvaluationGrade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

/**
 * 等级颜色配置
 */
export const GRADE_COLORS: Record<EvaluationGrade, string> = {
  S: 'text-purple-400',
  A: 'text-green-400',
  B: 'text-blue-400',
  C: 'text-yellow-400',
  D: 'text-orange-400',
  F: 'text-red-400',
};

export const GRADE_BG_COLORS: Record<EvaluationGrade, string> = {
  S: 'bg-purple-500/20',
  A: 'bg-green-500/20',
  B: 'bg-blue-500/20',
  C: 'bg-yellow-500/20',
  D: 'bg-orange-500/20',
  F: 'bg-red-500/20',
};

/**
 * 统计信息
 */
export interface EvaluationStatistics {
  duration: number; // ms
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

/**
 * 基线对比结果
 */
export interface BaselineComparison {
  delta: number; // 与基线的分差
  baselineScore: number; // 基线分数
  regressions: string[]; // 退化维度
  improvements: string[]; // 改善维度
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
 * 评测结果
 */
export interface EvaluationResult {
  id: string;
  sessionId: string;
  timestamp: number;
  overallScore: number; // 加权平均 0-100
  grade: EvaluationGrade;
  metrics: EvaluationMetric[];
  statistics: EvaluationStatistics;
  topSuggestions: string[];
  aiSummary?: string;
  transcriptMetrics?: TranscriptMetrics;
  baselineComparison?: BaselineComparison;
  // 版本化追溯 (Phase 2)
  snapshotId?: string;
  evalVersion?: string;       // 'v1' | 'legacy'
  rubricVersion?: string;
  judgeModel?: string;
  judgePromptHash?: string;
  trajectoryAnalysis?: {
    deviations: Array<{
      stepIndex: number;
      type: string;
      description: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      suggestedFix?: string;
    }>;
    efficiency: {
      totalSteps: number;
      effectiveSteps: number;
      redundantSteps: number;
      efficiency: number;
    };
    recoveryPatterns: Array<{
      errorStepIndex: number;
      recoveryStepIndex: number;
      attempts: number;
      strategy: string;
      successful: boolean;
    }>;
    outcome: 'success' | 'partial' | 'failure';
  };
}

// ============================================================================
// EvalSnapshot - 统一评测输入快照
// ============================================================================

/**
 * 快照工具调用记录
 */
export interface SnapshotToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  turnIndex: number;
}

/**
 * 快照文件变更记录
 */
export interface SnapshotFileDiff {
  filePath: string;
  action: 'create' | 'edit' | 'delete';
  oldText?: string;
  newText?: string;
}

/**
 * 快照验证动作记录
 */
export interface SnapshotVerification {
  type: 'bash_test' | 'typecheck' | 'manual_check' | 'read_verify';
  command?: string;
  success: boolean;
  output?: string;
  timestamp: number;
}

/**
 * EvalSnapshot — 统一评测输入数据结构
 * 所有评分基于同一份快照，解决"数据平面分裂"根因
 */
export interface EvalSnapshot {
  schema_version: 1;
  // 身份
  session_id: string;
  snapshot_id: string;
  created_at: number;
  // 任务
  task_text: string;
  task_type?: string;
  // 产出
  final_answer: string;
  tool_calls: SnapshotToolCall[];
  file_diffs: SnapshotFileDiff[];
  outcome_artifacts: string[];
  // 验证
  verification_actions: SnapshotVerification[];
  // 成本
  total_input_tokens: number;
  total_output_tokens: number;
  total_tool_calls: number;
  duration_ms: number;
  estimated_cost: number;
  // 环境
  code_context?: {
    stderr_output?: string;
    exit_codes?: number[];
  };
}

/**
 * 评测导出格式
 */
export type EvaluationExportFormat = 'json' | 'markdown';

/**
 * 分数转等级
 */
export function scoreToGrade(score: number): EvaluationGrade {
  if (score >= 95) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

// ============================================================================
// Re-export from evaluationFramework.ts for backward compatibility
// ============================================================================
export {
  type ScoringDimensionConfig,
  type EvalDimensionName,
  type FailureStage,
  type FailureFunnelResult,
  type VerifierType,
  type VerifierResult,
  type TestSetTier,
  type TestCaseSource,
  type DimensionScore,
  type ExperimentSummary,
  DEFAULT_SCORING_CONFIG,
} from './evaluationFramework';
