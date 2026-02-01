// ============================================================================
// Evaluation Types - 会话评测类型定义
// ============================================================================

/**
 * 评测维度
 */
export enum EvaluationDimension {
  TASK_COMPLETION = 'task_completion',
  TOOL_EFFICIENCY = 'tool_efficiency',
  DIALOG_QUALITY = 'dialog_quality',
  CODE_QUALITY = 'code_quality',
  PERFORMANCE = 'performance',
  SECURITY = 'security',
}

/**
 * 维度权重配置
 */
export const DIMENSION_WEIGHTS: Record<EvaluationDimension, number> = {
  [EvaluationDimension.TASK_COMPLETION]: 0.30,
  [EvaluationDimension.TOOL_EFFICIENCY]: 0.20,
  [EvaluationDimension.DIALOG_QUALITY]: 0.15,
  [EvaluationDimension.CODE_QUALITY]: 0.15,
  [EvaluationDimension.PERFORMANCE]: 0.10,
  [EvaluationDimension.SECURITY]: 0.10,
};

/**
 * 维度中文名称
 */
export const DIMENSION_NAMES: Record<EvaluationDimension, string> = {
  [EvaluationDimension.TASK_COMPLETION]: '任务完成度',
  [EvaluationDimension.TOOL_EFFICIENCY]: '工具效率',
  [EvaluationDimension.DIALOG_QUALITY]: '对话质量',
  [EvaluationDimension.CODE_QUALITY]: '代码质量',
  [EvaluationDimension.PERFORMANCE]: '性能指标',
  [EvaluationDimension.SECURITY]: '安全性',
};

/**
 * 维度图标
 */
export const DIMENSION_ICONS: Record<EvaluationDimension, string> = {
  [EvaluationDimension.TASK_COMPLETION]: '✅',
  [EvaluationDimension.TOOL_EFFICIENCY]: '🔧',
  [EvaluationDimension.DIALOG_QUALITY]: '💬',
  [EvaluationDimension.CODE_QUALITY]: '📝',
  [EvaluationDimension.PERFORMANCE]: '⚡',
  [EvaluationDimension.SECURITY]: '🔒',
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
  subMetrics: SubMetric[];
  suggestions?: string[];
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
