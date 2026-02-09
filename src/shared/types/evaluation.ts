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
  transcriptMetrics?: import('../../main/evaluation/types').TranscriptMetrics;
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
